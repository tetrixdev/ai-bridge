/**
 * A tool result larger than one frame crosses in pieces rather than being cut.
 *
 * The size work in this area has been wrong three times in the same way: a
 * budget measured in the wrong unit. A chunk is measured as JSON encodes it,
 * because a code unit costs between one and six bytes once escaped, so these
 * tests drive the pathological encodings rather than only ASCII.
 */

import { describe, it, expect } from 'vitest';
import {
  toolResultFrames,
  toolResultEventData,
  MAX_RESULT_BYTES,
  MAX_TOTAL_RESULT_BYTES,
} from '../../src/providers/result-text.js';

/** What a string costs on the wire: its length once JSON has encoded it. */
const encoded = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8');
/** Join chunks back the way a consumer must: in order, with no separator. */
const reassemble = (frames: { result: string }[]) => frames.map((f) => f.result).join('');

describe('splitting a tool result', () => {
  it('leaves a small result in one frame with no chunk fields', () => {
    const frames = toolResultFrames('hello');

    expect(frames).toEqual([{ result: 'hello' }]);
  });

  it('leaves a result right at the ceiling in one frame', () => {
    // Off-by-one at the boundary is how a "fits" check becomes a "does not".
    let text = 'a'.repeat(MAX_RESULT_BYTES - 2);
    expect(encoded(text)).toBe(MAX_RESULT_BYTES);

    expect(toolResultFrames(text)).toHaveLength(1);

    text += 'a';
    expect(toolResultFrames(text).length).toBeGreaterThan(1);
  });

  it('reassembles to exactly the original', () => {
    const body = 'abcdefghij'.repeat(120_000);

    expect(reassemble(toolResultFrames(body))).toBe(body);
  });

  it('numbers the chunks and marks only the last as final', () => {
    const frames = toolResultFrames('x'.repeat(1_200_000));

    expect(frames.map((f) => f.chunk_index)).toEqual(frames.map((_, i) => i));
    expect(frames.slice(0, -1).every((f) => f.final === false)).toBe(true);
    expect(frames[frames.length - 1]!.final).toBe(true);
  });

  it('keeps every chunk within the per-frame budget, in ENCODED bytes', () => {
    for (const body of [
      'x'.repeat(1_000_000),                     // one byte a character
      'é'.repeat(500_000),                  // two
      '漢'.repeat(400_000),                  // three
      '𝄞'.repeat(300_000),            // a surrogate pair
      String.fromCharCode(1).repeat(400_000),    // SIX: a control character
      '"'.repeat(400_000),                       // two, escaped
      '\\'.repeat(400_000),                      // two, escaped
      '\n'.repeat(400_000),                      // two, escaped
    ]) {
      const frames = toolResultFrames(body);

      expect(reassemble(frames)).toBe(body);
      for (const frame of frames) {
        expect(encoded(frame.result)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      }
    }
  });

  it('never splits a surrogate pair across two chunks', () => {
    // Half a pair is a lone surrogate, which PHP's json_decode rejects
    // outright, so one would cost the whole frame rather than one character.
    const frames = toolResultFrames('𝄞'.repeat(300_000));

    for (const frame of frames) {
      const first = frame.result.charCodeAt(0);
      const last = frame.result.charCodeAt(frame.result.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);   // no leading half at the end
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no trailing half at the start
    }
  });

  it('stops at the total ceiling and says how much it dropped', () => {
    const body = 'x'.repeat(MAX_TOTAL_RESULT_BYTES + 500_000);
    const frames = toolResultFrames(body);
    const last = frames[frames.length - 1]!;

    expect(last.final).toBe(true);
    expect(last.truncated_bytes).toBeGreaterThan(0);
    expect(last.result).toContain('truncated by the bridge');

    // The notice is paid for OUT of the final chunk's budget, not added on top.
    // Appended on top it made the last chunk oversized, and an oversized chunk
    // does not merely lose the notice — it goes down the frame guard's fallback
    // path and the result never reassembles at all.
    for (const frame of frames) {
      expect(encoded(frame.result)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    }

    // Summed as JSON encodes it, because that is the unit the ceiling is
    // written in. A raw-byte sum does not test the documented limit at all, and
    // it hid that the truncation notice was being paid for out of the per-frame
    // budget only — so replacing the final frame could push the whole result
    // past the total ceiling.
    const carried = frames.reduce((n, f) => n + encoded(f.result), 0);
    expect(carried).toBeLessThanOrEqual(MAX_TOTAL_RESULT_BYTES);
  });

  it('does not claim a truncation that did not happen', () => {
    const frames = toolResultFrames('x'.repeat(1_000_000));

    expect(frames.every((f) => f.truncated_bytes === undefined)).toBe(true);
    expect(reassemble(frames)).not.toContain('truncated by the bridge');
  });

  it('splits an empty result into one empty frame, not none', () => {
    expect(toolResultFrames('')).toEqual([{ result: '' }]);
  });
});

describe('the event data a provider emits', () => {
  it('puts the verdict on every chunk', () => {
    // A turn cut short mid-result still tells the consumer it is looking at a
    // failure, which is when knowing that matters most.
    const data = toolResultEventData('t1', 'x'.repeat(1_000_000), true);

    expect(data.length).toBeGreaterThan(1);
    expect(data.every((d) => d['is_error'] === true)).toBe(true);
    expect(data.every((d) => d['tool_call_id'] === 't1')).toBe(true);
  });

  it('claims no verdict when none was reported', () => {
    const data = toolResultEventData('t1', 'ok');

    expect(data).toEqual([{ tool_call_id: 't1', result: 'ok' }]);
  });

  it('scrubs a lone surrogate before splitting, not after', () => {
    // Scrubbing per chunk would let one straddle a boundary and survive.
    const data = toolResultEventData('t1', 'a\ud83db'.repeat(200_000));

    for (const d of data) {
      expect(String(d['result'])).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    }
  });
});

describe('the cut that arithmetic chooses, not the one that fits', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

  it('never emits a lone surrogate, even where the ratio search gives up', () => {
    // A dense run of control characters followed by ordinary text makes the
    // exact-ratio correction converge too slowly to finish, so the length comes
    // from the fallback floor. That floor returned a RAW code-unit count, so
    // the cut landed mid-pair: JSON.stringify escapes each half to a literal
    // \ud83d and PHP's json_decode rejects the WHOLE frame — both chunks either
    // side of the split lost, not one character. Measured at 87% of one result.
    const bodies = [
      String.fromCharCode(1).repeat(40_000) + 'a'.repeat(3689) + '\u{1D11E}' + 'a'.repeat(400_000),
      'a'.repeat(20_000) + String.fromCharCode(7).repeat(60_000) + '😀'.repeat(100_000),
      String.fromCharCode(1).repeat(55_000) + '😀'.repeat(120_000),
    ];

    for (const body of bodies) {
      const frames = toolResultFrames(body);

      expect(reassemble(frames)).toBe(body);
      for (const frame of frames) {
        expect(lone.test(frame.result)).toBe(false);
        expect(encoded(frame.result)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      }
    }
  });

  it('holds across byte-shifted variants of the same content', () => {
    // One index passing proves nothing: the split depends on where the pair
    // happens to land. Shifting the prefix by one byte at a time walks the
    // boundary across every offset within a pair.
    for (let shift = 0; shift < 8; shift++) {
      const body = String.fromCharCode(1).repeat(40_000)
        + 'a'.repeat(3689 + shift)
        + '𝄞'.repeat(50_000);
      const frames = toolResultFrames(body);

      expect(reassemble(frames)).toBe(body);
      expect(frames.some((f) => lone.test(f.result))).toBe(false);
    }
  });
});
