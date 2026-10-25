/**
 * How the Claude adapter hands over the main system prompt and the bridge
 * addendum (decision 0014): as 0600 files on a CLI that takes them, removed
 * after the turn, never on argv; `--system-prompt-snapshot off` on a CLI that
 * would otherwise reuse the first turn's prompt; the argv flags on an older or
 * unknown CLI. claude-system-prompt.live.test.ts runs the real CLI.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import {
  APPEND_SYSTEM_PROMPT_FILE_FLAG,
  SNAPSHOT_FLAG,
  SYSTEM_PROMPT_FILE_FLAG,
} from '../../src/providers/claude-system-prompt.js';
import { noteDetectedClaudeVersion } from '../../src/providers/subagent-prompt.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

afterEach(() => {
  noteDetectedClaudeVersion(null);
});

interface FileSeen { path: string; content: string; mode: number }

interface Launch {
  args: string[];
  /** Per file flag: the file as it was at spawn time. */
  files: Record<string, FileSeen>;
}

async function launch(opts: { systemPrompt: string | null; addendum: string | null; resume?: boolean }): Promise<Launch> {
  const recorded: Launch = { args: [], files: {} };

  class Probe extends ClaudeAdapter {
    protected override spawnCli(
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded.args = args;
      for (const flag of [SYSTEM_PROMPT_FILE_FLAG, APPEND_SYSTEM_PROMPT_FILE_FLAG]) {
        const i = args.indexOf(flag);
        if (i < 0) continue;
        const path = args[i + 1]!;
        recorded.files[flag] = { path, content: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
      }
      return spawn(process.execPath, ['-e', ''], {
        env,
        cwd,
        stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request = {
    type: 'ai_request',
    request_id: 'req_system_prompt',
    conversation_id: 'conv_1',
    provider: 'claude',
    message: 'do the thing',
    system_prompt: opts.systemPrompt,
    options: {},
    cli_session_id: opts.resume ? 'sess_1' : null,
  } as AiRequestMessage;

  const context: ExecutionContext = {
    request,
    requestId: request.request_id,
    tools: [],
    mcp: null,
    cliIsolation: 'native',
    workingDir: process.cwd(),
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    silenceTimeoutSeconds: 0,
    cliSessionId: opts.resume ? 'sess_1' : null,
    attachmentDir: null,
    bridgeEnv: {},
    bridgeAddendum: opts.addendum,
  };

  await new Probe().execute(context, (_e: AdapterStreamEvent) => undefined);
  return recorded;
}

function promptDirs(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('ai-bridge-system-claude-'));
}

const PROMPT = 'You are helpful. SERVER-PROMPT-MARKER\nSecond line.';
const ADDENDUM = 'LIFECYCLE-ADDENDUM-MARKER';

describe('claude system prompt by file', () => {
  it('passes both as 0600 files holding exactly the text, removed after the turn', async () => {
    noteDetectedClaudeVersion('2.1.310');
    const { args, files } = await launch({ systemPrompt: PROMPT, addendum: ADDENDUM });
    const main = files[SYSTEM_PROMPT_FILE_FLAG];
    const append = files[APPEND_SYSTEM_PROMPT_FILE_FLAG];
    expect(main?.content).toBe(PROMPT);
    expect(append?.content).toBe(ADDENDUM);
    expect(main?.mode).toBe(0o600);
    expect(append?.mode).toBe(0o600);
    expect(existsSync(main!.path)).toBe(false);
    expect(existsSync(append!.path)).toBe(false);
    // Never on argv, so no size limit applies.
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
    expect(args.join(' ')).not.toContain('MARKER');
  });

  it('passes the files on a resumed turn too', async () => {
    noteDetectedClaudeVersion('2.1.310');
    const { args, files } = await launch({ systemPrompt: PROMPT, addendum: ADDENDUM, resume: true });
    expect(args).toContain('--resume');
    expect(files[SYSTEM_PROMPT_FILE_FLAG]?.content).toBe(PROMPT);
    expect(files[APPEND_SYSTEM_PROMPT_FILE_FLAG]?.content).toBe(ADDENDUM);
  });

  it('passes only the half that exists', async () => {
    noteDetectedClaudeVersion('2.1.310');
    const serverOnly = await launch({ systemPrompt: PROMPT, addendum: null });
    expect(serverOnly.args).toContain(SYSTEM_PROMPT_FILE_FLAG);
    expect(serverOnly.args).not.toContain(APPEND_SYSTEM_PROMPT_FILE_FLAG);
    const addendumOnly = await launch({ systemPrompt: null, addendum: ADDENDUM });
    expect(addendumOnly.args).not.toContain(SYSTEM_PROMPT_FILE_FLAG);
    expect(addendumOnly.args).toContain(APPEND_SYSTEM_PROMPT_FILE_FLAG);
  });

  it('writes no file when there is nothing to say', async () => {
    noteDetectedClaudeVersion('2.1.310');
    const before = promptDirs().length;
    const { args } = await launch({ systemPrompt: null, addendum: null });
    expect(args).not.toContain(SYSTEM_PROMPT_FILE_FLAG);
    expect(args).not.toContain(APPEND_SYSTEM_PROMPT_FILE_FLAG);
    expect(promptDirs().length).toBe(before);
  });

  it('works on exactly the first verified version', async () => {
    noteDetectedClaudeVersion('2.1.200');
    expect((await launch({ systemPrompt: PROMPT, addendum: ADDENDUM })).args).toContain(SYSTEM_PROMPT_FILE_FLAG);
  });

  it('falls back to the argv flags on an older or unknown CLI', async () => {
    for (const v of ['2.1.199', null]) {
      noteDetectedClaudeVersion(v);
      const { args } = await launch({ systemPrompt: PROMPT, addendum: ADDENDUM });
      expect(args).not.toContain(SYSTEM_PROMPT_FILE_FLAG);
      expect(args[args.indexOf('--system-prompt') + 1]).toBe(PROMPT);
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(ADDENDUM);
    }
  });
});

describe(`claude ${SNAPSHOT_FLAG}`, () => {
  it('is off on 2.1.257 and later, fresh turn and resume alike, prompt or none', async () => {
    for (const v of ['2.1.257', '2.1.310']) {
      noteDetectedClaudeVersion(v);
      for (const opts of [
        { systemPrompt: PROMPT, addendum: ADDENDUM },
        { systemPrompt: PROMPT, addendum: ADDENDUM, resume: true },
        { systemPrompt: null, addendum: null, resume: true },
      ]) {
        const { args } = await launch(opts);
        expect(args[args.indexOf(SNAPSHOT_FLAG) + 1]).toBe('off');
      }
    }
  });

  it('is not passed to a CLI that predates it, where it would be fatal', async () => {
    for (const v of ['2.1.252', '2.1.200', null]) {
      noteDetectedClaudeVersion(v);
      expect((await launch({ systemPrompt: PROMPT, addendum: ADDENDUM })).args).not.toContain(SNAPSHOT_FLAG);
    }
  });
});
