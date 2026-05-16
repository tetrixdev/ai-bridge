/**
 * Verifies that the server-defined tool manifest is injected into the prompt
 * each provider adapter sends to its CLI:
 *   - present in the spawned prompt argument when tools are registered
 *   - absent when no tools are registered
 *
 * The adapters spawn real CLIs, so `node:child_process` `spawn` is mocked to
 * capture the argv without launching a process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Captured argv from the most recent spawn() call.
let lastSpawnArgs: string[] = [];

vi.mock('node:child_process', () => {
  return {
    spawn: (_cmd: string, args: string[]) => {
      lastSpawnArgs = args;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      // Close the streams and the process on the next tick so the adapter's
      // promise settles and the test completes.
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  };
});

import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import type { ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage, ToolDefinition } from '../../src/protocol/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Searches the web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The query' } },
      required: ['query'],
    },
  },
];

function makeRequest(overrides: Partial<AiRequestMessage> = {}): AiRequestMessage {
  return {
    type: 'ai_request',
    request_id: 'req-1',
    conversation_id: 'conv-1',
    provider: 'claude',
    message: 'Hello there',
    system_prompt: null,
    options: {},
    ...overrides,
  };
}

function makeContext(
  tools: ToolDefinition[],
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    request: makeRequest(),
    requestId: 'req-1',
    tools,
    toolScriptDir: tools.length > 0 ? '/tmp/fake-tools' : null,
    onToolCall: async () => ({}),
    signal: new AbortController().signal,
    cliSessionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  lastSpawnArgs = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('tool manifest injection — Claude', () => {
  it('appends the manifest to the prompt when tools are present', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.execute(makeContext(TOOLS), () => {});

    const prompt = lastSpawnArgs[lastSpawnArgs.length - 1];
    expect(prompt).toContain('Hello there');
    expect(prompt).toContain('# Available Tools');
    expect(prompt).toContain('## web_search');
  });

  it('does not append the manifest when no tools are present', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.execute(makeContext([]), () => {});

    const prompt = lastSpawnArgs[lastSpawnArgs.length - 1];
    expect(prompt).toBe('Hello there');
    expect(prompt).not.toContain('# Available Tools');
  });

  it('appends the manifest on resumed sessions too', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.execute(makeContext(TOOLS, { cliSessionId: 'sess-xyz' }), () => {});

    const prompt = lastSpawnArgs[lastSpawnArgs.length - 1];
    expect(prompt).toContain('# Available Tools');
  });
});

describe('tool manifest injection — Codex', () => {
  it('appends the manifest to the prompt when tools are present', async () => {
    const adapter = new CodexAdapter();
    await adapter.execute(makeContext(TOOLS), () => {});

    const prompt = lastSpawnArgs[lastSpawnArgs.length - 1];
    expect(prompt).toContain('Hello there');
    expect(prompt).toContain('# Available Tools');
    expect(prompt).toContain('## web_search');
  });

  it('does not append the manifest when no tools are present', async () => {
    const adapter = new CodexAdapter();
    await adapter.execute(makeContext([]), () => {});

    const prompt = lastSpawnArgs[lastSpawnArgs.length - 1];
    expect(prompt).toBe('Hello there');
    expect(prompt).not.toContain('# Available Tools');
  });
});

describe('tool manifest injection — Gemini', () => {
  it('appends the manifest to the prompt when tools are present', async () => {
    const adapter = new GeminiAdapter();
    await adapter.execute(makeContext(TOOLS), () => {});

    const promptIdx = lastSpawnArgs.indexOf('--prompt');
    const prompt = lastSpawnArgs[promptIdx + 1];
    expect(prompt).toContain('Hello there');
    expect(prompt).toContain('# Available Tools');
    expect(prompt).toContain('## web_search');
  });

  it('does not append the manifest when no tools are present', async () => {
    const adapter = new GeminiAdapter();
    await adapter.execute(makeContext([]), () => {});

    const promptIdx = lastSpawnArgs.indexOf('--prompt');
    const prompt = lastSpawnArgs[promptIdx + 1];
    expect(prompt).toBe('Hello there');
    expect(prompt).not.toContain('# Available Tools');
  });

  it('adds the --yolo approval-bypass flag when tools are present', async () => {
    const adapter = new GeminiAdapter();
    await adapter.execute(makeContext(TOOLS), () => {});

    expect(lastSpawnArgs).toContain('--yolo');
  });

  it('does not add --yolo when no tools are present', async () => {
    const adapter = new GeminiAdapter();
    await adapter.execute(makeContext([]), () => {});

    expect(lastSpawnArgs).not.toContain('--yolo');
  });
});
