/**
 * A turn is bounded by SILENCE, not by how long it has been working.
 *
 * The wall clock cannot tell the two apart. A turn that had streamed 370 events
 * — tool calls and their results, visibly working — was killed at exactly 300
 * seconds, and the person saw a reply that simply stopped. Punctuality is the
 * tell: a crash is never that precise.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { startTurnTimeouts } from '../../src/providers/timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('the clock that measures silence', () => {
  it('does not fire while the turn keeps producing events', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 0, onFire });

    // Nine seconds of quiet, then an event — thirty times over. Five minutes of
    // continuous work, which is the healthiest state a long turn has.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(9_000);
      timeouts.notice();
    }

    expect(onFire).not.toHaveBeenCalled();
    expect(timeouts.reason()).toBeNull();
  });

  it('fires when the turn actually goes quiet', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 0, onFire });

    timeouts.notice();
    vi.advanceTimersByTime(10_001);

    expect(onFire).toHaveBeenCalledWith('silence_timeout_exceeded', 10);
    expect(timeouts.reason()).toBe('silence_timeout_exceeded');
    expect(timeouts.limit()).toBe(10);
  });

  it('still honours a wall clock when the server asks for one', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    // Busy the whole time: an event every second, so silence never fires.
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 30, onFire });

    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(1_000);
      timeouts.notice();
    }
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(onFire).toHaveBeenCalledWith('request_timeout_exceeded', 30);
  });

  it('kills once, and reports the reason that actually killed it', () => {
    // Both clocks can land together. Firing twice would kill a process that is
    // already dying and report the second reason for the first decision.
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 10, onFire });

    vi.advanceTimersByTime(60_000);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]![0]).toBe('silence_timeout_exceeded');
  });

  it('bounds nothing when the server takes responsibility for both', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 0, requestSeconds: 0, onFire });

    vi.advanceTimersByTime(48 * 60 * 60 * 1000);

    expect(onFire).not.toHaveBeenCalled();
    expect(timeouts.reason()).toBeNull();
  });

  it('stops both clocks when the turn ends normally', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 20, onFire });

    timeouts.cancel();
    vi.advanceTimersByTime(60_000);

    expect(onFire).not.toHaveBeenCalled();
  });

  it('ignores a late event from a turn already killed', () => {
    // Re-arming after the kill would leave a timer running against a dead
    // process and, worse, could fire a second reason.
    vi.useFakeTimers();
    const onFire = vi.fn();
    const timeouts = startTurnTimeouts({ silenceSeconds: 10, requestSeconds: 0, onFire });

    vi.advanceTimersByTime(10_001);
    timeouts.notice();
    vi.advanceTimersByTime(60_000);

    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
