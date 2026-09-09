/**
 * What the Claude adapter forwards to the server, beyond the answer text.
 *
 * The bridge used to keep a good deal of what the CLI told it: tool results
 * were dropped entirely (while the Codex and Gemini adapters forwarded theirs),
 * usage was cut down to two of the four token counts the CLI reports, and the
 * model that actually ran, the cost, and the CLI's own rate-limit status never
 * left the machine. A server could see that a tool ran and never what it
 * returned.
 *
 * The fixture is a whole turn captured from Claude Code 2.1.261 running two
 * real tools, so these assert against what the CLI emits rather than what a
 * test author imagined it emits.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Replay NDJSON — a fixture file, or lines given inline — through the adapter. */
async function replay(source: { fixture: string } | { lines: unknown[] }): Promise<AdapterStreamEvent[]> {
  const script = 'fixture' in source
    ? 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))'
    : `process.stdout.write(${JSON.stringify(source.lines.map((l) => JSON.stringify(l)).join('\n') + '\n')})`;
  const args = 'fixture' in source ? [script, join(FIXTURES, source.fixture)] : [script];

  class Replay extends ClaudeAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(process.execPath, ['-e', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) as
        ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_pass',
    conversation_id: 'c',
    provider: 'claude',
    message: 'go',
    system_prompt: null,
    options: {},
    cli_session_id: null,
  };

  const events: AdapterStreamEvent[] = [];
  await new Replay().execute({
    request,
    requestId: request.request_id,
    tools: [],
    mcp: null,
    cliIsolation: 'native',
    workingDir: process.cwd(),
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    cliSessionId: null,
    attachmentDir: null,
  }, (e) => events.push(e));
  return events;
}

const of = (events: AdapterStreamEvent[], name: string) => events.filter((e) => e.event === name);

describe('tool results', () => {
  it('forwards what each tool returned', async () => {
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    const results = of(events, 'tool_result').map((e) => e.data as { result: string });

    expect(results).toHaveLength(2);
    // Verbatim from the run: `echo hello`, then the file the model read.
    expect(results[0]!.result).toContain('hello');
    expect(results[1]!.result).toContain('TN-7781');
  });

  it('pairs each result to the tool call it belongs to', async () => {
    // The whole point of forwarding them: a consumer has to be able to say
    // WHICH call produced which output. tool_use_id is the id already carried
    // on the tool_call block.
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });

    const callIds = of(events, 'block_start')
      .filter((e) => (e.data as { block_type: string }).block_type === 'tool_call')
      .map((e) => (e.data as { tool_call_id: string }).tool_call_id);
    const resultIds = of(events, 'tool_result').map((e) => (e.data as { tool_call_id: string }).tool_call_id);

    expect(callIds).toHaveLength(2);
    expect(resultIds).toEqual(callIds);
  });

  it('names the tools, so a run of them can be counted rather than lumped', async () => {
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    const names = of(events, 'block_start')
      .map((e) => (e.data as { tool_name?: string }).tool_name)
      .filter((n): n is string => n !== undefined);

    // Verbatim, not prettified — the server does its own display formatting.
    expect(names).toEqual(['Bash', 'Read']);
  });

  it('reports failure structurally rather than only in the text', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(of(events, 'tool_result')[0]!.data).toMatchObject({
      tool_call_id: 'toolu_1',
      result: 'boom',
      is_error: true,
    });
  });

  it('omits is_error when the provider did not say', async () => {
    // Absent must mean "not reported", never "succeeded".
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });
    expect(of(events, 'tool_result')[0]!.data).not.toHaveProperty('is_error');
  });

  it('flattens a structured result instead of stringifying an object', async () => {
    // Claude sends content either as a string or as content blocks. String(…)
    // on the array form yields "[object Object]", which is worse than dropping
    // it — the server would display something that looks like output.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const data = of(events, 'tool_result')[0]!.data as { result: string };
    expect(data.result).toBe('first second');
    expect(data.result).not.toContain('[object Object]');
  });

  it('ignores a user frame that carries no tool result', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'user', message: { content: [{ type: 'text', text: 'just prose' }] } },
        { type: 'user', message: { content: 'not even an array' } },
        { type: 'user' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });
    expect(of(events, 'tool_result')).toHaveLength(0);
    expect(events.at(-1)!.event).toBe('done');
  });
});

describe('what the turn cost and how it ran', () => {
  it('reports the cache tokens, which dominate a resumed conversation', async () => {
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    const usage = (of(events, 'done')[0]!.data as { usage: Record<string, number | null> }).usage;

    // In this real turn the cache read is four orders of magnitude larger than
    // the input count. A server shown only input/output understates it wildly.
    expect(usage['cache_read_input_tokens']).toBeGreaterThan(1000);
    expect(usage['cache_creation_input_tokens']).toBeGreaterThan(0);
    expect(usage['input_tokens']).not.toBeNull();
    expect(usage['output_tokens']).not.toBeNull();
  });

  it('says which model actually ran and which CLI ran it', async () => {
    // The server asks for an alias; only this says what it resolved to.
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    expect(of(events, 'done')[0]!.data).toMatchObject({
      model: 'claude-sonnet-5',
      provider_version: '2.1.261',
    });
  });

  it('reports cost, duration, turn count and stop reason', async () => {
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    const done = of(events, 'done')[0]!.data as Record<string, unknown>;

    expect(done['cost_usd']).toBeGreaterThan(0);
    expect(done['duration_ms']).toBeGreaterThan(0);
    expect(done['num_turns']).toBeGreaterThan(0);
    expect(done['stop_reason']).toBe('end_turn');
  });

  it('carries the permission denials the CLI recorded', async () => {
    // In `isolated` this is the record of what the posture actually stopped.
    // An empty answer with denials reads very differently from one without.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'result', subtype: 'success', session_id: 's', usage: {},
          permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
        },
      ],
    });

    const done = of(events, 'done')[0]!.data as { permission_denials?: unknown[] };
    expect(done.permission_denials).toHaveLength(1);
  });

  it('reports a missing field as null rather than inventing a zero', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'result', subtype: 'success', session_id: 's' },
      ],
    });
    const done = of(events, 'done')[0]!.data as Record<string, unknown>;

    expect(done['cost_usd']).toBeNull();
    expect(done['model']).toBeNull();
    expect(done).not.toHaveProperty('permission_denials');
  });
});

describe('rate limit status', () => {
  it('forwards it instead of only logging it locally', async () => {
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    const limits = of(events, 'rate_limit');

    expect(limits).toHaveLength(1);
    expect(limits[0]!.data).toMatchObject({ provider: 'claude' });
    expect((limits[0]!.data as { info: Record<string, unknown> }).info['status']).toBe('allowed');
  });

  it('does not end the turn', async () => {
    // It is informational; treating it as terminal would abort mid-stream.
    const events = await replay({ fixture: 'claude-tool-results-turn.ndjson' });
    expect(of(events, 'error')).toHaveLength(0);
    expect(events.at(-1)!.event).toBe('done');
  });

  it('is dropped once the turn has ended', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'late' }] } },
      ],
    });
    expect(events.map((e) => e.event)).toEqual(['done']);
  });
});
