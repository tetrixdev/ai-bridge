/**
 * `ai_request.agents` — server-defined subagents.
 *
 * Claude gets them as `--agents <file>` holding exactly the validated JSON;
 * the file is gone once the turn ends. Absent → no flag. Invalid entries are
 * dropped, never the turn. Codex and Gemini ignore the field.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { resolveAgents } from '../../src/providers/agents.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

let workingDir: string;

beforeAll(() => {
  workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'agents-')));
});

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

interface Launch {
  args: string[];
  /** Path and contents of the `--agents` file, read at spawn time. */
  agentsPath: string | null;
  agentsFile: string | null;
  agentsMode: number | null;
}

async function launch(
  AdapterClass: new () => ClaudeAdapter | CodexAdapter | GeminiAdapter,
  agents: unknown,
): Promise<Launch> {
  const recorded: Launch = { args: [], agentsPath: null, agentsFile: null, agentsMode: null };

  class Probe extends (AdapterClass as new () => ClaudeAdapter) {
    protected override spawnCli(
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded.args = args;
      const i = args.indexOf('--agents');
      if (i >= 0) {
        recorded.agentsPath = args[i + 1]!;
        recorded.agentsFile = readFileSync(recorded.agentsPath, 'utf8');
        recorded.agentsMode = statSync(recorded.agentsPath).mode & 0o777;
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
    request_id: 'req_agents',
    conversation_id: 'conv_1',
    provider: 'x',
    message: 'do the thing',
    system_prompt: 'be useful',
    options: {},
    cli_session_id: null,
    ...(agents !== undefined ? { agents } : {}),
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

const VALID = {
  researcher: {
    description: 'Looks things up in memory before answering',
    prompt: 'You are a careful researcher.',
    tools: ['mcp__bridge__memory_query', 'Read'],
    model: 'haiku',
  },
  'note-taker': {
    description: 'Writes short notes',
    prompt: 'Write terse notes.',
  },
};

describe('claude --agents', () => {
  it('passes a file holding exactly the agents JSON, and removes it after the turn', async () => {
    const { args, agentsPath, agentsFile, agentsMode } = await launch(ClaudeAdapter, VALID);
    expect(args).toContain('--agents');
    expect(agentsPath).not.toBeNull();
    expect(JSON.parse(agentsFile!)).toEqual(VALID);
    expect(agentsMode).toBe(0o600);
    expect(existsSync(agentsPath!)).toBe(false);
  });

  it('adds no flag when the field is absent or null', async () => {
    expect((await launch(ClaudeAdapter, undefined)).args).not.toContain('--agents');
    expect((await launch(ClaudeAdapter, null)).args).not.toContain('--agents');
  });

  it('drops invalid entries and passes the rest', async () => {
    const { agentsFile } = await launch(ClaudeAdapter, {
      ...VALID,
      'no-prompt': { description: 'x' },
      'bad-tools': { description: 'x', prompt: 'y', tools: 'Bash' },
      'bad name!': { description: 'x', prompt: 'y' },
    });
    expect(JSON.parse(agentsFile!)).toEqual(VALID);
  });

  it('adds no flag when every entry is invalid', async () => {
    const { args } = await launch(ClaudeAdapter, { a: { description: '', prompt: 'y' } });
    expect(args).not.toContain('--agents');
  });

  it('adds no flag when the field is not an object', async () => {
    expect((await launch(ClaudeAdapter, ['x'])).args).not.toContain('--agents');
    expect((await launch(ClaudeAdapter, 'x')).args).not.toContain('--agents');
  });
});

describe('non-claude providers ignore agents', () => {
  it('codex does not pass them on', async () => {
    const { args } = await launch(CodexAdapter, VALID);
    expect(args.join(' ')).not.toContain('agents');
    expect(args.join(' ')).not.toContain('careful researcher');
  });
  it('gemini does not pass them on', async () => {
    const { args } = await launch(GeminiAdapter, VALID);
    expect(args.join(' ')).not.toContain('careful researcher');
  });
});

describe('resolveAgents', () => {
  it('returns null and no drops for absent input', () => {
    expect(resolveAgents(undefined)).toEqual({ agents: null, dropped: [] });
    expect(resolveAgents(null)).toEqual({ agents: null, dropped: [] });
  });

  it('names each dropped entry with its reason, and logs it', () => {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const r = resolveAgents({
      ok: { description: 'd', prompt: 'p' },
      nodesc: { prompt: 'p' },
      notobj: 'x',
      badmodel: { description: 'd', prompt: 'p', model: 3 },
      badtools: { description: 'd', prompt: 'p', tools: ['Read', ''] },
    }, log as never);
    expect(Object.keys(r.agents!)).toEqual(['ok']);
    expect(r.dropped).toHaveLength(4);
    expect(r.dropped.find((d) => d.startsWith('nodesc:'))).toMatch(/description/);
    expect(r.dropped.find((d) => d.startsWith('badtools:'))).toMatch(/tools/);
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('strips unknown fields rather than forwarding them', () => {
    const r = resolveAgents({ a: { description: 'd', prompt: 'p', permissionMode: 'bypassPermissions' } });
    expect(r.agents).toEqual({ a: { description: 'd', prompt: 'p' } });
  });

  it('rejects a non-object field as a whole', () => {
    expect(resolveAgents([{ description: 'd', prompt: 'p' }]).agents).toBeNull();
    expect(resolveAgents('x').dropped).toHaveLength(1);
  });
});
