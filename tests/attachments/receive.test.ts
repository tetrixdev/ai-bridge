/**
 * A person's upload arriving in the working folder, against a real HTTP server
 * on loopback.
 *
 * What is pinned is what makes this path safe to point at somebody's own
 * folder: the file appears under its name only once the server's digest
 * matches, it never replaces a file already there, a name cannot walk out of
 * `file-uploads/`, and every failure — refused, too large, cancelled, a digest
 * that disagrees — leaves nothing behind.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { receiveUpload, UPLOADS_DIR, type UploadOffer, type UploadSent } from '../../src/attachments/receive.js';
import { RequestRefusal } from '../../src/errors.js';

let server: Server;
let origin: string;
const bodies = new Map<string, Buffer>();
let requests: string[] = [];
let root: string;
let work: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    requests.push(path);
    if (path === '/trickle') {
      // A first chunk, then nothing: somebody who is about to press cancel.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(100));
      return;
    }
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no such upload' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  requests = [];
  bodies.clear();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'receive-')));
  work = join(root, 'project');
  mkdirSync(work);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function offer(path: string, body: Buffer, overrides: Partial<UploadOffer> = {}): UploadOffer {
  bodies.set(path, body);
  return {
    id: `up-${path.replace(/\W/g, '')}`,
    url: `${origin}${path}`,
    working_dir: work,
    name: 'report.pdf',
    mime_type: 'application/pdf',
    size: body.byteLength,
    ...overrides,
  };
}

function receive(
  o: UploadOffer,
  sent: UploadSent | Promise<UploadSent>,
  extra: { allowedRoots?: string[]; maxFileBytes?: number; signal?: AbortSignal } = {},
) {
  return receiveUpload({
    offer: o,
    allowedRoots: extra.allowedRoots ?? [root],
    token: () => 'tok-1',
    expectedOrigin: origin,
    maxFileBytes: extra.maxFileBytes ?? 10 * 1024 * 1024,
    sent: Promise.resolve(sent),
    signal: extra.signal ?? new AbortController().signal,
  });
}

/** Everything in file-uploads, hidden files included. */
function listing(): string[] {
  const dir = join(work, UPLOADS_DIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function refusal(p: Promise<unknown>): Promise<RequestRefusal> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RequestRefusal);
  return err as RequestRefusal;
}

describe('receiving an upload', () => {
  it('lands in file-uploads under its own name, verified, with nothing else left behind', async () => {
    const body = randomBytes(300_000);
    const got = await receive(offer('/u1', body), { size: body.byteLength, sha256: sha(body) });

    expect(got.path).toBe(join(work, UPLOADS_DIR, 'report.pdf'));
    expect(got.sha256).toBe(sha(body));
    expect(readFileSync(got.path).equals(body)).toBe(true);
    // The folder keeps itself out of git; no partial file survives.
    expect(listing()).toEqual(['.gitignore', 'report.pdf']);
    expect(readFileSync(join(work, UPLOADS_DIR, '.gitignore'), 'utf8')).toContain('*');
  });

  it('never replaces a file already there: the second one is numbered', async () => {
    const first = Buffer.from('the first report');
    const second = Buffer.from('a different report');
    await receive(offer('/a', first), { size: first.byteLength, sha256: sha(first) });
    const got = await receive(offer('/b', second), { size: second.byteLength, sha256: sha(second) });

    expect(got.name).toBe('report-2.pdf');
    expect(readFileSync(join(work, UPLOADS_DIR, 'report.pdf'), 'utf8')).toBe('the first report');
    expect(readFileSync(got.path, 'utf8')).toBe('a different report');
  });

  it('two uploads of one name at the same moment both survive', async () => {
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbbbb');
    const [x, y] = await Promise.all([
      receive(offer('/c1', a), { size: a.byteLength, sha256: sha(a) }),
      receive(offer('/c2', b), { size: b.byteLength, sha256: sha(b) }),
    ]);
    expect(new Set([x.name, y.name])).toEqual(new Set(['report.pdf', 'report-2.pdf']));
  });

  it('a name that is a path is reduced to its last part and stays inside file-uploads', async () => {
    const body = Buffer.from('not a password file');
    const got = await receive(offer('/t', body, { name: '../../../etc/passwd' }), { size: body.byteLength, sha256: sha(body) });
    expect(got.path).toBe(join(work, UPLOADS_DIR, 'passwd'));
    // And one that would be hidden, or would collide with the ignore file, is not.
    const got2 = await receive(offer('/t2', body, { name: '.gitignore' }), { size: body.byteLength, sha256: sha(body) });
    expect(got2.name).toBe('gitignore');
    expect(readFileSync(join(work, UPLOADS_DIR, '.gitignore'), 'utf8')).toContain('*');
  });

  it('a digest that disagrees with the server leaves no file at all', async () => {
    const body = Buffer.from('what arrived');
    const err = await refusal(receive(offer('/bad', body), { size: body.byteLength, sha256: sha(Buffer.from('what was sent')) }));
    expect(err.code).toBe('upload_failed');
    expect(err.message).toContain('checksum');
    expect(listing()).toEqual(['.gitignore']);
  });

  it('a size that disagrees is refused the same way', async () => {
    const body = Buffer.from('twelve bytes');
    const err = await refusal(receive(offer('/short', body), { size: body.byteLength + 1, sha256: sha(body) }));
    expect(err.code).toBe('upload_failed');
    expect(listing()).toEqual(['.gitignore']);
  });

  it('more bytes than were declared are cut off, not written', async () => {
    const body = randomBytes(5000);
    const err = await refusal(receive(offer('/long', body, { size: 1000 }), { size: 1000, sha256: sha(body) }));
    expect(err.code).toBe('upload_failed');
    expect(err.message).toContain('past the 1000 bytes');
    expect(listing()).toEqual(['.gitignore']);
  });

  it('a file over this machine\'s limit is refused before a byte is fetched', async () => {
    const body = randomBytes(2048);
    const err = await refusal(receive(offer('/big', body), { size: 2048, sha256: sha(body) }, { maxFileBytes: 1024 }));
    expect(err.code).toBe('upload_too_large');
    expect(requests).toEqual([]);
  });

  it('a cancelled upload removes what had arrived', async () => {
    const stop = new AbortController();
    const o = offer('/x', Buffer.alloc(0), { url: `${origin}/trickle`, size: 10_000 });
    const pending = receive(o, new Promise<UploadSent>(() => undefined), { signal: stop.signal });
    // Let the first chunk land on disk before pulling the plug.
    for (let i = 0; i < 50 && !listing().some((n) => n.endsWith('.part')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(listing().some((n) => n.endsWith('.part'))).toBe(true);
    stop.abort(new Error('the person removed the file'));
    const err = await refusal(pending);
    expect(err.code).toBe('upload_cancelled');
    expect(err.message).toContain('the person removed the file');
    expect(listing()).toEqual(['.gitignore']);
  });
});

describe('where it may go', () => {
  it('a machine with no folder refuses, and names why', async () => {
    const body = Buffer.from('x');
    const err = await refusal(receive(offer('/n', body), { size: 1, sha256: sha(body) }, { allowedRoots: [] }));
    expect(err.code).toBe('upload_refused');
    expect(err.message).toContain('--allow-dir');
    expect(requests).toEqual([]);
  });

  it('a working folder outside the allowed ones is refused before anything is created', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')));
    try {
      const body = Buffer.from('x');
      const err = await refusal(receive(offer('/o', body, { working_dir: elsewhere }), { size: 1, sha256: sha(body) }));
      expect(err.code).toBe('working_dir_not_allowed');
      expect(existsSync(join(elsewhere, UPLOADS_DIR))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('a file-uploads that is a link is not written through', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
    try {
      symlinkSync(outside, join(work, UPLOADS_DIR));
      const body = Buffer.from('x');
      const err = await refusal(receive(offer('/l', body), { size: 1, sha256: sha(body) }));
      expect(err.code).toBe('upload_refused');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a url on another host is refused, with the token never sent', async () => {
    const body = Buffer.from('x');
    const err = await refusal(receive(offer('/h', body, { url: 'https://evil.example.com/h' }), { size: 1, sha256: sha(body) }));
    expect(err.code).toBe('upload_refused');
    expect(requests).toEqual([]);
  });

  it('an existing file-uploads folder is used as it is, its ignore file untouched', async () => {
    mkdirSync(join(work, UPLOADS_DIR));
    writeFileSync(join(work, UPLOADS_DIR, 'notes.txt'), 'mine');
    const body = Buffer.from('y');
    await receive(offer('/e', body), { size: 1, sha256: sha(body) });
    expect(listing()).toEqual(['notes.txt', 'report.pdf']);
  });
});
