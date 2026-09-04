/**
 * Custom error types for the AI Bridge.
 */

/**
 * A fatal error that cannot be recovered from and should cause the bridge
 * to exit. Used for conditions like invalid/expired tokens or reconnect
 * exhaustion where retrying would be pointless.
 */
export class FatalBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalBridgeError';
  }
}

/**
 * A turn the bridge declines to run, carrying the stream-event code the
 * server should see.
 *
 * Distinct from a provider failure on purpose. `executeAiRequestInternal()`
 * translates a bare rejection on a *resume* into `session_lost`, which tells
 * the server to wipe the stored CLI session and silently re-issue the turn —
 * exactly the wrong response to "you asked for a directory you are not allowed
 * to have", which would then be retried forever. A refusal is terminal: it is
 * reported with its own code and the turn ends.
 */
export class RequestRefusal extends Error {
  constructor(
    /** Stream-event error code, e.g. `working_dir_not_allowed`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestRefusal';
  }
}
