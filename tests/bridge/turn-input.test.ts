/**
 * Messages for a running turn, over a real socket: `accepts_input` on the
 * request, `input_open` on the ack, and a `turn_input_ack` for every
 * `turn_input` — accepted, or rejected with the reason the server acts on.
 *
 * The adapter is a stand-in that opens the turn's input port the way the
 * Claude adapter does once its CLI is running; what the Claude adapter does
 * with the port is covered in tests/providers/turn-input.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import type { TurnInputPort } from '../../src/providers/turn-input.js';

/** Runs until aborted or told to finish, with its input port open. */
class InputAdapter extends ProviderAdapter {
  constructor(readonly providerName: string) {
    super();
  }
  contexts: ExecutionContext[] = [];
  written: string[] = [];
  finish: () => void = () => {};

  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.contexts.push(context);
    const port = context.turnInput ?? null;
    port?.open((frame) => this.written.push(frame), () => {});
    onEvent({ event: 'block_start', data: { block_index: 0, block_type: 'text' } });

    return new Promise((resolve) => {
      const end = (): void => {
        port?.end();
        onEvent({ event: 'done', data: {} });
        resolve('sess-1');
      };
      this.finish = end;
      if (context.signal.aborted) { end(); return; }
      context.signal.addEventListener('abort', end, { once: true });
    });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

/**
 * Like InputAdapter, but an abort does not end the turn by itself: the test
 * ends it with finish(), as a real CLI takes a while to stop — and may still
 * read a queued message on its way out.
 */
class SlowStopAdapter extends InputAdapter {
  port: TurnInputPort | null = null;
  override execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.contexts.push(context);
    this.port = context.turnInput ?? null;
    this.port?.open((frame) => this.written.push(frame), () => {});
    onEvent({ event: 'block_start', data: { block_index: 0, block_type: 'text' } });

    return new Promise((resolve) => {
      this.finish = (): void => {
        this.port?.end();
        onEvent({ event: 'done', data: {} });
        resolve('sess-1');
      };
      context.signal.addEventListener('abort', () => this.port?.end(), { once: true });
    });
  }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startBridge(adapters: InputAdapter[]): Promise<void> {
  bridge = new Bridge({
    serverUrl: url,
    token: 'tok',
    providers: adapters.map((a) => ({
      name: a.providerName, version: '1', available: true, supports_streaming: true,
      supports_tools: true, supports_thinking: false, supports_session_resume: true,
    })),
    adapters: new Map(adapters.map((a) => [a.providerName, a as unknown as ProviderAdapter])),
    sessionStorePath: null,
    allowedRoots: [],
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    config: { heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0 },
    cli_isolation: 'workspace',
  }));
  await new Promise((r) => setTimeout(r, 50));
}

function request(id: string, options: Record<string, unknown>, provider = 'claude'): void {
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: id, conversation_id: 'conv-1', provider,
    message: 'take your time', system_prompt: null, options, cli_session_id: null,
  }));
}

const ackFor = (id: string, messageId: string) => waitFor(
  (f) => f['type'] === 'turn_input_ack' && f['request_id'] === id && f['message_id'] === messageId,
  `the ack for ${messageId}`,
);

beforeEach(async () => {
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('accepts_input', () => {
  it('is advertised in hello', async () => {
    await startBridge([new InputAdapter('claude')]);

    expect(frames.find((f) => f['type'] === 'hello')!['turn_input']).toBe(true);
  });

  it('confirms it on the ack, and runs the turn with background tasks on and the matching addendum', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);

    request('req_in', { accepts_input: true });
    const ack = await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    expect(ack['input_open']).toBe(true);
    const context = adapter.contexts[0];
    expect(context.turnInput).not.toBeNull();
    expect(context.bridgeEnv['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBeNull();
    expect(context.bridgeAddendum).toContain('Background tasks are available in this turn');
    adapter.finish();
  });

  it('changes nothing for a turn that did not ask', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);

    request('req_plain', {});
    const ack = await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    expect('input_open' in ack).toBe(false);
    const context = adapter.contexts[0];
    expect(context.turnInput ?? null).toBeNull();
    expect(context.bridgeEnv['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe('1');
    adapter.finish();
  });

  it('is not confirmed for a provider that cannot keep its input open', async () => {
    const adapter = new InputAdapter('codex');
    await startBridge([adapter]);

    request('req_codex', { accepts_input: true }, 'codex');
    const ack = await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    expect('input_open' in ack).toBe(false);
    expect(adapter.contexts[0].turnInput ?? null).toBeNull();
    adapter.finish();
  });
});

describe('turn_input', () => {
  it('accepts a message for a running turn with its input open, and hands it to the CLI', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1', content: 'also this' }));
    const ack = await ackFor('req_in', 'm1');

    expect(ack).toEqual({ type: 'turn_input_ack', request_id: 'req_in', message_id: 'm1', status: 'accepted' });
    expect(adapter.written).toEqual(['{"type":"user","message":{"role":"user","content":"also this"}}\n']);
    adapter.finish();
  });

  it('rejects with input_not_open for a running turn that did not ask for it', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_plain', {});
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_plain', message_id: 'm1', content: 'hi' }));

    expect(await ackFor('req_plain', 'm1')).toEqual({
      type: 'turn_input_ack', request_id: 'req_plain', message_id: 'm1', status: 'rejected', reason: 'input_not_open',
    });
    expect(adapter.written).toEqual([]);
    adapter.finish();
  });

  it('rejects with turn_not_running for a turn that is not running, or has ended', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);

    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_never', message_id: 'm0', content: 'hi' }));
    expect(await ackFor('req_never', 'm0')).toMatchObject({ status: 'rejected', reason: 'turn_not_running' });

    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');
    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'the turn ending');

    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1', content: 'hi' }));
    expect(await ackFor('req_in', 'm1')).toMatchObject({ status: 'rejected', reason: 'turn_not_running' });
  });

  it('rejects with turn_ending while a stopped turn is still stopping, then turn_not_running once it is over', async () => {
    const adapter = new SlowStopAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_in' }));
    await new Promise((r) => setTimeout(r, 50));
    // The CLI is still stopping: a new turn now would resume the session
    // while it still writes to it. Hold until `cancelled`.
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1', content: 'hi' }));
    expect(await ackFor('req_in', 'm1')).toMatchObject({ status: 'rejected', reason: 'turn_ending' });
    expect(frames.some((f) => f['type'] === 'cancelled')).toBe(false);

    adapter.finish();
    await waitFor((f) => f['type'] === 'cancelled', 'cancelled');
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm2', content: 'hi' }));
    expect(await ackFor('req_in', 'm2')).toMatchObject({ status: 'rejected', reason: 'turn_not_running' });
    // The terminal frame went out ahead of the turn_not_running.
    expect(frames.findIndex((f) => f['type'] === 'cancelled'))
      .toBeLessThan(frames.findIndex((f) => f['type'] === 'turn_input_ack' && f['message_id'] === 'm2'));
  });

  it('names the accepted messages a stopped turn never read', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1', content: 'one' }));
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm2', content: 'two' }));
    await ackFor('req_in', 'm2');

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_in' }));
    const cancelled = await waitFor((f) => f['type'] === 'cancelled', 'the cancelled reply');

    expect(cancelled).toEqual({ type: 'cancelled', request_id: 'req_in', pending_inputs: ['m1', 'm2'] });
    const done = frames.find((f) => f['event'] === 'done')!;
    expect((done['data'] as Record<string, unknown>)['pending_inputs']).toEqual(['m1', 'm2']);
  });

  it('sends an empty pending_inputs on a stopped input turn with nothing pending, and none on other turns', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');
    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_in' }));
    expect(await waitFor((f) => f['type'] === 'cancelled', 'cancelled')).toEqual({
      type: 'cancelled', request_id: 'req_in', pending_inputs: [],
    });
    const done = frames.find((f) => f['event'] === 'done')!;
    expect('pending_inputs' in (done['data'] as Record<string, unknown>)).toBe(false);

    request('req_plain', {});
    await waitFor((f) => f['event'] === 'block_start' && f['request_id'] === 'req_plain', 'the second turn');
    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_plain' }));
    expect(await waitFor((f) => f['type'] === 'cancelled' && f['request_id'] === 'req_plain', 'cancelled'))
      .toEqual({ type: 'cancelled', request_id: 'req_plain' });
  });

  it('does not answer a frame with no message to account for', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1' }));
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', content: 'no id' }));
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm3', content: '' }));
    await new Promise((r) => setTimeout(r, 150));

    expect(frames.filter((f) => f['type'] === 'turn_input_ack')).toHaveLength(0);
    expect(adapter.written).toEqual([]);
    adapter.finish();
  });
});

describe('a disconnect', () => {
  /** Drop the socket from the server's side and take the bridge's reconnect, with its welcome. */
  async function reconnect(): Promise<void> {
    const next = new Promise<WsSocket>((resolve) => wss.once('connection', resolve));
    socket.close();
    const ws = await next;
    socket = ws;
    const hellos = frames.filter((f) => f['type'] === 'hello').length;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await waitFor(() => frames.filter((f) => f['type'] === 'hello').length > hellos, 'the second hello');
    ws.send(JSON.stringify({
      type: 'welcome', session_id: 'conn-2', tools: [],
      config: { heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0 },
      cli_isolation: 'workspace',
    }));
  }

  const replayFor = (id: string) => waitFor(
    (f) => f['type'] === 'error' && f['request_id'] === id && f['code'] === 'bridge_disconnected',
    `the replayed error for ${id}`,
  );

  it('names in the replayed error the accepted messages the turn never read, counted once it has ended', async () => {
    const adapter = new SlowStopAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm1', content: 'one' }));
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm2', content: 'two' }));
    await ackFor('req_in', 'm2');

    await reconnect();
    await new Promise((r) => setTimeout(r, 150));
    // The server is back, but the turn is still stopping: its CLI may yet read
    // a queued message, so nothing is reported until it has ended.
    expect(frames.some((f) => f['type'] === 'error' && f['request_id'] === 'req_in')).toBe(false);

    // Meanwhile a message for it is held, not started as a new turn: the
    // old CLI is still alive.
    socket.send(JSON.stringify({ type: 'turn_input', request_id: 'req_in', message_id: 'm3', content: 'three' }));
    expect(await ackFor('req_in', 'm3')).toMatchObject({ status: 'rejected', reason: 'turn_ending' });

    // It reads m1 on its way out, then is gone.
    expect(adapter.port!.shiftRead()).toBe('m1');
    adapter.finish();

    expect(await replayFor('req_in')).toEqual({
      type: 'error', request_id: 'req_in', code: 'bridge_disconnected',
      message: expect.any(String) as string, fatal: false, pending_inputs: ['m2'],
    });
  }, 10_000);

  it('replays an input turn that already ended at the welcome, with an empty list when all was read', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_in', { accepts_input: true });
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    await reconnect();

    expect((await replayFor('req_in'))['pending_inputs']).toEqual([]);
  }, 10_000);

  it('replays any other turn as before, without pending_inputs', async () => {
    const adapter = new InputAdapter('claude');
    await startBridge([adapter]);
    request('req_plain', {});
    await waitFor((f) => f['event'] === 'block_start', 'the turn starting');

    await reconnect();

    expect('pending_inputs' in (await replayFor('req_plain'))).toBe(false);
  }, 10_000);
});
