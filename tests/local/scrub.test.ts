import { describe, expect, it } from 'vitest';
import { scrub } from '../../src/local/scrub.js';

describe('scrubbing secrets out of tool output', () => {
  it('names which secret was removed, so a redaction is not mistaken for a bug', () => {
    expect(scrub('connecting with hunter2xyz now', [{ name: 'DB_PASSWORD', value: 'hunter2xyz' }]))
      .toBe('connecting with [redacted: DB_PASSWORD] now');
  });

  it('removes every occurrence, not the first', () => {
    const out = scrub('abcd1234 then abcd1234', [{ name: 'K', value: 'abcd1234' }]);
    expect(out).toBe('[redacted: K] then [redacted: K]');
  });

  it('redacts the longest value first, or a fragment of it survives', () => {
    // 'sk-live-abc' contains 'sk-live'. Replacing the short one first would
    // rewrite the middle of the long one, leaving '-abc' in the output with
    // nothing left to match against.
    const out = scrub('token sk-live-abc here', [
      { name: 'SHORT', value: 'sk-live' },
      { name: 'LONG', value: 'sk-live-abc' },
    ]);
    expect(out).toBe('token [redacted: LONG] here');
    expect(out).not.toContain('-abc');
  });

  it('ignores very short values rather than redacting the output into noise', () => {
    // A three-character secret matches everywhere. Blanking the whole result
    // hides the answer and protects nothing that was not already visible.
    expect(scrub('the cat sat on the mat', [{ name: 'TINY', value: 'at' }]))
      .toBe('the cat sat on the mat');
  });

  it('is honest about its limits: a transformed value passes straight through', () => {
    // Documented, not a bug. This is why the design calls scrubbing hygiene
    // rather than containment, and why tool approval is the actual control.
    const encoded = Buffer.from('hunter2xyz').toString('base64');
    expect(scrub(encoded, [{ name: 'DB_PASSWORD', value: 'hunter2xyz' }])).toBe(encoded);
  });
});
