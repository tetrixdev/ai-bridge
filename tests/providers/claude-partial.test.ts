/**
 * Partial-message streaming for the Claude adapter.
 *
 * Two layers. The mapper is exercised directly for the shapes that are easy to
 * get wrong, and then whole turns CAPTURED FROM THE REAL CLI (Claude Code
 * 2.1.261, `tests/providers/fixtures/*.ndjson`) are replayed through the
 * adapter. The fixtures matter: the failure this feature is most likely to
 * cause — every block delivered twice, because the CLI sends both a partial
 * stream and its whole-message twin — is invisible to any test whose input was
 * written by the same person as the code.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ClaudePartialStreamMapper, normaliseToolArguments } from '../../src/providers/claude-partial.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

// Report partial support without spawning a real `claude --help`. This must
// be TRUE rather than stubbed off: the adapter's dedupe branch only runs in
// partial mode, so a replay with the probe disabled cannot see a regression
// there at all — it would pass whatever the adapter did with assistant frames.
vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
}));

const FIXTURES = join(fileURLToPath(new URL('./fixtures/', import.meta.url)));

/** Collect what the mapper emits for a list of raw CLI frames. */
function run(frames: Array<Record<string, unknown>>): AdapterStreamEvent[] {
  const mapper = new ClaudePartialStreamMapper();
  const events: AdapterStreamEvent[] = [];
  for (const frame of frames) mapper.handle(frame, (e) => events.push(e));
  return events;
}

const messageStart = (id: string) => ({ event: { type: 'message_start', message: { id } } });
const blockStart = (index: number, contentBlock: Record<string, unknown>) =>
  ({ event: { type: 'content_block_start', index, content_block: contentBlock } });
const blockDelta = (index: number, delta: Record<string, unknown>) =>
  ({ event: { type: 'content_block_delta', index, delta } });
const blockStop = (index: number) => ({ event: { type: 'content_block_stop', index } });

describe('ClaudePartialStreamMapper', () => {
  it('turns text chunks into one block with many deltas', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'Hello' }),
      blockDelta(0, { type: 'text_delta', text: ' world' }),
      blockStop(0),
    ]);

    expect(events.map((e) => e.event)).toEqual(['block_start', 'block_delta', 'block_delta', 'block_stop']);
    expect(events.every((e) => (e.data as { block_index: number }).block_index === 0)).toBe(true);
    expect(events.filter((e) => e.event === 'block_delta')
      .map((e) => (e.data as { content: string }).content).join('')).toBe('Hello world');
  });

  it('gives blocks from different messages different indices', () => {
    // The CLI restarts `index` at 0 for every message in the turn, so a turn
    // that calls a tool has two blocks numbered 0. Forwarding that raw would
    // splice the second message's text onto the first message's block.
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'first' }),
      blockStop(0),
      messageStart('msg_2'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'second' }),
      blockStop(0),
    ]);

    const starts = events.filter((e) => e.event === 'block_start');
    expect(starts.map((e) => (e.data as { block_index: number }).block_index)).toEqual([0, 1]);
  });

  it('does not forward a thinking signature as reasoning text', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'thinking', thinking: '' }),
      blockDelta(0, { type: 'thinking_delta', thinking: 'let me check' }),
      blockDelta(0, { type: 'signature_delta', signature: 'EqQBCkYIBRgCKkDlong+base64==' }),
      blockStop(0),
    ]);

    const deltas = events.filter((e) => e.event === 'block_delta')
      .map((e) => (e.data as { content: string }).content);
    expect(deltas).toEqual(['let me check']);
  });

  it('buffers tool arguments into a single delta with the whole-message shape', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Read' }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '' }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '{"file_pa' }),
      blockDelta(0, { type: 'input_json_delta', partial_json: 'th": "/tmp/a.txt"}' }),
      blockStop(0),
    ]);

    expect(events.map((e) => e.event)).toEqual(['block_start', 'block_delta', 'block_stop']);
    expect(events[0]!.data).toMatchObject({ block_type: 'tool_call', tool_name: 'Read', tool_call_id: 'toolu_1' });
    expect((events[1]!.data as { content: string }).content).toBe(JSON.stringify({ file_path: '/tmp/a.txt' }));
  });

  it('ignores a block type it has no mapping for, deltas and stop included', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'redacted_thinking', data: 'opaque' }),
      blockDelta(0, { type: 'text_delta', text: 'should not appear' }),
      blockStop(0),
      blockStart(1, { type: 'text', text: '' }),
      blockDelta(1, { type: 'text_delta', text: 'real' }),
      blockStop(1),
    ]);

    // The unmapped block consumes no index, so the real one is still 0.
    expect(events.map((e) => e.event)).toEqual(['block_start', 'block_delta', 'block_stop']);
    expect((events[0]!.data as { block_index: number }).block_index).toBe(0);
    expect((events[1]!.data as { content: string }).content).toBe('real');
  });

  it('drops a block that never produces content, and gives away no index for it', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'thinking', thinking: '' }),
      blockDelta(0, { type: 'signature_delta', signature: 'sig' }),
      blockStop(0),
      blockStart(1, { type: 'text', text: '' }),
      blockDelta(1, { type: 'text_delta', text: 'the answer' }),
      blockStop(1),
    ]);

    expect(events.map((e) => e.event)).toEqual(['block_start', 'block_delta', 'block_stop']);
    expect(events[0]!.data).toMatchObject({ block_index: 0, block_type: 'text' });
  });

  it('announces a non-empty thinking block as thinking, not as text', () => {
    // Nothing else asserts the block_type that reaches the consumer for a
    // streamed thinking block; get it wrong and reasoning renders as answer
    // prose, with a green suite.
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'thinking', thinking: '' }),
      blockDelta(0, { type: 'thinking_delta', thinking: 'weighing it up' }),
      blockStop(0),
    ]);
    expect(events[0]!.data).toMatchObject({ block_index: 0, block_type: 'thinking' });
  });

  it('does not splice a new message into a block the previous one left open', () => {
    // Both messages use CLI index 0. If the per-message mapping survived the
    // message boundary, the second message's text would be appended to the
    // first message's block — which a truncated stream makes reachable.
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'first' }),
      // no content_block_stop: the message ends abruptly
      messageStart('msg_2'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'second' }),
      blockStop(0),
    ]);

    const starts = events.filter((e) => e.event === 'block_start')
      .map((e) => (e.data as { block_index: number }).block_index);
    expect(starts).toEqual([0, 1]);

    const secondDelta = events.filter((e) => e.event === 'block_delta')
      .find((e) => (e.data as { content: string }).content === 'second');
    expect((secondDelta!.data as { block_index: number }).block_index).toBe(1);
  });

  it('drops a stray delta left over from an unterminated message', () => {
    // Message 1 never closes its block; message 2 then sends a delta for the
    // same CLI index with no content_block_start of its own. If the per-message
    // maps survived the boundary, that delta would be appended to the PREVIOUS
    // message's block. Only reachable on malformed output, which is exactly
    // when it would be hardest to diagnose.
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'first' }),
      messageStart('msg_2'),
      blockDelta(0, { type: 'text_delta', text: 'stray' }),
      blockStop(0),
    ]);

    expect(events.filter((e) => e.event === 'block_delta')
      .map((e) => (e.data as { content: string }).content)).toEqual(['first']);
  });

  it('drops a stray delta for a block announced but never opened in a past message', () => {
    // Same shape, but the leftover is a PENDING block (announced, no content
    // yet) rather than an open one.
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'thinking', thinking: '' }),
      messageStart('msg_2'),
      blockDelta(0, { type: 'thinking_delta', thinking: 'leaked' }),
      blockStop(0),
    ]);

    expect(events).toEqual([]);
  });

  it('closes a block the stream abandoned', () => {
    const mapper = new ClaudePartialStreamMapper();
    const events: AdapterStreamEvent[] = [];
    const emit = (e: AdapterStreamEvent) => events.push(e);

    mapper.handle(messageStart('msg_1'), emit);
    mapper.handle(blockStart(0, { type: 'text', text: '' }), emit);
    mapper.handle(blockDelta(0, { type: 'text_delta', text: 'half an ans' }), emit);
    expect(mapper.hasOpenBlock()).toBe(true);

    mapper.closeOpenBlocks(emit);

    expect(events.at(-1)).toEqual({ event: 'block_stop', data: { block_index: 0 } });
    expect(mapper.hasOpenBlock()).toBe(false);
  });

  it('flushes the arguments of a tool call cut off mid-stream', () => {
    // The buffering decision creates this case: without a flush the consumer
    // gets an announced tool call with NO arguments delta at all, which is
    // indistinguishable from a tool deliberately called with none.
    const mapper = new ClaudePartialStreamMapper();
    const events: AdapterStreamEvent[] = [];
    const emit = (e: AdapterStreamEvent) => events.push(e);

    mapper.handle(messageStart('msg_1'), emit);
    mapper.handle(blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Read' }), emit);
    mapper.handle(blockDelta(0, { type: 'input_json_delta', partial_json: '{"file_pa' }), emit);

    mapper.closeOpenBlocks(emit);

    const delta = events.find((e) => e.event === 'block_delta');
    expect(delta).toBeDefined();
    // Forwarded verbatim rather than reported as `{}`: a consumer can say the
    // arguments were truncated, where an empty object silently lies.
    expect((delta!.data as { content: string }).content).toBe('{"file_pa');
    expect(events.at(-1)!.event).toBe('block_stop');
  });

  it('closes several open blocks in the order they were opened', () => {
    const mapper = new ClaudePartialStreamMapper();
    const events: AdapterStreamEvent[] = [];
    const emit = (e: AdapterStreamEvent) => events.push(e);

    mapper.handle(messageStart('msg_1'), emit);
    mapper.handle(blockStart(0, { type: 'text', text: '' }), emit);
    mapper.handle(blockDelta(0, { type: 'text_delta', text: 'a' }), emit);
    mapper.handle(blockStart(1, { type: 'tool_use', id: 't1', name: 'Read' }), emit);

    events.length = 0;
    mapper.closeOpenBlocks(emit);

    expect(events.filter((e) => e.event === 'block_stop')
      .map((e) => (e.data as { block_index: number }).block_index)).toEqual([0, 1]);
  });

  it('ignores a streamed sub-agent frame, leaving the main mapping intact', () => {
    // Today the CLI never streams sidechains. If it started, a sub-agent
    // message_start landing mid-message would wipe the main agent's live
    // mapping and route its remaining deltas into the wrong block.
    const mapper = new ClaudePartialStreamMapper();
    const events: AdapterStreamEvent[] = [];
    const emit = (e: AdapterStreamEvent) => events.push(e);

    mapper.handle(messageStart('msg_main'), emit);
    mapper.handle(blockStart(0, { type: 'text', text: '' }), emit);
    mapper.handle(blockDelta(0, { type: 'text_delta', text: 'main ' }), emit);

    mapper.handle({ ...messageStart('msg_sub'), parent_tool_use_id: 'toolu_x' }, emit);
    mapper.handle({ ...blockStart(0, { type: 'text', text: '' }), parent_tool_use_id: 'toolu_x' }, emit);

    mapper.handle(blockDelta(0, { type: 'text_delta', text: 'answer' }), emit);
    mapper.handle(blockStop(0), emit);

    // One block, both deltas, and the sub-agent's id never registered as
    // streamed — so its `assistant` twin will still be delivered whole.
    expect(events.filter((e) => e.event === 'block_start')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'block_delta')
      .map((e) => (e.data as { content: string }).content).join('')).toBe('main answer');
    expect(mapper.wasStreamed('msg_sub')).toBe(false);
  });

  it('drops a tool block with no name or id, as the whole-message path does', () => {
    const events = run([
      messageStart('msg_1'),
      blockStart(0, { type: 'tool_use', id: 'toolu_1' }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '{}' }),
      blockStop(0),
    ]);
    expect(events).toEqual([]);
  });

  it('survives frames with missing or wrongly typed fields', () => {
    expect(() => run([
      {},
      { event: null },
      { event: { type: 'content_block_start' } },
      { event: { type: 'content_block_start', index: 'nope', content_block: { type: 'text' } } },
      { event: { type: 'content_block_delta', index: 0 } },
      { event: { type: 'message_start' } },
      { event: { type: 'ping' } },
    ])).not.toThrow();
  });

  it('reports only ids it actually streamed', () => {
    const mapper = new ClaudePartialStreamMapper();
    mapper.handle(messageStart('msg_streamed'), () => {});
    expect(mapper.wasStreamed('msg_streamed')).toBe(true);
    expect(mapper.wasStreamed('msg_sidechain')).toBe(false);
    expect(mapper.wasStreamed(undefined)).toBe(false);
  });
});

describe('normaliseToolArguments', () => {
  it('reports an empty buffer as an empty object, not an empty string', () => {
    // A tool called with no arguments streams nothing (or one empty fragment).
    // Forwarding "" gives the server a delta that JSON.parse throws on.
    expect(normaliseToolArguments(undefined)).toBe('{}');
    expect(normaliseToolArguments('')).toBe('{}');
  });

  it('re-encodes so the value matches the whole-message path exactly', () => {
    expect(normaliseToolArguments('{"a":  1,\n "b": [2,3] }')).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
  });

  it('forwards unparseable JSON verbatim rather than inventing empty arguments', () => {
    expect(normaliseToolArguments('{"file_path": "/tmp/tr')).toBe('{"file_path": "/tmp/tr');
  });
});

// ── Whole turns, replayed from real CLI output ────────────────────────────

/** Feed a captured NDJSON file through the adapter and collect its events. */
async function replay(fixture: string): Promise<AdapterStreamEvent[]> {
  const path = join(FIXTURES, fixture);

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
    request_id: 'req_replay',
    conversation_id: 'conv_1',
    provider: 'claude',
    message: 'go',
    system_prompt: null,
    options: {},
    cli_session_id: null,
  };

  const context: ExecutionContext = {
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
  };

  const events: AdapterStreamEvent[] = [];
  await new Replay().execute(context, (e) => events.push(e));
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
  return [...types.entries()]
    .filter(([, t]) => t === blockType)
    .map(([i]) => text.get(i) ?? '');
}

describe('replaying real partial-mode turns through the adapter', () => {
  it('delivers each block exactly once despite the CLI sending both forms', async () => {
    const events = await replay('claude-partial-tool-turn.ndjson');

    // The turn's answer, captured from the run, appears once and once only.
    const texts = textOfBlocks(events, 'text');
    expect(texts).toEqual(['The code is **ZX-4471**.']);

    // And every block index is opened once — the duplicate-emission bug shows
    // up here first, as two block_starts sharing an index.
    const startIndices = events.filter((e) => e.event === 'block_start')
      .map((e) => (e.data as { block_index: number }).block_index);
    expect(new Set(startIndices).size).toBe(startIndices.length);
  });

  it('numbers blocks 0,1,2… across BOTH paths in one turn', async () => {
    // The sub-agent turn is the only fixture that exercises the whole-message
    // path and the partial path sharing one counter, which is the entire
    // reason the counter moved into the mapper. Without this, replacing
    // `mapper.nextIndex()` with the literal 0 passes the whole suite, and
    // every sub-agent tool call collides on block_index 0.
    for (const fixture of ['claude-partial-tool-turn.ndjson', 'claude-partial-subagent-turn.ndjson']) {
      const events = await replay(fixture);
      const indices = events.filter((e) => e.event === 'block_start')
        .map((e) => (e.data as { block_index: number }).block_index);

      expect(indices.length).toBeGreaterThan(1);
      expect(indices, `block_start indices for ${fixture}`)
        .toEqual(indices.map((_, i) => i));
    }
  });

  it('gives the sub-agent turn the indices the emission order implies', async () => {
    const events = await replay('claude-partial-subagent-turn.ndjson');
    const named = events.filter((e) => e.event === 'block_start'
      && (e.data as { tool_name?: string }).tool_name !== undefined)
      .map((e) => {
        const d = e.data as { block_index: number; tool_name: string };
        return [d.tool_name, d.block_index] as const;
      });

    // The main agent delegates (Agent, 0), the sub-agent does its own work
    // (Bash 1, Read 2), and the main agent's closing text follows.
    expect(named).toEqual([['Agent', 0], ['Bash', 1], ['Read', 2]]);
  });

  it('streams that answer in chunks rather than one lump', async () => {
    const events = await replay('claude-partial-tool-turn.ndjson');
    const textIndex = events.find((e) => e.event === 'block_start'
      && (e.data as { block_type: string }).block_type === 'text');
    const index = (textIndex!.data as { block_index: number }).block_index;

    const deltas = events.filter((e) => e.event === 'block_delta'
      && (e.data as { block_index: number }).block_index === index);
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('drops an empty thinking block instead of showing a hollow one', async () => {
    // This turn's interleaved thinking block carries a signature and no text,
    // which the whole-message path skips outright. Opening it eagerly would
    // put an empty reasoning bubble in front of the user on a real turn.
    const events = await replay('claude-partial-tool-turn.ndjson');
    expect(textOfBlocks(events, 'thinking')).toEqual([]);
  });

  it('keeps the tool call, with parseable arguments', async () => {
    const events = await replay('claude-partial-tool-turn.ndjson');

    const toolStart = events.find((e) => e.event === 'block_start'
      && (e.data as { block_type: string }).block_type === 'tool_call');
    expect(toolStart!.data).toMatchObject({ tool_name: 'Read' });

    const args = textOfBlocks(events, 'tool_call');
    expect(args).toHaveLength(1);
    expect(JSON.parse(args[0]!)).toHaveProperty('file_path');

    // The dropped empty thinking block gives away no index, so the tool call
    // is 0 and the answer text is 1 — the same numbering the whole-message
    // path would have produced.
    expect((toolStart!.data as { block_index: number }).block_index).toBe(0);
  });

  it('still forwards sub-agent messages, which arrive only in whole-message form', async () => {
    // The CLI emits no stream_event for a sidechain, so these reach the server
    // through the `assistant` path. A blanket "partial mode is on, drop every
    // assistant frame" rule would lose them, and the sub-agent's work would
    // simply not appear in the recorded turn.
    const events = await replay('claude-partial-subagent-turn.ndjson');

    const toolNames = events.filter((e) => e.event === 'block_start')
      .map((e) => (e.data as { tool_name?: string }).tool_name)
      .filter((n): n is string => n !== undefined);

    expect(toolNames).toContain('Agent');  // the main agent delegating
    expect(toolNames).toContain('Bash');   // and the sub-agent's own calls
    expect(toolNames).toContain('Read');
  });

  it('ends the turn normally', async () => {
    const events = await replay('claude-partial-tool-turn.ndjson');
    expect(events.at(-1)!.event).toBe('done');
    expect(events.some((e) => e.event === 'error')).toBe(false);
  });
});

// ── The flag itself ───────────────────────────────────────────────────────

describe('the --include-partial-messages flag', () => {
  /** Run the adapter to the point of spawning and report its argv. */
  async function argvFor(): Promise<string[]> {
    let recorded: string[] = [];

    class Probe extends ClaudeAdapter {
      protected override spawnCli(
        _command: string,
        args: string[],
      ): ChildProcessByStdio<Writable | null, Readable, Readable> {
        recorded = args;
        return spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] }) as
          ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const request: AiRequestMessage = {
      type: 'ai_request',
      request_id: 'req_flag',
      conversation_id: 'conv_1',
      provider: 'claude',
      message: 'go',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    };

    await new Probe().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'isolated',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, () => {});

    return recorded;
  }

  it('is passed when the CLI supports it', async () => {
    // Without this the whole feature is inert: the CLI keeps sending whole
    // messages and every other test here still passes, because they replay
    // captured output rather than producing it.
    expect(await argvFor()).toContain('--include-partial-messages');
  });

  it('sits alongside the flags it requires', async () => {
    // The flag only works with --print and --output-format=stream-json.
    const argv = await argvFor();
    expect(argv).toContain('-p');
    expect(argv.join(' ')).toContain('--output-format stream-json');
  });
});

// ── Turns that end badly ──────────────────────────────────────────────────

describe('a turn that is cut off mid-stream', () => {
  /** Replay only the first `lines` of a fixture, then exit with `code`. */
  async function replayTruncated(fixture: string, lines: number, code: number): Promise<AdapterStreamEvent[]> {
    const path = join(FIXTURES, fixture);

    class Truncated extends ClaudeAdapter {
      protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
        return spawn(process.execPath, ['-e', `
          const all = require('fs').readFileSync(process.argv[1], 'utf8').split('\\n');
          process.stdout.write(all.slice(0, ${lines}).join('\\n') + '\\n');
          process.exit(${code});
        `, path], { stdio: ['ignore', 'pipe', 'pipe'] }) as
          ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const request: AiRequestMessage = {
      type: 'ai_request',
      request_id: 'req_trunc',
      conversation_id: 'conv_1',
      provider: 'claude',
      message: 'go',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    };

    const events: AdapterStreamEvent[] = [];
    await new Truncated().execute({
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

  /** Block indices opened but never closed. */
  function unclosed(events: AdapterStreamEvent[]): number[] {
    const open = new Set<number>();
    for (const e of events) {
      const i = (e.data as { block_index?: number }).block_index;
      if (i === undefined) continue;
      if (e.event === 'block_start') open.add(i);
      if (e.event === 'block_stop') open.delete(i);
    }
    return [...open];
  }

  it('closes the text block the CLI abandoned', async () => {
    // Before partial streaming this adapter could not emit an unclosed block —
    // start, delta and stop went out together. A consumer that commits a block
    // on block_stop would otherwise drop the tail of every cancelled answer.
    const events = await replayTruncated('claude-partial-tool-turn.ndjson', 48, 143);

    expect(events.some((e) => e.event === 'block_delta')).toBe(true);
    expect(unclosed(events)).toEqual([]);
  });

  it('still ends the turn', async () => {
    const events = await replayTruncated('claude-partial-tool-turn.ndjson', 48, 143);
    expect(events.at(-1)!.event).toBe('done');
  });

  it('emits the buffered tool arguments rather than none at all', async () => {
    // Cut inside the tool block's argument fragments.
    const events = await replayTruncated('claude-partial-tool-turn.ndjson', 12, 143);

    const toolStart = events.find((e) => e.event === 'block_start'
      && (e.data as { block_type: string }).block_type === 'tool_call');
    expect(toolStart).toBeDefined();

    const index = (toolStart!.data as { block_index: number }).block_index;
    const delta = events.find((e) => e.event === 'block_delta'
      && (e.data as { block_index: number }).block_index === index);

    expect(delta, 'a truncated tool call must still report the arguments it had')
      .toBeDefined();
    expect((delta!.data as { content: string }).content.length).toBeGreaterThan(0);
    expect(unclosed(events)).toEqual([]);
  });

  it('closes blocks before reporting a CLI-reported error', async () => {
    // The is_error result path sets `settled` and returns, so the finalizer's
    // pre-finalize hook never runs — blocks have to be closed there too.
    const path = join(FIXTURES, 'claude-partial-tool-turn.ndjson');
    const head = readFileSync(path, 'utf8').split('\n').slice(0, 12).join('\n');
    const errorResult = JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      session_id: 's', errors: ['boom'],
    });

    class Erroring extends ClaudeAdapter {
      protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
        return spawn(process.execPath, ['-e',
          `process.stdout.write(${JSON.stringify(head + '\n' + errorResult + '\n')})`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] }) as
          ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const events: AdapterStreamEvent[] = [];
    await new Erroring().execute({
      request: {
        type: 'ai_request', request_id: 'req_err', conversation_id: 'c', provider: 'claude',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_err',
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, (e) => events.push(e));

    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(unclosed(events)).toEqual([]);

    // And the close has to precede the error, not trail it.
    const lastStop = events.map((e) => e.event).lastIndexOf('block_stop');
    expect(lastStop).toBeLessThan(events.map((e) => e.event).indexOf('error'));
  });
});

describe('a request cancelled before the CLI is spawned', () => {
  it('ends the turn instead of spawning for a reader that has gone', async () => {
    // The capability probe is the first await in execute(), and adding an abort
    // listener to an already-aborted signal never fires it. Without the check,
    // a disconnect landing in that window spawns a CLI nobody will read, which
    // then burns tokens until the request timeout.
    let spawned = false;
    class Probe extends ClaudeAdapter {
      protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
        spawned = true;
        return spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] }) as
          ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const controller = new AbortController();
    controller.abort();

    const events: AdapterStreamEvent[] = [];
    await new Probe().execute({
      request: {
        type: 'ai_request', request_id: 'req_abort', conversation_id: 'c', provider: 'claude',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_abort',
      tools: [],
      mcp: null,
      cliIsolation: 'isolated',
      workingDir: process.cwd(),
      signal: controller.signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, (e) => events.push(e));

    expect(spawned).toBe(false);
    expect(events.map((e) => e.event)).toEqual(['done']);
  });
});

describe('a whole-message frame arriving while a partial block is open', () => {
  it('is held back so blocks never overlap', async () => {
    // Every consumer tracks exactly one open block — the reference chat UI and
    // the conversation recorder both do — so a block_start arriving inside
    // another one silently discards the outer block's text. Today's CLI cannot
    // produce this (a sub-agent runs only while the main agent is blocked on
    // the tool call), but a backgrounded sub-agent would.
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_main' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main ' } } },
      // A sub-agent message lands mid-block. It is never streamed, so it takes
      // the whole-message path.
      {
        type: 'assistant', parent_tool_use_id: 'toolu_bg',
        message: { id: 'msg_sub', content: [{ type: 'text', text: 'from the sub-agent' }] },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'result', subtype: 'success', session_id: 's', usage: {} },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';

    class Interleaved extends ClaudeAdapter {
      protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
        return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(lines)})`],
          { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const events: AdapterStreamEvent[] = [];
    await new Interleaved().execute({
      request: {
        type: 'ai_request', request_id: 'req_i', conversation_id: 'c', provider: 'claude',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_i',
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, (e) => events.push(e));

    // No block_start may appear between another block's start and its stop.
    let open: number | null = null;
    for (const e of events) {
      const i = (e.data as { block_index?: number }).block_index;
      if (e.event === 'block_start') {
        expect(open, `block ${i} opened while ${open} was still open`).toBeNull();
        open = i!;
      }
      if (e.event === 'block_stop') open = null;
    }

    // Held back, not dropped: the sub-agent's text still arrives.
    expect(textOfBlocks(events, 'text')).toEqual(['main answer', 'from the sub-agent']);
  });
});
