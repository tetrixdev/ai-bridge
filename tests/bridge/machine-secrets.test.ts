/**
 * Machine secrets over a real WebSocket (decision 0020): off unless the
 * operator named a secret command, and then one `secret_result` per frame,
 * never carrying a value, with the value nowhere in the bridge's log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { closeLogFile, setLogFile } from '../../src/utils/logger.js';
import { makeFakeCommand, type FakeCommand } from '../secrets/fake-command.js';

const VALUE = 'pw-0123456789-do-not-log';

let wss: WebSocketServer | null = null;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let fake: FakeCommand | null = null;
let logDir: string | null = null;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connect(secretCommand?: string): Promise<Record<string, unknown>> {
  frames = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  server.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
  bridge = new Bridge({
    serverUrl: url, token: 'tok', sessionStorePath: null, providers: [], adapters: new Map(),
    ...(secretCommand ? { secretCommand } : {}),
  });
  bridge.connect();
  const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({ type: 'welcome', session_id: 'conn-1', tools: [], config: { heartbeat_interval: 30, request_timeout: 30 } }));
  return hello;
}

async function ask(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `s_${Math.random().toString(36).slice(2, 8)}`;
  socket.send(JSON.stringify({ ...frame, id }));
  return waitFor((f) => f['type'] === 'secret_result' && f['id'] === id, `secret_result ${id}`);
}

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  wss = null;
  fake?.cleanup();
  fake = null;
  closeLogFile();
  if (logDir) rmSync(logDir, { recursive: true, force: true });
  logDir = null;
});

describe('a bridge without --secret-command', () => {
  it('does not announce machine_secrets, and does announce the 16 KB prompt cap', async () => {
    const hello = await connect();
    expect(hello).not.toHaveProperty('machine_secrets');
    expect(hello['bridge_prompt_max_bytes']).toBe(16384);
  });

  it('refuses every secret_* frame with machine_secrets_unsupported', async () => {
    await connect();
    for (const frame of [
      { type: 'secret_list' },
      { type: 'secret_put', name: 'k', value: VALUE },
      { type: 'secret_describe', name: 'k', description: 'd' },
      { type: 'secret_remove', name: 'k' },
    ]) {
      const result = await ask(frame);
      expect(result).toMatchObject({ ok: false, code: 'machine_secrets_unsupported' });
      expect(JSON.stringify(result)).not.toContain(VALUE);
    }
  });
});

describe('a bridge with --secret-command', () => {
  it('announces machine_secrets revision 2', async () => {
    fake = makeFakeCommand();
    const hello = await connect(fake.path);
    expect(hello['machine_secrets']).toEqual({ revision: 2 });
  });

  it('puts, refuses a second put as exists, replaces, lists, describes and removes; the value is in no answer and no log line', async () => {
    fake = makeFakeCommand();
    logDir = mkdtempSync(join(tmpdir(), 'secrets-log-'));
    const logFile = join(logDir, 'bridge.log');
    setLogFile(logFile);
    await connect(fake.path);

    expect(await ask({ type: 'secret_put', name: 'db_password', value: VALUE, description: 'Postgres' }))
      .toMatchObject({ ok: true, replaced: false });
    expect(await ask({ type: 'secret_put', name: 'db_password', value: 'other' }))
      .toMatchObject({ ok: false, code: 'exists' });
    expect(await ask({ type: 'secret_put', name: 'db_password', value: VALUE, replace: true }))
      .toMatchObject({ ok: true, replaced: true });
    const listed = await ask({ type: 'secret_list' });
    expect(listed).toMatchObject({ ok: true, secrets: [{ name: 'db_password', description: 'Postgres' }] });
    expect(await ask({ type: 'secret_describe', name: 'db_password', description: 'Postgres, production' }))
      .toMatchObject({ ok: true });
    expect(await ask({ type: 'secret_remove', name: 'db_password' })).toMatchObject({ ok: true });
    expect(await ask({ type: 'secret_remove', name: 'db_password' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await ask({ type: 'secret_put', name: '../etc', value: VALUE })).toMatchObject({ ok: false, code: 'invalid_name' });

    const answers = JSON.stringify(frames.filter((f) => f['type'] === 'secret_result'));
    expect(answers).not.toContain(VALUE);
    closeLogFile();
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('Machine secret put');
    expect(log).not.toContain(VALUE);
  });
});
