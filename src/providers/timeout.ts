/**
 * Per-request timeout helper for provider adapters.
 *
 * The server sends `request_timeout` (seconds) in the welcome config; each
 * adapter arms a timer for the duration of its CLI subprocess and kills the
 * process if the timer fires. Before this helper existed (ai-bridge#2) the
 * value was stored but never enforced, so a stuck CLI would run forever.
 */

/** Handle returned by startRequestTimeout. */
export interface RequestTimeoutHandle {
  /** Cancel the timer if it has not yet fired. Idempotent. */
  cancel(): void;
}

/**
 * Arm a timer that fires `onTimeout` after `seconds` real-world seconds. A
 * non-positive `seconds` value disables the timer entirely (returns a no-op
 * handle), so adapters do not need to special-case "no timeout".
 *
 * The seconds value is clamped at the source (clampRequestTimeout) so this
 * function trusts what it gets.
 */
export function startRequestTimeout(
  seconds: number,
  onTimeout: () => void,
): RequestTimeoutHandle {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { cancel: () => undefined };
  }
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    onTimeout();
  }, seconds * 1000);
  // Unref so a fired-and-forgotten timer can never keep the Node process
  // alive past the rest of the bridge shutting down.
  timer.unref?.();
  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Alias kept for readability at call sites. */
export function clearRequestTimeout(handle: RequestTimeoutHandle): void {
  handle.cancel();
}
