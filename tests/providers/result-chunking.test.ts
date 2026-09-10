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

    const carried = frames.reduce((n, f) => n + Buffer.byteLength(f.result, 'utf8'), 0);
    // The notice sits on top of the carried content, so allow for it.
    expect(carried).toBeLessThanOrEqual(MAX_TOTAL_RESULT_BYTES + 200);
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
