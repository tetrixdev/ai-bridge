/**
 * Secrets on the machine through the whole Bridge: hello.machine_secrets, one
 * secret_result per request, and the value never in a frame sent back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { MachineSecretStore } from '../../src/secrets/store.js';

const VALUE = 'Zq8-not-a-real-secret-4471';

let wss: WebSocketServer;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let raw: string[];
let bridge: Bridge | null = null;
let dir: string;
let store: string;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string, ms = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  raw = [];
  dir = mkdtempSync(join(tmpdir(), 'aib-secrets-'));
  store = join(dir, '.secrets');
  mkdirSync(store, { mode: 0o700 });
  const bin = join(dir, 'secret');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), store = ${JSON.stringify(store)};
if (a[0] === 'list') process.stdout.write(JSON.stringify(fs.readdirSync(store).filter((n) => !n.startsWith('.')).map((n) => ({ name: n, description: null, updated_at: '2026-11-21' }))));
else if (a[0] === 'add') fs.renameSync(a[2], path.join(store, a[1]));
else if (a[0] === 'remove') { process.stderr.write("secret: no secret named '" + a[1] + "'\\n"); process.exit(1); }
`);
  chmodSync(bin, 0o755);

  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      raw.push(data.toString());
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });

  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map(),
    sessionStorePath: null,
    allowedRoots: [{ path: tmpdir(), label: 'tmp' }],
  });
  (bridge as unknown as { secretStore: MachineSecretStore }).secretStore = new MachineSecretStore({ bin, store });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('machine secrets', () => {
  it('announces machine_secrets revision 1 in the hello', () => {
    expect(frames.find((f) => f['type'] === 'hello')!['machine_secrets']).toEqual({ revision: 1 });
  });

  it('stores a secret_put and answers ok, without the value in anything it sends', async () => {
    socket.send(JSON.stringify({ type: 'secret_put', id: 'sec-1', name: 'mailtrap', description: 'SMTP', value: VALUE }));
    const result = await waitFor((f) => f['type'] === 'secret_result' && f['id'] === 'sec-1', 'secret_result');

    expect(result).toEqual({ type: 'secret_result', id: 'sec-1', ok: true });
    expect(readFileSync(join(store, 'mailtrap'), 'utf8')).toBe(VALUE);
    expect(raw.join('\n')).not.toContain(VALUE);
  });

  it('lists the store', async () => {
    writeFileSync(join(store, 'github-token'), 'x');
    socket.send(JSON.stringify({ type: 'secret_list', id: 'sec-2' }));
    const result = await waitFor((f) => f['type'] === 'secret_result' && f['id'] === 'sec-2', 'secret_result');

    expect(result['secrets']).toEqual([{ name: 'github-token', description: null, updated_at: '2026-11-21' }]);
  });

  it('answers a refusal once, with a code', async () => {
    socket.send(JSON.stringify({ type: 'secret_remove', id: 'sec-3', name: 'gone' }));
    socket.send(JSON.stringify({ type: 'secret_put', id: 'sec-4', name: '../escape', value: VALUE }));
    const removed = await waitFor((f) => f['type'] === 'secret_result' && f['id'] === 'sec-3', 'remove result');
    const refused = await waitFor((f) => f['type'] === 'secret_result' && f['id'] === 'sec-4', 'put result');

    expect(removed).toMatchObject({ ok: false, code: 'not_found' });
    expect(refused).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(frames.filter((f) => f['id'] === 'sec-3')).toHaveLength(1);
    expect(raw.join('\n')).not.toContain(VALUE);
  });
});
