/**
 * Downloading a turn's attachments, against a real HTTP server on loopback.
 *
 * A real server rather than a mocked fetch: the things worth testing here are
 * streaming, size enforcement mid-download, checksum verification and what is
 * left on disk afterwards, and none of those are exercised by a stub.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fetchAttachments, buildAttachmentPreamble } from '../../src/attachments/fetch.js';
import { attachmentDirFor, removeAttachmentDir } from '../../src/attachments/store.js';
import { RequestRefusal } from '../../src/errors.js';
import type { AttachmentRef } from '../../src/protocol/types.js';

let server: Server;
let origin: string;
/** Bodies the fake server will serve, keyed by path. */
const bodies = new Map<string, Buffer>();
/** Authorization headers the server saw, so we can assert the token is sent. */
let seenAuth: (string | undefined)[] = [];

const REQUEST_ID = 'req_fetch_test';
const LIMITS = { maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function ref(path: string, body: Buffer, overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: `att_${path.replace(/\W/g, '')}`,
    name: path.split('/').pop() ?? 'file',
    mime_type: 'application/octet-stream',
    size: body.byteLength,
    sha256: sha256(body),
    url: `${origin}${path}`,
    ...overrides,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuth.push(req.headers['authorization']);
    const path = (req.url ?? '').split('?')[0] ?? '';

    if (path === '/redirect') {
      res.writeHead(302, { Location: 'https://evil.example.com/x' });
      res.end();
      return;
    }
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404).end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  removeAttachmentDir(REQUEST_ID);
  seenAuth = [];
  bodies.clear();
});

describe('fetchAttachments', () => {
  it('returns nothing and creates no directory when there are no attachments', async () => {
    const saved = await fetchAttachments({
      attachments: [], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    });
    expect(saved).toEqual([]);
    expect(existsSync(attachmentDirFor(REQUEST_ID))).toBe(false);
  });

  it('downloads a file over 1 MB — the cap that rules out inlining the bytes', async () => {
    // 1 MB is the server's own WebSocket frame cap, so this is precisely the
    // case that could never have travelled on the wire.
    const body = randomBytes(1_500_000);
    bodies.set('/big.bin', body);
    const saved = await fetchAttachments({
      attachments: [ref('/big.bin', body)],
      requestId: REQUEST_ID, token: () => 'tok-abc', expectedOrigin: origin,
      limits: { maxFileBytes: 5_000_000, maxTotalBytes: 10_000_000 },
      signal: new AbortController().signal,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.size).toBe(body.byteLength);
    expect(readFileSync(saved[0]!.path).equals(body)).toBe(true);
    // The bridge's own connection token is what authorises the fetch.
    expect(seenAuth).toContain('Bearer tok-abc');
  });

  it('writes into the bridge cache, never into a working directory', async () => {
    const body = Buffer.from('hello');
    bodies.set('/a.txt', body);
    const saved = await fetchAttachments({
      attachments: [ref('/a.txt', body)], requestId: REQUEST_ID, token: () => 't',
      expectedOrigin: origin, limits: LIMITS, signal: new AbortController().signal,
    });
    expect(saved[0]!.path.startsWith(attachmentDirFor(REQUEST_ID))).toBe(true);
  });

  it('fails the request when the checksum does not match', async () => {
    const body = Buffer.from('real contents');
    bodies.set('/x.txt', body);
    const bad = ref('/x.txt', body, { sha256: sha256(Buffer.from('something else')) });

    // A half-downloaded or substituted file reads to the model as a genuinely
    // corrupt document, so it must fail loudly here instead.
    await expect(fetchAttachments({
      attachments: [bad], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toThrow(/checksum/);
  });

  it('fails the request when the size does not match', async () => {
    const body = Buffer.from('12345');
    bodies.set('/y.txt', body);
    const bad = ref('/y.txt', body, { size: 99 });
    await expect(fetchAttachments({
      attachments: [bad], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toThrow(/bytes but the server said/);
  });

  it('refuses a declared size over the per-file cap before fetching anything', async () => {
    const body = Buffer.from('small');
    bodies.set('/z.txt', body);
    const lying = ref('/z.txt', body, { size: 50 * 1024 * 1024 });
    await expect(fetchAttachments({
      attachments: [lying], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(seenAuth).toEqual([]);
  });

  it('refuses a declared total over the per-request cap', async () => {
    const body = Buffer.from('x');
    bodies.set('/1.txt', body);
    const refs = [
      ref('/1.txt', body, { id: 'a', size: 900 * 1024 }),
      ref('/1.txt', body, { id: 'b', size: 900 * 1024 }),
      ref('/1.txt', body, { id: 'c', size: 900 * 1024 }),
    ];
    await expect(fetchAttachments({
      attachments: refs, requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'attachment_too_large' });
  });

  it('enforces the cap on the actual bytes, not just the declared size', async () => {
    // The declared size is the server's claim; the cap has to hold against a
    // server that is wrong about it.
    const body = randomBytes(300_000);
    bodies.set('/lie.bin', body);
    const understated = ref('/lie.bin', body, { size: 10 });
    await expect(fetchAttachments({
      attachments: [understated], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: { maxFileBytes: 100_000, maxTotalBytes: 100_000 },
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it('refuses an attachment URL pointing at another host', async () => {
    const body = Buffer.from('x');
    const foreign = ref('/a.txt', body, { url: 'https://evil.example.com/a.txt' });
    await expect(fetchAttachments({
      attachments: [foreign], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'attachment_refused' });
  });

  it('does not follow a redirect off the allowed origin', async () => {
    // Otherwise the host binding is decorative: the allowed origin just answers
    // 302 to anywhere it likes.
    const body = Buffer.from('x');
    const redirecting = ref('/redirect', body, { url: `${origin}/redirect` });
    await expect(fetchAttachments({
      attachments: [redirecting], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it('reports an HTTP failure rather than saving a 404 body', async () => {
    const body = Buffer.from('x');
    await expect(fetchAttachments({
      attachments: [ref('/missing.txt', body)], requestId: REQUEST_ID, token: () => 't',
      expectedOrigin: origin, limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toThrow(/HTTP 404/);
  });

  it('gives two identically named attachments two files', async () => {
    const a = Buffer.from('first');
    const b = Buffer.from('second');
    bodies.set('/one/shot.png', a);
    bodies.set('/two/shot.png', b);
    const saved = await fetchAttachments({
      attachments: [ref('/one/shot.png', a), ref('/two/shot.png', b)],
      requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    });
    expect(saved.map((s) => s.name)).toEqual(['shot.png', 'shot-2.png']);
    expect(readFileSync(saved[0]!.path, 'utf-8')).toBe('first');
    expect(readFileSync(saved[1]!.path, 'utf-8')).toBe('second');
  });

  it('never writes outside the request directory, whatever the name', async () => {
    const body = Buffer.from('x');
    bodies.set('/evil', body);
    const traversal = ref('/evil', body, { name: '../../../../tmp/pwned.txt' });
    const saved = await fetchAttachments({
      attachments: [traversal], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    });
    expect(saved[0]!.path.startsWith(attachmentDirFor(REQUEST_ID))).toBe(true);
    expect(readdirSync(attachmentDirFor(REQUEST_ID))).toEqual(['pwned.txt']);
  });

  it('raises RequestRefusal, so the bridge reports a code instead of session_lost', async () => {
    const body = Buffer.from('x');
    const foreign = ref('/a.txt', body, { url: 'https://evil.example.com/a.txt' });
    await expect(fetchAttachments({
      attachments: [foreign], requestId: REQUEST_ID, token: () => 't', expectedOrigin: origin,
      limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RequestRefusal);
  });
});

describe('buildAttachmentPreamble', () => {
  it('is empty when nothing was attached', () => {
    expect(buildAttachmentPreamble([])).toBe('');
  });

  it('names every file with its absolute path, type and size', () => {
    const text = buildAttachmentPreamble([
      { id: 'a', name: 'invoice.pdf', path: '/cache/req/invoice.pdf', mimeType: 'application/pdf', size: 482113 },
      { id: 'b', name: 'shot.png', path: '/cache/req/shot.png', mimeType: 'image/png', size: 1024 },
    ]);
    expect(text).toContain('/cache/req/invoice.pdf');
    expect(text).toContain('application/pdf');
    expect(text).toContain('/cache/req/shot.png');
    expect(text).toContain('2 files');
    // The model needs to know these do not survive the turn.
    expect(text).toMatch(/deleted when this turn ends/);
  });

  it('uses the singular for one file', () => {
    const text = buildAttachmentPreamble([
      { id: 'a', name: 'a.txt', path: join('/cache', 'a.txt'), mimeType: 'text/plain', size: 5 },
    ]);
    expect(text).toContain('attached a file');
  });
});
