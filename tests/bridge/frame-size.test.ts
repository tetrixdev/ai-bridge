/**
 * The bridge will not put an oversized frame on the wire.
 *
 * A backstop, not a replacement for bounding at each producer — a marked
 * truncation is a better answer than a dropped event. It exists because four
 * review rounds of one change found four separate "field X was not bounded"
 * bugs, each in a different producer and each missed the same way. This is the
 * single place a frame is serialised, so it is the one place the size can be
 * checked once for every field, including fields added later.
 *
 * What it prevents is specific: the server does not answer an oversized message
 * with an error, it answers with a CLOSE_TOO_BIG and the connection goes down,
 * taking every other in-flight request with it.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';

/** A bridge with a stand-in socket that records what reaches it. */
function bridgeWithFakeSocket(): { bridge: Bridge; sent: string[] } {
  const bridge = new Bridge({
    serverUrl: 'wss://example.test/ws',
    token: 'tok',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
    sessionStorePath: null,
    allowedRoots: [],
    allowNative: false,
  });

  const sent: string[] = [];
  (bridge as unknown as { ws: unknown }).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (payload: string) => { sent.push(payload); },
  };

  return { bridge, sent };
}

/** Ask the bridge to send one frame. */
function send(bridge: Bridge, message: unknown): void {
  (bridge as unknown as { send(m: unknown): void }).send(message);
}

describe('the frame size guard', () => {
  it('sends an ordinary frame untouched', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, { type: 'stream', request_id: 'r1', event: 'block_delta', data: { block_index: 0, content: 'hi' } });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ event: 'block_delta' });
  });

  it('refuses one over the limit', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'block_delta',
      data: { block_index: 0, content: 'x'.repeat(2 * 1024 * 1024) },
    });

    const payloads = sent.map((p) => JSON.parse(p) as { event: string; data: Record<string, unknown> });
    expect(payloads.some((p) => p.event === 'block_delta')).toBe(false);
  });

  it('tells the server why, in a frame that is not oversized', () => {
    // Losing one event is bad; losing the connection is worse, and losing it
    // silently is worst — a turn that stops mid-answer with nothing to explain.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'tool_result',
      data: { tool_call_id: 't1', result: 'x'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(1);
    const notice = JSON.parse(sent[0]!) as { event: string; request_id: string; data: Record<string, unknown> };

    expect(notice.event).toBe('error');
    expect(notice.request_id).toBe('r1');
    expect(notice.data['code']).toBe('frame_too_large');
    expect(String(notice.data['message'])).toContain('tool_result');
    expect(Buffer.byteLength(sent[0]!, 'utf8')).toBeLessThan(1024 * 1024);
  });

  it('measures bytes, not characters', () => {
    // The whole class of bug this guards: a string well under the cap by
    // character count and well over it by encoded size.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'block_delta',
      // 400k characters, three bytes each.
      data: { block_index: 0, content: String.fromCodePoint(0x4e16).repeat(400_000) },
    });

    expect(JSON.parse(sent[0]!)).toMatchObject({ event: 'error' });
  });

  it('never drops a terminal frame — it strips it instead', () => {
    // `done` is how the server learns the turn ended. Withholding it hangs the
    // request until a timeout, which is worse than the oversized frame this
    // guard exists to prevent — and it is reachable: permission_denials carries
    // each refused call's whole input, so one denied large write is enough.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'done',
      data: {
        usage: { input_tokens: 6, output_tokens: 12 },
        cli_session_id: 'sess-1',
        permission_denials: [{ tool_input: { content: 'x'.repeat(2 * 1024 * 1024) } }],
      },
    });

    expect(sent).toHaveLength(1);
    const done = JSON.parse(sent[0]!) as { event: string; data: Record<string, unknown> };

    expect(done.event).toBe('done');
    // The parts the server acts on survive; the informational bulk does not.
    expect(done.data['usage']).toMatchObject({ input_tokens: 6 });
    expect(done.data['cli_session_id']).toBe('sess-1');
    expect(done.data['permission_denials']).toBeUndefined();
    expect(done.data['truncated_by_bridge']).toBe(true);
    expect(Buffer.byteLength(sent[0]!, 'utf8')).toBeLessThan(1024 * 1024);
  });

  it('keeps an oversized error terminal, shortened', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'error',
      data: { code: 'provider_error', message: 'y'.repeat(2 * 1024 * 1024) },
    });

    const error = JSON.parse(sent[0]!) as { event: string; data: Record<string, unknown> };
    expect(error.event).toBe('error');
    expect(error.data['code']).toBe('provider_error');
    expect(String(error.data['message']).length).toBeLessThanOrEqual(2000);
  });

  it('says nothing extra for a frame with no request to attach it to', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, { type: 'hello', providers: [{ blob: 'x'.repeat(2 * 1024 * 1024) }] });

    expect(sent).toHaveLength(0);
  });
});
