/**
 * `upload_offer` driven through the Bridge over a real WebSocket.
 *
 * tests/attachments/receive.test.ts covers the file handling. What only exists
 * here is the conversation around it: the capability in `hello`, the frames
 * that start, confirm and stop an upload, and the one `upload_done` every
 * offer gets whatever happened.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';

let wss: WebSocketServer;
let api: Server;
let apiOrigin: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let root: string;
let work: string;
/** The response a GET is holding open, for the tests that stream by hand. */
let held: ServerResponse | null = null;
let seenAuth: string | undefined;
const body = Buffer.from('the contract, as the client sent it');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  held = null;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'offer-bridge-')));
  work = join(root, 'repo');
  mkdirSync(work);

  api = createServer((req, res) => {
    seenAuth = req.headers['authorization'];
    if (req.url === '/ai-bridge/uploads/hold') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength) });
      res.write(body.subarray(0, 5));
      held = res;
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength) });
    res.end(body);
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });

  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map(),
    sessionStorePath: null,
    allowedRoots: [{ path: root, label: 'root' }],
    apiOrigin,
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
});

afterEach(async () => {
  held?.destroy();
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
  api.closeAllConnections();
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function offer(id: string, path = `/ai-bridge/uploads/${id}`): void {
  socket.send(JSON.stringify({
    type: 'upload_offer', id, url: `${apiOrigin}${path}`, working_dir: work,
    name: 'contract.pdf', mime_type: 'application/pdf', size: body.byteLength,
  }));
}

describe('upload_offer', () => {
  it('hello says the frames are understood', () => {
    expect(frames.find((f) => f['type'] === 'hello')?.['file_uploads']).toBe(true);
  });

  it('fetches with the token, waits for the server\'s digest, then answers with where the file is', async () => {
    offer('u-1');
    // Nothing is committed before the server confirms what it sent.
    await new Promise((r) => setTimeout(r, 150));
    expect(frames.find((f) => f['type'] === 'upload_done')).toBeUndefined();
    expect(existsSync(join(work, 'file-uploads', 'contract.pdf'))).toBe(false);

    socket.send(JSON.stringify({ type: 'upload_sent', id: 'u-1', size: body.byteLength, sha256: sha(body) }));
    const done = await waitFor((f) => f['type'] === 'upload_done', 'upload_done');
    expect(seenAuth).toBe('Bearer tok-1');
    expect(done).toMatchObject({
      id: 'u-1', ok: true, name: 'contract.pdf', size: body.byteLength, sha256: sha(body),
      path: join(work, 'file-uploads', 'contract.pdf'),
    });
    expect(readFileSync(join(work, 'file-uploads', 'contract.pdf')).equals(body)).toBe(true);
  });

  it('upload_abort stops it, removes the partial file, and is still answered', async () => {
    offer('u-2', '/ai-bridge/uploads/hold');
    for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 10));
    expect(held).not.toBeNull();
    socket.send(JSON.stringify({ type: 'upload_abort', id: 'u-2', reason: 'the person closed the tab' }));
    const done = await waitFor((f) => f['type'] === 'upload_done', 'upload_done');
    expect(done).toMatchObject({ id: 'u-2', ok: false, code: 'upload_cancelled' });
    expect(String(done['error'])).toContain('the person closed the tab');
    expect(readdirSync(join(work, 'file-uploads'))).toEqual(['.gitignore']);
  });

  it('a refusal is an answer too, with its code', async () => {
    socket.send(JSON.stringify({
      type: 'upload_offer', id: 'u-3', url: `${apiOrigin}/ai-bridge/uploads/u-3`, working_dir: '/etc',
      name: 'x', size: 1,
    }));
    const done = await waitFor((f) => f['type'] === 'upload_done', 'upload_done');
    expect(done).toMatchObject({ id: 'u-3', ok: false, code: 'working_dir_not_allowed' });
  });
});
