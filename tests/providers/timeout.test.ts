import { describe, it, expect, vi } from 'vitest';
import { startRequestTimeout, clearRequestTimeout } from '../../src/providers/timeout.js';

describe('Request timeout helper', () => {
  it('fires onTimeout after the configured number of seconds', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = startRequestTimeout(2, onTimeout);

    vi.advanceTimersByTime(1_999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledOnce();

    handle.cancel();
    vi.useRealTimers();
  });

  it('cancel() prevents the timeout from firing', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = startRequestTimeout(5, onTimeout);
    handle.cancel();

    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('cancel() is idempotent', () => {
    const handle = startRequestTimeout(5, () => undefined);
    handle.cancel();
    expect(() => handle.cancel()).not.toThrow();
  });

  it('non-positive seconds disables the timer (no-op handle)', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    startRequestTimeout(0, onTimeout);
    startRequestTimeout(-1, onTimeout);
    startRequestTimeout(NaN, onTimeout);

    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('clearRequestTimeout(handle) is the same as handle.cancel()', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = startRequestTimeout(2, onTimeout);
    clearRequestTimeout(handle);

    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
