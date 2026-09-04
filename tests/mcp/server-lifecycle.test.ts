/**
 * When the bridge's MCP server is safe to use.
 *
 * `start()` assigns the HTTP server synchronously and only learns its port on
 * the listen callback, so "is it running" has a window in which the object
 * exists and `getBaseUrl()` still throws. A server that sends `welcome` and
 * `ai_request` back to back lands in it.
 */

import { describe, it, expect } from 'vitest';
import { BridgeMcpServer } from '../../src/mcp/server.js';

describe('isRunning', () => {
  it('is false before start', () => {
    expect(new BridgeMcpServer(async () => null).isRunning()).toBe(false);
  });

  it('is false while start is still binding the listener', async () => {
    const server = new BridgeMcpServer(async () => null);
    const starting = server.start();

    // Synchronously after the call: the HTTP object exists, the port does not.
    expect(server.isRunning()).toBe(false);

    await starting;
    expect(server.isRunning()).toBe(true);
    await server.stop();
  });

  it('never reports running while getBaseUrl would throw', async () => {
    const server = new BridgeMcpServer(async () => null);
    const starting = server.start();

    // The invariant that matters: anything trusting isRunning() can safely
    // call getBaseUrl(). Before the fix this pair diverged and the caller
    // failed the turn with "BridgeMcpServer not started" as a provider error.
    if (server.isRunning()) {
      expect(() => server.getBaseUrl()).not.toThrow();
    }

    await starting;
    expect(server.isRunning()).toBe(true);
    expect(() => server.getBaseUrl()).not.toThrow();
    await server.stop();
  });

  it('is false again after stop, and can be started again', async () => {
    const server = new BridgeMcpServer(async () => null);
    await server.start();
    await server.stop();
    expect(server.isRunning()).toBe(false);

    // Nothing is latched: the handshake starts the server on each reconnect
    // that needs it, so a stopped server must be startable again.
    await server.start();
    expect(server.isRunning()).toBe(true);
    await server.stop();
  });
});
