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

describe('the fallbacks the guard itself produces', () => {
  const MAX = 900 * 1024;

  it('does not send a stripped `done` that is STILL oversized', () => {
    // The bug this covers: `stripToEssentials` keeps `usage` and
    // `cli_session_id`, both straight from the provider and neither bounded
    // anywhere, and the stripped frame went out without ever being measured.
    // A guard that answers one oversized frame with another it did not measure
    // closes the connection exactly as if it were not there.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'done',
      data: {
        usage: { input_tokens: 1 },
        cli_session_id: 's'.repeat(2 * 1024 * 1024),
        permission_denials: ['x'.repeat(1024)],
      },
    });

    for (const payload of sent) {
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(MAX);
    }
  });

  it('still ends the turn when the oversized field was the session id', () => {
    // Dropping `done` hangs the request until a timeout, so the guard must fall
    // through to a smaller terminal rather than give up at the first miss.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'done',
      data: { usage: { input_tokens: 1 }, cli_session_id: 's'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as { event: string; request_id: string; data: Record<string, unknown> };

    expect(frame.event).toBe('done');
    expect(frame.request_id).toBe('r1');
    expect(frame.data['cli_session_id']).toBeNull();
  });

  it('keeps usage when usage is not what made the frame too big', () => {
    // The degradation is ordered, not blanket: the informative fallback is
    // tried first and only dropped when it does not fit.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'done',
      data: {
        usage: { input_tokens: 7, output_tokens: 9 },
        cli_session_id: 'sess-1',
        permission_denials: ['x'.repeat(2 * 1024 * 1024)],
      },
    });

    const frame = JSON.parse(sent[0]!) as { data: Record<string, unknown> };

    expect(frame.data['usage']).toEqual({ input_tokens: 7, output_tokens: 9 });
    expect(frame.data['cli_session_id']).toBe('sess-1');
    expect(frame.data).not.toHaveProperty('permission_denials');
  });

  it('sends nothing at all when even the notice cannot fit', () => {
    // A request id larger than the cap leaves no correlatable frame to send.
    // Sending an oversized one anyway is the failure the guard exists to
    // prevent, and the connection matters more than this one request.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r'.repeat(2 * 1024 * 1024), event: 'block_delta',
      data: { block_index: 0, content: 'x'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(0);
  });

  it('sends nothing oversized for an error frame either', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'error',
      data: { code: 'provider_error', message: 'm'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(1);
    expect(Buffer.byteLength(sent[0]!, 'utf8')).toBeLessThanOrEqual(MAX);
    expect(JSON.parse(sent[0]!)).toMatchObject({ event: 'error', request_id: 'r1' });
  });
  it('reduces a frame it cannot even encode, instead of throwing', () => {
    // `send` runs inside a readline listener. An exception there is caught by
    // nothing and takes the process down — a worse outcome than any frame.
    const { bridge, sent } = bridgeWithFakeSocket();
    const circular: Record<string, unknown> = { block_index: 0 };
    circular['self'] = circular;

    expect(() => send(bridge, {
      type: 'stream', request_id: 'r1', event: 'block_delta', data: circular,
    })).not.toThrow();

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as { event: string; request_id: string; data: Record<string, unknown> };

    expect(frame.event).toBe('error');
    expect(frame.request_id).toBe('r1');
    expect(frame.data['code']).toBe('frame_too_large');
    expect(String(frame.data['message'])).toContain('could not encode');
  });

  it('still ends the turn when the terminal frame is the unencodable one', () => {
    const { bridge, sent } = bridgeWithFakeSocket();
    const usage: Record<string, unknown> = { input_tokens: 1 };
    usage['self'] = usage;

    expect(() => send(bridge, {
      type: 'stream', request_id: 'r1', event: 'done',
      data: { usage, cli_session_id: 'sess-1' },
    })).not.toThrow();

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as { event: string; data: Record<string, unknown> };

    // The first fallback carries the circular usage and cannot be encoded
    // either; the second drops it, so the turn still ends.
    expect(frame.event).toBe('done');
    expect(frame.data['usage']).toBeNull();
  });

  it('says how far over the limit the frame was', () => {
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'tool_result',
      data: { tool_call_id: 't1', result: 'x'.repeat(2 * 1024 * 1024) },
    });

    const frame = JSON.parse(sent[0]!) as { data: Record<string, unknown> };
    expect(String(frame.data['message'])).toMatch(/\d{7} bytes/);
  });
});

describe('a fallback frame must be well-formed, not merely small', () => {
  it('does not emit half a surrogate pair in a terminal error frame', () => {
    // `slice` cuts at a UTF-16 code unit. Half a pair is escaped by
    // JSON.stringify to a literal \ud83d — valid UTF-8, valid-looking, and
    // rejected OUTRIGHT by PHP's json_decode. That destroys the terminal frame
    // this path exists to guarantee, and the request hangs to timeout anyway.
    // `trySend` measures size; nothing measured well-formedness.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'error',
      data: { code: 'provider_error', message: 'a'.repeat(1999) + '😀' + 'b'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(1);
    const message = String((JSON.parse(sent[0]!) as { data: Record<string, unknown> }).data['message']);

    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(message)).toBe(false);
    expect(/(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(message)).toBe(false);
  });

  it('does not put a lone surrogate back by slicing AFTER scrubbing', () => {
    // Order matters and was inconsistent: `message` sliced then scrubbed,
    // `code` scrubbed then sliced. Scrubbing first approves a pair the slice
    // then cuts in half, so the terminal frame carries a lone surrogate after
    // all — the exact failure the scrub was added to prevent.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'error',
      // The emoji straddles the 200-code-unit cut.
      data: { code: 'c'.repeat(199) + '😀', message: 'm'.repeat(2 * 1024 * 1024) },
    });

    expect(sent).toHaveLength(1);
    const code = String((JSON.parse(sent[0]!) as { data: Record<string, unknown> }).data['code']);

    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(code)).toBe(false);
    expect(/(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(code)).toBe(false);
  });

  it('bounds the error code as well as the message', () => {
    // Copied onto the same frame verbatim, an oversized code puts the terminal
    // back over the cap by another route.
    const { bridge, sent } = bridgeWithFakeSocket();

    send(bridge, {
      type: 'stream', request_id: 'r1', event: 'error',
      data: { code: 'c'.repeat(2 * 1024 * 1024), message: 'short' },
    });

    expect(sent).toHaveLength(1);
    expect(Buffer.byteLength(sent[0]!, 'utf8')).toBeLessThanOrEqual(900 * 1024);
  });
});
