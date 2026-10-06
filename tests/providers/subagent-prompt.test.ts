/**
 * `ai_request.subagent_prompt` — text appended to every subagent's system
 * prompt.
 *
 * Claude gets it as `--append-subagent-system-prompt-file <file>` holding
 * exactly the text; the file is 0600 and gone once the turn ends. Absent,
 * null or empty → no flag. A CLI older than 2.1.261 (or of unknown version)
 * → no flag, with a warning. Codex and Gemini ignore the field.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import {
  SUBAGENT_PROMPT_FLAG,
  isVersionAtLeast,
  logIgnoredSubagentPrompt,
  noteDetectedClaudeVersion,
  prepareClaudeSubagentPrompt,
  resolveSubagentPrompt,
} from '../../src/providers/subagent-prompt.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

const TEXT = 'Always begin your reply with BANANA.\nSecond line.';

let workingDir: string;

beforeAll(() => {
  workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-prompt-')));
});

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

afterEach(() => {
  noteDetectedClaudeVersion(null);
});

interface Launch {
  args: string[];
  stdin: string | undefined;
  /** Path, contents and mode of the prompt file, read at spawn time. */
  path: string | null;
  content: string | null;
  mode: number | null;
}

async function launch(
  AdapterClass: new () => ClaudeAdapter | CodexAdapter | GeminiAdapter,
  subagentPrompt: unknown,
): Promise<Launch> {
  const recorded: Launch = { args: [], stdin: undefined, path: null, content: null, mode: null };

  class Probe extends (AdapterClass as new () => ClaudeAdapter) {
    protected override spawnCli(
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded.args = args;
      recorded.stdin = stdinInput;
      const i = args.indexOf(SUBAGENT_PROMPT_FLAG);
      if (i >= 0) {
        recorded.path = args[i + 1]!;
        recorded.content = readFileSync(recorded.path, 'utf8');
        recorded.mode = statSync(recorded.path).mode & 0o777;
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
    request_id: 'req_subagent_prompt',
    conversation_id: 'conv_1',
    provider: 'x',
    message: 'do the thing',
    system_prompt: 'be useful',
    options: {},
    cli_session_id: null,
    ...(subagentPrompt !== undefined ? { subagent_prompt: subagentPrompt } : {}),
  } as AiRequestMessage;

  const context: ExecutionContext = {
    request,
    requestId: request.request_id,
    tools: [],
    mcp: null,
    cliIsolation: 'workspace',
    workingDir,
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    silenceTimeoutSeconds: 0,
    cliSessionId: null,
    attachmentDir: null,
    bridgeEnv: {},
    bridgeAddendum: null,
  };

  await new Probe().execute(context, (_e: AdapterStreamEvent) => undefined);
  return recorded;
}

function promptDirs(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('ai-bridge-subagent-claude-'));
}

describe(`claude ${SUBAGENT_PROMPT_FLAG}`, () => {
  it('passes a 0600 file holding exactly the text, and removes it after the turn', async () => {
    noteDetectedClaudeVersion('2.1.283');
    const { args, path, content, mode } = await launch(ClaudeAdapter, TEXT);
    expect(args).toContain(SUBAGENT_PROMPT_FLAG);
    expect(path).not.toBeNull();
    expect(content).toBe(TEXT);
    expect(mode).toBe(0o600);
    expect(existsSync(path!)).toBe(false);
    // The text travels only in the file, never on argv.
    expect(args.join(' ')).not.toContain('BANANA');
  });

  it('works on exactly the first supporting version', async () => {
    noteDetectedClaudeVersion('2.1.261');
    expect((await launch(ClaudeAdapter, TEXT)).args).toContain(SUBAGENT_PROMPT_FLAG);
  });

  it('adds no flag when the field is absent, null, empty or blank', async () => {
    noteDetectedClaudeVersion('2.1.283');
    for (const v of [undefined, null, '', '   \n']) {
      expect((await launch(ClaudeAdapter, v)).args).not.toContain(SUBAGENT_PROMPT_FLAG);
    }
  });

  it('adds no flag when the field is not a string', async () => {
    noteDetectedClaudeVersion('2.1.283');
    expect((await launch(ClaudeAdapter, ['x'])).args).not.toContain(SUBAGENT_PROMPT_FLAG);
    expect((await launch(ClaudeAdapter, { text: 'x' })).args).not.toContain(SUBAGENT_PROMPT_FLAG);
  });

  it('skips the flag, and writes no file, on an older CLI', async () => {
    noteDetectedClaudeVersion('2.1.260');
    const before = promptDirs().length;
    const { args } = await launch(ClaudeAdapter, TEXT);
    expect(args).not.toContain(SUBAGENT_PROMPT_FLAG);
    expect(promptDirs().length).toBe(before);
  });

  it('skips the flag when the CLI version is unknown', async () => {
    noteDetectedClaudeVersion(null);
    expect((await launch(ClaudeAdapter, TEXT)).args).not.toContain(SUBAGENT_PROMPT_FLAG);
  });
});

describe('non-claude providers ignore subagent_prompt', () => {
  it('codex does not pass it on', async () => {
    noteDetectedClaudeVersion('2.1.283');
    const { args, stdin } = await launch(CodexAdapter, TEXT);
    expect(args.join(' ')).not.toContain('subagent');
    expect(args.join(' ')).not.toContain('BANANA');
    expect(stdin ?? '').not.toContain('BANANA');
  });

  it('gemini does not pass it on', async () => {
    noteDetectedClaudeVersion('2.1.283');
    const { args, stdin } = await launch(GeminiAdapter, TEXT);
    expect(args.join(' ')).not.toContain('BANANA');
    expect(stdin ?? '').not.toContain('BANANA');
  });

  it('logs the ignore at debug level only when there is something to ignore', () => {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    logIgnoredSubagentPrompt(undefined, 'codex', log as never);
    logIgnoredSubagentPrompt(null, 'codex', log as never);
    expect(log.debug).not.toHaveBeenCalled();
    logIgnoredSubagentPrompt(TEXT, 'codex', log as never);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('isVersionAtLeast compares numerically', () => {
    expect(isVersionAtLeast('2.1.261', '2.1.261')).toBe(true);
    expect(isVersionAtLeast('2.1.283', '2.1.261')).toBe(true);
    expect(isVersionAtLeast('2.2.0', '2.1.261')).toBe(true);
    expect(isVersionAtLeast('3.0.0', '2.1.261')).toBe(true);
    expect(isVersionAtLeast('2.1.99', '2.1.261')).toBe(false);
    expect(isVersionAtLeast('1.9.999', '2.1.261')).toBe(false);
    expect(isVersionAtLeast(null, '2.1.261')).toBe(false);
    expect(isVersionAtLeast('garbage', '2.1.261')).toBe(false);
  });

  it('resolveSubagentPrompt keeps the text verbatim and warns on a non-string', () => {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    expect(resolveSubagentPrompt('  keep  ', log as never)).toBe('  keep  ');
    expect(resolveSubagentPrompt(42, log as never)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('prepareClaudeSubagentPrompt warns with the version when it skips', () => {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    expect(prepareClaudeSubagentPrompt(TEXT, log as never, '2.1.200')).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/2\.1\.200.*2\.1\.261/);
  });

  it('release() is idempotent', () => {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const r = prepareClaudeSubagentPrompt(TEXT, log as never, '2.1.283')!;
    expect(readFileSync(r.file.path, 'utf8')).toBe(TEXT);
    r.file.release();
    r.file.release();
    expect(existsSync(r.file.path)).toBe(false);
  });
});
