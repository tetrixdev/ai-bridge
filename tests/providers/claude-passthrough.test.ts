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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  // Inline lines go through a temp FILE, not a `node -e` argument. A test that
  // feeds a realistically large payload (an image result is ~600KB of base64)
  // otherwise dies with spawn E2BIG, which looks like a bug in the code under
  // test rather than in the harness.
  let path: string;
  let scratch: string | null = null;
  if ('fixture' in source) {
    path = join(FIXTURES, source.fixture);
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'replay-'));
    path = join(scratch, 'stream.ndjson');
    // A string entry is already-serialised NDJSON. Needed for payloads the test
    // itself cannot stringify — a structure deep enough to overflow the stack
    // is exactly what one of these tests is about.
    writeFileSync(path, source.lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
  }

  class Replay extends ClaudeAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', path],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
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
  try {
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
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
  return events;
}

/** Concatenate the deltas of every block of one type, block by block. */
function textOfBlocks(events: AdapterStreamEvent[], blockType: string): string[] {
  const types = new Map<number, string>();
  const text = new Map<number, string>();
  for (const e of events) {
    const data = e.data as { block_index?: number; block_type?: string; content?: string };
    if (data.block_index === undefined) continue;
    if (e.event === 'block_start') types.set(data.block_index, data.block_type ?? '');
    if (e.event === 'block_delta') text.set(data.block_index, (text.get(data.block_index) ?? '') + (data.content ?? ''));
  }
  return [...types.entries()].filter(([, t]) => t === blockType).map(([i]) => text.get(i) ?? '');
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

  it('forwards a sub-agent\'s tool results too, paired to its calls', async () => {
    // A delegated turn runs its own tools. Those calls arrive as whole-message
    // assistant frames and their results on user frames, so both take a
    // different path from the main agent's — and every result must still find
    // the call it belongs to.
    const events = await replay({ fixture: 'claude-partial-subagent-turn.ndjson' });

    const calls = of(events, 'block_start')
      .filter((e) => (e.data as { block_type: string }).block_type === 'tool_call')
      .map((e) => (e.data as { tool_name: string; tool_call_id: string }));
    const resultIds = of(events, 'tool_result').map((e) => (e.data as { tool_call_id: string }).tool_call_id);

    // The main agent delegating, plus the sub-agent's own work.
    expect(calls.map((c) => c.tool_name)).toEqual(['Agent', 'Bash', 'Read']);
    expect(resultIds).toHaveLength(3);
    expect(resultIds.every((id) => calls.some((c) => c.tool_call_id === id))).toBe(true);

    // Set membership alone is order-agnostic and passes even when every result
    // precedes its own call. Each result must arrive AFTER the block that
    // announced it, or a consumer pairing as events arrive sees orphans.
    const order = events.map((e) => e.event === 'block_start'
      ? `call:${(e.data as { tool_call_id?: string }).tool_call_id}`
      : e.event === 'tool_result' ? `result:${(e.data as { tool_call_id: string }).tool_call_id}` : null);
    for (const id of resultIds) {
      expect(order.indexOf(`call:${id}`), `result for ${id} arrived before its call`)
        .toBeLessThan(order.indexOf(`result:${id}`));
    }
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

describe('ordering against the block lifecycle', () => {
  it('never lands a result inside an open block', async () => {
    // A backgrounded sub-agent reports results while the main agent is still
    // writing. Emitting directly spliced tool output into the middle of the
    // answer and delivered results before the block_start of the call they
    // belong to — measured on a real turn, 5 of 6 out of order.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part one ' } } },
        {
          type: 'user', parent_tool_use_id: 'toolu_bg',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg_1', content: 'sub-agent output' }] },
        },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part two' } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    let open: number | null = null;
    for (const e of events) {
      const index = (e.data as { block_index?: number }).block_index;
      if (e.event === 'block_start') open = index ?? null;
      if (e.event === 'block_stop') open = null;
      if (e.event === 'tool_result') {
        expect(open, 'a tool_result landed inside an open block').toBeNull();
      }
    }

    // Held back, not dropped — and the answer is not broken up by it.
    expect(of(events, 'tool_result')).toHaveLength(1);
    expect(textOfBlocks(events, 'text')).toEqual(['part one part two']);
  });
});

describe('results that are not text', () => {
  it('reports an image by kind and size instead of shipping its base64', async () => {
    // A single screenshot is ~600,000 characters of base64. Forwarding that as
    // "what the tool returned" is unreadable, and two of them exceed the
    // server's 1MB WebSocket cap — which fails as a dropped message rather
    // than as an error anyone can act on.
    const data = 'A'.repeat(400_000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const result = (of(events, 'tool_result')[0]!.data as { result: string }).result;
    expect(result).toMatch(/^\[image: image\/png, \d+ KB\]$/);
    expect(result).not.toContain('AAAA');
    expect(result.length).toBeLessThan(100);
  });

  it('survives a structure too deep to serialise', async () => {
    // JSON.parse is iterative and accepts essentially unbounded nesting;
    // JSON.stringify is recursive and throws around 5,000 levels. So a line the
    // adapter has already accepted can blow up while being described — inside
    // the readline listener, where an uncaught throw takes down the daemon and
    // every concurrent turn.
    const deep = '['.repeat(6000) + '1' + ']'.repeat(6000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        // Built as raw text: JSON.stringify would throw here in the test
        // itself, which is the very asymmetry that makes this reachable.
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[${deep}]}]}}`,
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(of(events, 'tool_result')).toHaveLength(1);
    expect((of(events, 'tool_result')[0]!.data as { result: string }).result).toContain('could not be serialised');
    expect(events.at(-1)!.event).toBe('done');
  });

  it('forwards a large READABLE part whole, rather than describing it away', async () => {
    // An MCP embedded resource carries plain text. An earlier cap keyed on
    // "non-text part over 4KB" turned that into `[resource: 5 KB]` — throwing
    // away exactly the structured output a server most wants, and regressing
    // against forwarding it verbatim.
    const body = 'r'.repeat(50_000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result', tool_use_id: 't1',
              content: [{ type: 'resource', resource: { mimeType: 'text/plain', body } }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const result = (of(events, 'tool_result')[0]!.data as { result: string }).result;
    expect(result).toContain(body);
    expect(result).not.toContain('[resource:');
  });

  it('bounds an enormous result, and says it did', async () => {
    // A `cat` of a large file is likelier than a screenshot, and an oversized
    // frame fails as a DROPPED WebSocket message — the server gets nothing and
    // has no error to act on. A marked truncation is strictly better.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'z'.repeat(900_000) }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const result = (of(events, 'tool_result')[0]!.data as { result: string }).result;
    expect(result.length).toBeLessThan(600_000);
    expect(result).toContain('truncated by the bridge');
    expect(result).toContain('900000 characters');
  });

  it('says so when an image part is malformed, rather than claiming 0 KB', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result', tool_use_id: 't1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    // "0 KB" is indistinguishable from a genuinely tiny image.
    expect((of(events, 'tool_result')[0]!.data as { result: string }).result)
      .toBe('[image: image/png, size unknown]');
  });

  it('describes audio the same way as an image', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result', tool_use_id: 't1',
              content: [{ type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'A'.repeat(8000) } }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect((of(events, 'tool_result')[0]!.data as { result: string }).result)
      .toMatch(/^\[audio: audio\/wav, \d+ KB\]$/);
  });

  it('keeps a small structured part inline', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'data', rows: 3 }] }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect((of(events, 'tool_result')[0]!.data as { result: string }).result).toBe('{"type":"data","rows":3}');
  });

  it('does not render a null part as the word "null"', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [null, { type: 'text', text: 'real' }] }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect((of(events, 'tool_result')[0]!.data as { result: string }).result).toBe('real');
  });

  it('survives a null entry in the content array without killing the process', async () => {
    // This loop runs inside the readline listener, where a throw becomes an
    // uncaughtException and takes down the daemon and every concurrent turn.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'user', message: { content: [null, { type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(of(events, 'tool_result')).toHaveLength(1);
    expect(events.at(-1)!.event).toBe('done');
  });
});

describe('tool call arguments', () => {
  /** What the whole stream frame costs once encoded, as bridge.ts sends it. */
  function frameBytes(event: AdapterStreamEvent): number {
    return Buffer.byteLength(JSON.stringify({
      type: 'stream', request_id: 'req_abc123', event: event.event, data: event.data,
    }), 'utf8');
  }

  it('are bounded, not only results', async () => {
    // A sub-agent's Write call carries a whole file as its ARGUMENTS. Bounding
    // only results left this frame oversized — and an oversized frame is
    // answered with a CLOSE_TOO_BIG that tears down the connection, taking
    // every other in-flight request on the bridge with it.
    const body = 'x'.repeat(1_500_000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'assistant', parent_tool_use_id: 'toolu_bg',
          message: {
            id: 'm1',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/tmp/a', content: body } }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const delta = of(events, 'block_delta')[0]!;
    const content = (delta.data as { content: string }).content;

    expect(frameBytes(delta)).toBeLessThan(1024 * 1024);

    // Still valid JSON, and every key survives. Truncating the encoded TEXT
    // instead makes it stop parsing, and a consumer then records "arguments
    // could not be parsed" and loses all of them — including `file_path`,
    // twenty bytes and the most useful field there is for working out what
    // happened, thrown away because `content` was large.
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed['file_path']).toBe('/tmp/a');
    expect(parsed['content']).toHaveProperty('__truncated__');
    expect((parsed['content'] as { __truncated__: { bytes: number } }).__truncated__.bytes)
      .toBeGreaterThan(1_000_000);
  });

  it('leaves ordinary arguments untouched', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect((of(events, 'block_delta')[0]!.data as { content: string }).content)
      .toBe(JSON.stringify({ file_path: '/a' }));
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
