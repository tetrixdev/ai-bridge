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
