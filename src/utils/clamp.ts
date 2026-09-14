/**
 * Clamping utilities for server-provided configuration values.
 *
 * Shared by the bridge and the test suite so both exercise the same
 * constants and logic.
 */

/**
 * Accepted range for the server-provided request_timeout (seconds).
 *
 * The ceiling was an hour, and an hour is a real limit for agentic work —
 * migrations, large refactors and multi-step research pass it. It is a WALL
 * clock, so it cannot tell a stuck CLI from a busy one; the silence bound below
 * does that job, and does it at a far lower value. So this one is free to be a
 * genuine backstop rather than the shortest clock in the chain.
 */
export const REQUEST_TIMEOUT_MIN_S = 10;
export const REQUEST_TIMEOUT_MAX_S = 86400;

/**
 * Accepted range for the server-provided silence_timeout (seconds).
 *
 * Low enough that a wedged CLI is noticed, high enough that a build or a test
 * suite finishes. A server that wants the bridge to stop bounding turns at all
 * sends 0 for both this and request_timeout and takes responsibility itself.
 */
export const SILENCE_TIMEOUT_MIN_S = 10;
export const SILENCE_TIMEOUT_MAX_S = 86400;

/** Accepted range for the server-provided heartbeat_interval (seconds). */
export const HEARTBEAT_MIN_S = 5;
export const HEARTBEAT_MAX_S = 300;

/**
 * Clamp a raw request_timeout value (in seconds) from the server welcome
 * message into the acceptable range, or 0 to disable it.
 */
/**
 * A timeout value from a welcome message, as a number of seconds, or null.
 *
 * The payload is asserted into shape rather than validated, so this is where
 * shape is actually checked. A numeric STRING is accepted — `"300"` meant 300
 * before this change, via `Math.max`'s coercion, and must keep meaning it.
 * Anything else is null, so the caller keeps its default instead of guessing.
 * `null` in particular must not become `Number(null)`, which is 0 — "no bound".
 */
export function toSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);

    return Number.isFinite(n) ? n : null;
  }

  return null;
}

export function clampRequestTimeout(raw: number): number {
  // A last-resort guard only: the bridge runs values through toSeconds() first
  // and keeps its DEFAULT for anything unusable. Here, a non-finite value would
  // otherwise become NaN, which both timers treat as disabled.
  const n = toSeconds(raw);
  if (n === null) return REQUEST_TIMEOUT_MIN_S;
  raw = n;

  // Zero means the server is taking responsibility for bounding the turn, and
  // clamping it up to ten seconds would turn "no ceiling" into the most
  // aggressive one available.
  if (raw === 0) return 0;

  return Math.min(Math.max(raw, REQUEST_TIMEOUT_MIN_S), REQUEST_TIMEOUT_MAX_S);
}

/** Clamp a raw silence_timeout, with zero meaning "do not bound silence". */
export function clampSilenceTimeout(raw: number): number {
  const n = toSeconds(raw);
  if (n === null) return SILENCE_TIMEOUT_MIN_S;
  raw = n;
  if (raw === 0) return 0;

  return Math.min(Math.max(raw, SILENCE_TIMEOUT_MIN_S), SILENCE_TIMEOUT_MAX_S);
}

/**
 * Clamp a raw heartbeat_interval value (in seconds) from the server welcome
 * message into the acceptable range [5, 300].
 */
export function clampHeartbeat(raw: number): number {
  return Math.min(Math.max(raw, HEARTBEAT_MIN_S), HEARTBEAT_MAX_S);
}
