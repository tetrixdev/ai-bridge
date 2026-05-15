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
