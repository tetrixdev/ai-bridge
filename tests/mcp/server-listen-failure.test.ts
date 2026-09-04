/**
 * What happens when the MCP server cannot bind its listener.
 *
 * Its own file because it mocks `node:http` for the whole module: the failure
 * is otherwise unreachable, since the server binds 127.0.0.1 on a random port
 * and there is nothing to collide with.
 *
 * The failure matters because the bridge retries on every reconnect. Leaving
 * the half-built server in place made the retry hit the "already started"
 * guard instead, so the operator saw that error rather than the real cause,
 * forever, and the tool channel never came back without a restart.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

let failNextListen = true;

vi.mock('node:http', () => ({
  createServer: () => {
    const server = new EventEmitter() as EventEmitter & {
      listen: (port: number, host: string, cb: () => void) => void;
      close: (cb?: () => void) => void;
      address: () => { port: number };
    };
    server.listen = (_port, _host, cb) => {
      if (failNextListen) {
        setImmediate(() => server.emit('error', new Error('EACCES: permission denied')));
        return;
      }
      setImmediate(cb);
    };
    server.close = (cb) => cb?.();
    server.address = () => ({ port: 54321 });
    return server;
  },
}));

const { BridgeMcpServer } = await import('../../src/mcp/server.js');

describe('a listener that will not bind', () => {
  it('reports the real cause and leaves nothing latched', async () => {
    failNextListen = true;
    const server = new BridgeMcpServer(async () => null);

    await expect(server.start()).rejects.toThrow(/EACCES/);
    expect(server.isRunning()).toBe(false);

    // The retry must reach `listen` again rather than the "already started"
    // guard — otherwise every reconnect reports the wrong error.
    await expect(server.start()).rejects.toThrow(/EACCES/);
  });

  it('recovers once the condition clears', async () => {
    failNextListen = true;
    const server = new BridgeMcpServer(async () => null);
    await expect(server.start()).rejects.toThrow(/EACCES/);

    failNextListen = false;
    await server.start();

    expect(server.isRunning()).toBe(true);
    expect(server.getBaseUrl()).toContain('54321');
    await server.stop();
  });
});
