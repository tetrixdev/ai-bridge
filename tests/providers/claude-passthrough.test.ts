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
import { MAX_RESULT_BYTES } from '../../src/providers/result-text.js';
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

  it('carries an enormous result WHOLE, in chunks', async () => {
    // A `cat` of a large file is likelier than a screenshot. This used to be
    // truncated at 256 KB with a marker; it now crosses in pieces and arrives
    // complete, which is the point of chunking.
    const body = 'z'.repeat(900_000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: body }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const chunks = of(events, 'tool_result').map((e) => e.data as Record<string, unknown>);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c['tool_call_id'] === 't1')).toBe(true);
    expect(chunks.map((c) => c['chunk_index'])).toEqual(chunks.map((_, i) => i));
    expect(chunks.slice(0, -1).every((c) => c['final'] === false)).toBe(true);
    expect(chunks[chunks.length - 1]!['final']).toBe(true);

    // Nothing lost and nothing added: reassembling gives back the original.
    expect(chunks.map((c) => String(c['result'])).join('')).toBe(body);

    // The number PROTOCOL.md states, not the frame guard's 900 KB backstop.
    // Asserting the looser one would pass a regression emitting 500 KB chunks,
    // which is out of contract even though the guard would let it through.
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk['result']), 'utf8'))
        .toBeLessThanOrEqual(MAX_RESULT_BYTES);
    }
  });

  it('leaves a result that fits in one frame exactly as it was', async () => {
    // The wire shape for an ordinary result must not change: a server that has
    // never heard of chunking sees no difference for anything it can already
    // receive.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'small' }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const chunks = of(events, 'tool_result');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.data).toEqual({ tool_call_id: 't1', result: 'small' });
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
    // `undefined` is in the value type because TokenUsage's cache members are
    // optional, and leaving it out made `not.toBeNull()` pass on a field that
    // was never forwarded at all — an assertion that reads as proof of the
    // feature while being blind to its absence.
    const usage = (of(events, 'done')[0]!.data as unknown as {
      usage: Record<string, number | null | undefined>;
    }).usage;

    // In this real turn the cache read is four orders of magnitude larger than
    // the input count. A server shown only input/output understates it wildly.
    expect(usage['cache_read_input_tokens']).toBeGreaterThan(1000);
    expect(usage['cache_creation_input_tokens']).toBeGreaterThan(0);
    expect(typeof usage['input_tokens']).toBe('number');
    expect(typeof usage['output_tokens']).toBe('number');
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

  it('bounds the permission denials so the terminal frame stays sendable', async () => {
    // A denial carries the refused call's whole input, so a denied large write
    // would otherwise make `done` itself oversized.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'result', subtype: 'success', session_id: 's', usage: {},
          permission_denials: [
            { tool_name: 'Write', tool_input: { content: 'x'.repeat(2_000_000) } },
            { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
          ],
        },
      ],
    });

    const done = of(events, 'done')[0]!;
    const bytes = Buffer.byteLength(JSON.stringify({ type: 'stream', request_id: 'r', event: 'done', data: done.data }), 'utf8');

    expect(bytes).toBeLessThan(900 * 1024);
    // What was refused is the useful part, and it survives even when the
    // refused arguments do not.
    const denials = (done.data as { permission_denials: unknown[] }).permission_denials;
    expect(denials.length).toBeGreaterThan(0);
    expect(JSON.stringify(denials)).toContain('omitted');
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

describe('the terminal frame, and the parts that are not text', () => {
  it('scrubs a lone surrogate out of a permission denial', async () => {
    // A denial carries the refused call's whole input — model-authored text,
    // which is exactly where a lone surrogate comes from — and it was the one
    // field on the TERMINAL frame passed through raw. The frame is small, so
    // the size guard never engages; JSON.stringify succeeds, so the encode
    // fallback never engages. PHP's json_decode then rejects the whole document
    // and the turn's only terminal is lost, leaving the request to time out.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'result', subtype: 'success', session_id: 's', usage: {},
          permission_denials: [{
            tool_name: 'Write', tool_use_id: 'tu_1',
            tool_input: { file_path: '/tmp/a', content: 'hi \ud83d' },
          }],
        },
      ],
    });

    const done = of(events, 'done')[0]!.data as Record<string, unknown>;
    const encoded = JSON.stringify(done);

    expect(/\\ud83d(?!\\ude)/i.test(encoded)).toBe(false);
    expect(() => JSON.parse(encoded)).not.toThrow();
    // Scrubbed, not dropped: the denial is still reported.
    expect(JSON.stringify(done['permission_denials'])).toContain('Write');
  });

  it('describes a document part instead of inlining its base64', async () => {
    // Keyed on the TYPE NAME, a `document` carrying a PDF in `source.data` fell
    // through to safeStringify and was inlined whole — measured at 1.2 million
    // characters. `boundResult` used to cap that at 256 KB; removing it in
    // favour of chunking raised the ceiling to 16 MB.
    const base64 = 'A'.repeat(1_200_000);
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result', tool_use_id: 't1',
              content: [{
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const results = of(events, 'tool_result').map((e) => (e.data as { result: string }).result);

    expect(results).toHaveLength(1);
    expect(results[0]!).not.toContain(base64.slice(0, 200));
    expect(results[0]!).toContain('application/pdf');
    expect(results[0]!).toMatch(/\d+ KB/);
  });

  it('still describes an image part', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result', tool_use_id: 't1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(40_000) } }],
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const result = (of(events, 'tool_result')[0]!.data as { result: string }).result;

    expect(result).toContain('image/png');
    expect(result).not.toContain('BBBBBBBBBB');
  });
});

describe('the counters a mis-key would hide', () => {
  /** A `result` frame with exactly these usage numbers. */
  const withUsage = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    lines: [
      { type: 'system', subtype: 'init', session_id: 's', model: 'claude-x' },
      { type: 'result', subtype: 'success', session_id: 's', usage, ...extra },
    ],
  });

  it('reads each cache counter from its OWN key', async () => {
    // The test protecting these asserted `cache_read > 1000` and
    // `cache_creation > 0`, which both hold when the two read the SAME source
    // key — so a swapped or mis-keyed cache counter passed. PROTOCOL.md calls
    // these "not a detail": distinct values are the only thing that can tell.
    const events = await replay(withUsage({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    }));

    const usage = (of(events, 'done')[0]!.data as unknown as {
      usage: Record<string, number | null | undefined>;
    }).usage;

    expect(usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    });
  });

  it('reads each duration from its OWN key', async () => {
    // `duration_api_ms` was asserted nowhere, so it could be filled from
    // `duration_ms` and nothing would notice.
    const events = await replay(withUsage({}, {
      duration_ms: 8000, duration_api_ms: 3000, num_turns: 2, total_cost_usd: 0.5,
    }));

    const done = of(events, 'done')[0]!.data as unknown as Record<string, unknown>;

    expect(done['duration_ms']).toBe(8000);
    expect(done['duration_api_ms']).toBe(3000);
    expect(done['num_turns']).toBe(2);
    expect(done['cost_usd']).toBe(0.5);
  });

  it('keeps what a FAILED turn cost', async () => {
    // A turn that fails still spent tokens and money, often more than one that
    // succeeds — and this reported `{}`, so the cost of exactly the turns worth
    // investigating was the cost thrown away.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's', model: 'claude-x' },
        {
          type: 'result', subtype: 'error_during_execution', session_id: 's', is_error: true,
          errors: ['it went wrong'],
          usage: { input_tokens: 100, output_tokens: 5 },
          total_cost_usd: 0.41, num_turns: 2, duration_ms: 900,
        },
      ],
    });

    expect(of(events, 'error')).toHaveLength(1);

    const done = of(events, 'done')[0]!.data as unknown as Record<string, unknown>;

    expect(done['cost_usd']).toBe(0.41);
    expect(done['num_turns']).toBe(2);
    expect((done['usage'] as Record<string, unknown>)['input_tokens']).toBe(100);
  });

  it('measures the denial budget in BYTES, not code units', async () => {
    // The unit in the code was right and the test used ASCII, where the two are
    // equal — so measuring in UTF-16 length passed. Multi-byte denials are what
    // tell the difference: 3 bytes per character against 1 code unit.
    const denial = (i: number) => ({
      tool_name: 'Write', tool_use_id: `tu_${i}`,
      tool_input: { content: '漢'.repeat(4000) },
    });
    const events = await replay(withUsage({}, {
      permission_denials: [denial(1), denial(2), denial(3), denial(4)],
    }));

    const done = of(events, 'done')[0]!.data as unknown as Record<string, unknown>;
    const encoded = Buffer.byteLength(JSON.stringify(done['permission_denials']), 'utf8');

    // 4 denials x ~12 KB of encoded bytes is over the 32 KB budget, so some are
    // omitted. Measured in code units the same input looks like ~16 KB and all
    // four would be kept.
    expect(encoded).toBeLessThanOrEqual(33 * 1024);
    expect(JSON.stringify(done['permission_denials'])).toContain('omitted');
  });
});
