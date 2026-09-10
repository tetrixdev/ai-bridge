/**
 * Bounding a tool result to what the wire can actually carry.
 *
 * The server's cap is on BYTES; an earlier version of this bounded on UTF-16
 * code units, which is a different quantity by up to 6x. Worse than it sounds:
 * an oversized frame is not dropped, it is answered with a CLOSE_TOO_BIG and
 * the connection is torn down — taking every other in-flight request on that
 * bridge with it.
 */

import { describe, it, expect } from 'vitest';
import { boundArguments, boundResult, safeStringify, replaceLoneSurrogates, MAX_RESULT_BYTES } from '../../src/providers/result-text.js';

/** What the whole stream frame costs once encoded, as bridge.ts sends it. */
function frameBytes(result: string): number {
  return Buffer.byteLength(JSON.stringify({
    type: 'stream',
    request_id: 'req_abc123',
    event: 'tool_result',
    data: { tool_call_id: 'toolu_01SXtmUHX3mr4tSyyHMNNxsv', result },
  }), 'utf8');
}

const SERVER_FRAME_CAP = 1024 * 1024;

/**
 * An INDEPENDENT well-formedness check.
 *
 * Deliberately not `replaceLoneSurrogates(t) === t`, which is what this was
 * first written as: defining the check in terms of the function under test
 * makes every assertion using it a tautology, and substituting a no-op for the
 * implementation left them all passing. Scans for an unpaired surrogate
 * directly.
 */
function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    }
  }

  return true;
}

describe('boundResult', () => {
  it('leaves an ordinary result untouched', () => {
    expect(boundResult('hello')).toBe('hello');
  });

  it.each([
    ['ascii', 'z'],
    ['cyrillic', String.fromCodePoint(0x434)],
    ['cjk', String.fromCodePoint(0x4e16)],
    ['backslash', String.fromCodePoint(92)],
    ['newline', String.fromCodePoint(10)],
    ['control character', String.fromCodePoint(1)],
    ['astral emoji', String.fromCodePoint(0x1f600)],
  ])('keeps the frame under the server cap for %s content', (_name, ch) => {
    // The previous bound was on `.length`, so it passed for ascii and blew the
    // cap for every one of the others — cyrillic and emoji by exactly 1x,
    // control characters by 3x. Only a byte measurement catches that, which is
    // why this asserts on the encoded frame rather than the string length.
    const huge = ch.repeat(Math.ceil((2 * 1024 * 1024) / ch.length));

    const bounded = boundResult(huge);

    expect(frameBytes(bounded)).toBeLessThan(SERVER_FRAME_CAP);
    expect(bounded).toContain('truncated by the bridge');
  });

  it('reports the original length, not the kept length', () => {
    const huge = 'z'.repeat(2 * 1024 * 1024);
    expect(boundResult(huge)).toContain(`of ${huge.length} characters`);
  });

  it('counts its own marker inside the budget', () => {
    const bounded = boundResult(String.fromCodePoint(0x4e16).repeat(400_000));
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('always produces a string PHP can decode', () => {
    // An invariant, not a guard test. A lone high surrogate would make PHP's
    // json_decode reject the WHOLE message — the result lost behind a protocol
    // error pointing nowhere near the size. The search cannot currently produce
    // one (splitting a pair costs more than keeping it), so this holds today by
    // construction; it is here so that a future change to the search cannot
    // quietly break it.
    for (let pad = 0; pad < 8; pad++) {
      const text = 'a'.repeat(pad) + String.fromCodePoint(0x1f600).repeat(400_000);
      const bounded = boundResult(text);

      expect(isWellFormed(bounded), `lone surrogate with ${pad} bytes of padding`).toBe(true);
      expect(JSON.parse(JSON.stringify(bounded))).toBe(bounded);
    }
  });

  it('keeps as much as it can rather than giving up early', () => {
    const bounded = boundResult('z'.repeat(2 * 1024 * 1024));
    // Comfortably more than half the byte budget put to use.
    expect(bounded.length).toBeGreaterThan(MAX_RESULT_BYTES / 2);
  });
});

describe('replaceLoneSurrogates', () => {
  it('leaves ordinary text alone', () => {
    const text = `plain ${String.fromCodePoint(0x1f600)} text`;
    expect(replaceLoneSurrogates(text)).toBe(text);
  });

  it('replaces a lone surrogate that arrived in the INPUT', () => {
    // Not only at the cut. A CLI line containing a bare \ud83d escape parses
    // to exactly this, and PHP then rejects the whole message.
    const text = `a${String.fromCharCode(0xd83d)}b`;
    const cleaned = replaceLoneSurrogates(text);

    expect(isWellFormed(cleaned)).toBe(true);
    expect(cleaned).toBe(`a\ufffdb`);
  });

  it('replaces a lone LOW surrogate too', () => {
    expect(isWellFormed(replaceLoneSurrogates(`a${String.fromCharCode(0xdc00)}b`))).toBe(true);
  });

  it('replaces a high surrogate at the very end', () => {
    expect(isWellFormed(replaceLoneSurrogates(`ab${String.fromCharCode(0xd83d)}`))).toBe(true);
  });

  it('carries a lone surrogate out of a bounded result', () => {
    const text = String.fromCharCode(0xd83d) + 'a'.repeat(400_000);
    expect(isWellFormed(boundResult(text))).toBe(true);
  });
});

describe('safeStringify', () => {
  it('encodes ordinary values', () => {
    expect(safeStringify({ a: 1 }, 'fallback')).toBe('{"a":1}');
  });

  it('falls back rather than throwing on a structure too deep to encode', () => {
    // JSON.parse is iterative and accepts this; JSON.stringify is recursive and
    // does not. The asymmetry is what makes a line the adapter already accepted
    // able to kill the process while being encoded.
    const deep = JSON.parse('['.repeat(6000) + '1' + ']'.repeat(6000));
    expect(safeStringify(deep, '{}')).toBe('{}');
  });

  it('falls back when the value encodes to undefined', () => {
    expect(safeStringify(undefined, '{}')).toBe('{}');
  });
});

describe('boundArguments', () => {
  it('leaves ordinary arguments as plain JSON', () => {
    expect(boundArguments({ file_path: '/a', n: 1 })).toBe(JSON.stringify({ file_path: '/a', n: 1 }));
  });

  it('keeps the small keys and replaces only the oversized value', () => {
    // The whole point. Truncating the encoded text loses every argument
    // including `file_path`, which is twenty bytes and the most useful field
    // there is for working out what a turn actually did.
    const args = { file_path: '/etc/passwd', mode: 'overwrite', content: 'x'.repeat(2_000_000) };

    const parsed = JSON.parse(boundArguments(args)) as Record<string, unknown>;

    expect(parsed['file_path']).toBe('/etc/passwd');
    expect(parsed['mode']).toBe('overwrite');
    expect(parsed['content']).toHaveProperty('__truncated__');
  });

  it('stays valid JSON, which truncating the text cannot', () => {
    const bounded = boundArguments({ a: 'y'.repeat(2_000_000) });
    expect(() => JSON.parse(bounded)).not.toThrow();
  });

  it('says how big the value really was, and shows its start', () => {
    const parsed = JSON.parse(boundArguments({ body: 'abcdefgh'.repeat(300_000) })) as
      { body: { __truncated__: { bytes: number; head: string } } };

    expect(parsed.body.__truncated__.bytes).toBeGreaterThan(2_000_000);
    expect(parsed.body.__truncated__.head.startsWith('abcdefgh')).toBe(true);
  });

  it('sacrifices the fewest fields it can', () => {
    // Largest first: one oversized value goes, the other large-but-affordable
    // one stays.
    const parsed = JSON.parse(boundArguments({
      big: 'x'.repeat(2_000_000),
      small: 'y'.repeat(1000),
    })) as Record<string, unknown>;

    expect(parsed['big']).toHaveProperty('__truncated__');
    expect(parsed['small']).toBe('y'.repeat(1000));
  });

  it('falls back to bounding the text when there are no keys to preserve', () => {
    const bounded = boundArguments('z'.repeat(2_000_000));
    expect(bounded).toContain('truncated by the bridge');
  });

  it('keeps the frame under the server cap', () => {
    const bounded = boundArguments({ content: String.fromCodePoint(0x4e16).repeat(1_000_000) });
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(SERVER_FRAME_CAP);
  });
});
