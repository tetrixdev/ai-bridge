import { describe, it, expect } from 'vitest';
import { SessionWorkingDirs } from '../../src/workspace/sessions.js';

describe('SessionWorkingDirs', () => {
  it('remembers where a session was started', () => {
    const s = new SessionWorkingDirs();
    s.remember('sess-1', '/repos/a');
    expect(s.get('sess-1')).toBe('/repos/a');
  });

  it('returns undefined for a session it never saw', () => {
    // The position a freshly restarted bridge is in: it cannot detect a change
    // it has no record of, and resuming is the right answer there.
    expect(new SessionWorkingDirs().get('sess-x')).toBeUndefined();
  });

  it('forgets on request', () => {
    const s = new SessionWorkingDirs();
    s.remember('sess-1', '/repos/a');
    s.forget('sess-1');
    expect(s.get('sess-1')).toBeUndefined();
  });

  it('evicts the oldest entries past its capacity', () => {
    const s = new SessionWorkingDirs(3);
    s.remember('a', '/1');
    s.remember('b', '/2');
    s.remember('c', '/3');
    s.remember('d', '/4');
    expect(s.size).toBe(3);
    expect(s.get('a')).toBeUndefined();
    expect(s.get('d')).toBe('/4');
  });

  it('refreshes an entry position when re-recorded', () => {
    const s = new SessionWorkingDirs(3);
    s.remember('a', '/1');
    s.remember('b', '/2');
    s.remember('a', '/1');
    s.remember('c', '/3');
    s.remember('d', '/4');
    // 'b' was the least recently recorded, so it is the one that goes.
    expect(s.get('b')).toBeUndefined();
    expect(s.get('a')).toBe('/1');
  });
});
