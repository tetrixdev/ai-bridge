/**
 * How the bridge presents its token when it opens the socket. The token goes in
 * the Authorization header and nowhere else: a URL is written to every access
 * log between here and the server (a reverse proxy's in particular), and a
 * header is not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';

let wss: WebSocketServer | null = null;
let bridge: Bridge | null = null;

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  // The server sees the upgrade before the bridge sees 'open', so a disconnect
  // here can find the socket still connecting and leave it to the server.
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = null;
});

async function upgradeFor(path: string): Promise<IncomingMessage> {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss!.once('listening', r));
  const port = (wss.address() as AddressInfo).port;
  const seen = new Promise<IncomingMessage>((r) => wss!.once('connection', (_ws, req) => r(req)));
  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${port}${path}`,
    token: 'eng_secret-token-value',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
    sessionStorePath: null,
    allowedRoots: [],
  });
  bridge.connect();
  return seen;
}

describe('connecting', () => {
  it('sends the token as an Authorization: Bearer header', async () => {
    const req = await upgradeFor('/bridge?device=abc');
    expect(req.headers.authorization).toBe('Bearer eng_secret-token-value');
  });

  it('never puts the token in the URL, so no access log can record it', async () => {
    const req = await upgradeFor('/bridge?device=abc');
    expect(req.url).toBe('/bridge?device=abc');
    expect(req.url).not.toContain('secret-token-value');
  });

  it('leaves a server address without a query as it was', async () => {
    const req = await upgradeFor('/ws');
    expect(req.url).toBe('/ws');
  });
});

describe('a server address that carries a token', () => {
  it('is refused, rather than logged and sent where access logs keep it', () => {
    expect(() => new Bridge({
      serverUrl: 'wss://example.com/bridge?device=abc&token=eng_in-the-url',
      token: 'eng_secret-token-value',
      providers: [],
      adapters: new Map<string, ProviderAdapter>(),
      sessionStorePath: null,
      allowedRoots: [],
    })).toThrow(/--server.*token/);
  });

  it('says so without repeating the token', () => {
    try {
      new Bridge({
        serverUrl: 'wss://example.com/ws?token=eng_in-the-url',
        token: 't', providers: [], adapters: new Map<string, ProviderAdapter>(), sessionStorePath: null, allowedRoots: [],
      });
    } catch (err) {
      expect(String(err)).not.toContain('eng_in-the-url');
      return;
    }
    throw new Error('expected a refusal');
  });
});
