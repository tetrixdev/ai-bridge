/**
 * The Gemini adapter had no tests at all.
 *
 * It received three changes this release — a type guard that stops a malformed
 * `output` taking the whole daemon down, the model it reports being forwarded
 * instead of logged and forgotten, and counts being validated rather than
 * asserted — and nothing covered any of them. gemini-cli is not installed here,
 * so this replays NDJSON through the real adapter the way the Codex tests do.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';

/** Replay gemini NDJSON through the real adapter. */
async function replay(lines: unknown[]): Promise<AdapterStreamEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-'));
  const path = join(dir, 'stream.ndjson');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  class Replay extends GeminiAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', path],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const events: AdapterStreamEvent[] = [];
  try {
    await new Replay().execute({
      request: {
        type: 'ai_request', request_id: 'req_gemini', conversation_id: 'c', provider: 'gemini',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_gemini',
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, (e) => events.push(e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return events;
}

const of = (events: AdapterStreamEvent[], name: string) => events.filter((e) => e.event === name);

describe('a tool result whose output is not a string', () => {
  it('does not take the process down', async () => {
    // `parsed['output'] as string` is a promise to the compiler, not a check.
    // An array reached the surrogate scrubber and threw `charCodeAt is not a
    // function` inside the readline listener, where nothing catches it — there
    // is no uncaughtException handler anywhere in src — so the daemon died with
    // every in-flight request on it.
    const events = await replay([
      { type: 'init', session_id: 's1', model: 'gemini-2.5-pro' },
      { type: 'tool_use', name: 'read_file', id: 't1', parameters: { path: '/a' } },
      { type: 'tool_result', id: 't1', output: [{ text: 'line one' }], status: 'success' },
      { type: 'result', stats: { input_tokens: 10, output_tokens: 3 } },
    ]);

    const result = of(events, 'tool_result')[0];

    expect(result).toBeDefined();
    expect(typeof (result!.data as { result: unknown }).result).toBe('string');
    // The turn still ended properly rather than dying mid-stream.
    expect(of(events, 'done')).toHaveLength(1);
  });

  it('passes a string output through unchanged', async () => {
    const events = await replay([
      { type: 'init', session_id: 's1', model: 'gemini-2.5-pro' },
      { type: 'tool_use', name: 'read_file', id: 't1', parameters: { path: '/a' } },
      { type: 'tool_result', id: 't1', output: 'plain text', status: 'success' },
      { type: 'result', stats: {} },
    ]);

    expect((of(events, 'tool_result')[0]!.data as { result: string }).result).toBe('plain text');
  });
});

describe('what Gemini reported about the turn', () => {
  it('forwards the model it named on the init frame', async () => {
    // Read off init, written to a debug log, and then thrown away — so `done`
    // said nothing and the server read that as "the CLI did not report one".
    const events = await replay([
      { type: 'init', session_id: 's1', model: 'gemini-2.5-pro' },
      { type: 'result', stats: { input_tokens: 7, output_tokens: 2 } },
    ]);

    const done = of(events, 'done')[0]!.data as Record<string, unknown>;

    expect(done['model']).toBe('gemini-2.5-pro');
    expect((done['usage'] as Record<string, unknown>)['input_tokens']).toBe(7);
  });

  it('claims no model when the CLI did not name one', async () => {
    const events = await replay([
      { type: 'init', session_id: 's1' },
      { type: 'result', stats: {} },
    ]);

    expect(of(events, 'done')[0]!.data as Record<string, unknown>).not.toHaveProperty('model');
  });

  it('does not forward a count that is not a number', async () => {
    // `as number` would have handed a string straight through, and a consumer
    // adding it up gets string concatenation rather than a total.
    const events = await replay([
      { type: 'init', session_id: 's1' },
      { type: 'result', stats: { input_tokens: '100', output_tokens: 5 } },
    ]);

    const usage = (of(events, 'done')[0]!.data as unknown as { usage: Record<string, unknown> }).usage;

    expect(usage['input_tokens']).toBeNull();
    expect(usage['output_tokens']).toBe(5);
  });
});
