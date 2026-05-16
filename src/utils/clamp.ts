/**
 * Clamping utilities for server-provided configuration values.
 *
 * Shared by the bridge and the test suite so both exercise the same
 * constants and logic.
 */

/** Accepted range for the server-provided request_timeout (seconds). */
export const REQUEST_TIMEOUT_MIN_S = 10;
export const REQUEST_TIMEOUT_MAX_S = 3600;

/** Accepted range for the server-provided heartbeat_interval (seconds). */
export const HEARTBEAT_MIN_S = 5;
export const HEARTBEAT_MAX_S = 300;

/**
 * Clamp a raw request_timeout value (in seconds) from the server welcome
 * message into the acceptable range [10, 3600].
 */
export function clampRequestTimeout(raw: number): number {
  return Math.min(Math.max(raw, REQUEST_TIMEOUT_MIN_S), REQUEST_TIMEOUT_MAX_S);
}

/**
 * Clamp a raw heartbeat_interval value (in seconds) from the server welcome
 * message into the acceptable range [5, 300].
 */
export function clampHeartbeat(raw: number): number {
  return Math.min(Math.max(raw, HEARTBEAT_MIN_S), HEARTBEAT_MAX_S);
}
