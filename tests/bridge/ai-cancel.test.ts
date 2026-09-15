/**
 * Stopping a turn from the server, over a real socket.
 *
 * The other half of `ai_request`, and it was missing: a server could start work
 * on somebody's machine and had no way to say "stop", so a person watching a
 * turn go wrong could only wait for a bound to end it — and every bound the
 * bridge has is measured in minutes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';

/** Runs until it is aborted, and reports what happened to it. */
class PatientAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  aborted = false;

  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    onEvent({ event: 'block_start', data: { block_index: 0, block_type: 'text' } });

    return new Promise((resolve) => {
      const finish = (): void => {
        this.aborted = true;
        onEvent({ event: 'done', data: {} });
        resolve('sess-1');
      };
      if (context.signal.aborted) { finish(); return; }
      context.signal.addEventListener('abort', finish, { once: true });
    });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;

async function waitFor(
  match: (f: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startBridge(adapter: PatientAdapter): Promise<void> {
  bridge = new Bridge({
    serverUrl: url,
    token: 'tok',
    providers: [{
      name: 'fake', version: '1', available: true, supports_streaming: true,
      supports_tools: true, supports_thinking: false, supports_session_resume: true,
    }],
    adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [],
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    // No bound of its own: this test is about the server ending the turn, and a
    // clock that could also end it would make the outcome ambiguous.
    config: { heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0 },
    cli_isolation: 'workspace',
  }));
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('ai_cancel', () => {
  it('stops the turn it names, and the turn ends like any other', async () => {
    const adapter = new PatientAdapter();
    await startBridge(adapter);

    socket.send(JSON.stringify({
      type: 'ai_request',
      request_id: 'req_stop',
      conversation_id: 'conv-1',
      provider: 'fake',
      message: 'take your time',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    }));
    await waitFor((f) => f['type'] === 'stream' && f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'ai_cancel', request_id: 'req_stop' }));

    // It ends as a turn, not as a fault: what it produced is kept and the end
    // of it is reported, which is what lets the next message carry on.
    await waitFor(
      (f) => f['type'] === 'stream' && f['event'] === 'done' && f['request_id'] === 'req_stop',
      'the turn ending',
    );
    expect(adapter.aborted).toBe(true);
  });

  it('ignores an id that is not running, because that race is the ordinary case', async () => {
    const adapter = new PatientAdapter();
    await startBridge(adapter);
    const before = frames.length;

    socket.send(JSON.stringify({ type: 'ai_cancel', request_id: 'req_never_existed' }));
    await new Promise((r) => setTimeout(r, 100));

    // Somebody pressing stop as the answer lands is not worth a frame, and
    // answering would describe a turn that has already been reported.
    expect(frames.length).toBe(before);
  });
});
