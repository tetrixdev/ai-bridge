/**
 * The return direction — `bridge__attach_file`.
 *
 * The path check is the important half. In `workspace` mode the model has a
 * shell, so it can create a symlink pointing at anything on the machine; the
 * containment check therefore happens after realpath, exactly as it does for
 * the working directory itself.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACH_FILE_TOOL,
  ATTACH_FILE_TOOL_DEFINITION,
  resolveUploadPath,
  uploadAttachment,
  type UploadContext,
} from '../../src/attachments/upload.js';

let root: string;
let workingDir: string;
let attachmentDir: string;
let outside: string;
let server: Server;
let origin: string;

/** Requests the fake server received. */
let received: { auth?: string; length: number }[] = [];
let respondWith: { status: number; body: unknown } = { status: 200, body: { id: 'att_new', url: '/x' } };

function ctx(overrides: Partial<UploadContext> = {}): UploadContext {
  return {
    workingDir,
    attachmentDir,
    apiOrigin: origin,
    token: () => 'tok-xyz',
    maxFileBytes: 1024 * 1024,
    ...overrides,
  };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'upload-test-')));
  workingDir = join(root, 'checkout');
  attachmentDir = join(root, 'attachments');
  outside = join(root, 'private');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(attachmentDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workingDir, 'report.md'), '# report');
  writeFileSync(join(attachmentDir, 'invoice.pdf'), 'pdf bytes');
  writeFileSync(join(outside, 'id_ed25519'), 'PRIVATE KEY');
  // The escape a model with a shell can create for itself.
  symlinkSync(join(outside, 'id_ed25519'), join(workingDir, 'innocent.txt'));

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        auth: req.headers['authorization'],
        length: Buffer.concat(chunks).byteLength,
      });
      res.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respondWith.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  received = [];
  respondWith = { status: 200, body: { id: 'att_new', url: '/x' } };
});

describe('the tool definition', () => {
  it('is namespaced so it cannot collide with a server tool', () => {
    expect(ATTACH_FILE_TOOL).toBe('bridge__attach_file');
    expect(ATTACH_FILE_TOOL_DEFINITION.name).toBe(ATTACH_FILE_TOOL);
  });

  it('requires a path and takes an optional description', () => {
    expect(ATTACH_FILE_TOOL_DEFINITION.parameters.required).toEqual(['path']);
    expect(ATTACH_FILE_TOOL_DEFINITION.parameters.properties).toHaveProperty('description');
  });
});

describe('resolveUploadPath', () => {
  it('accepts a file in the working directory', () => {
    expect(resolveUploadPath(join(workingDir, 'report.md'), ctx())).toBe(join(workingDir, 'report.md'));
  });

  it('accepts a file in the turn attachment directory', () => {
    expect(resolveUploadPath(join(attachmentDir, 'invoice.pdf'), ctx()))
      .toBe(join(attachmentDir, 'invoice.pdf'));
  });

  it('refuses a file outside both', () => {
    expect(() => resolveUploadPath(join(outside, 'id_ed25519'), ctx()))
      .toThrow(/outside the directories/);
  });

  it('refuses a symlink inside the working dir that points outside it', () => {
    // The model has a shell in workspace mode; this is a symlink it could make.
    expect(() => resolveUploadPath(join(workingDir, 'innocent.txt'), ctx()))
      .toThrow(/outside the directories/);
  });

  it('refuses traversal out of the working directory', () => {
    expect(() => resolveUploadPath(join(workingDir, '..', 'private', 'id_ed25519'), ctx()))
      .toThrow(/outside the directories/);
  });

  it('refuses a relative path', () => {
    expect(() => resolveUploadPath('report.md', ctx())).toThrow(/absolute/);
  });

  it('refuses a null byte', () => {
    expect(() => resolveUploadPath(`${workingDir}/report.md\0`, ctx())).toThrow(/null byte/);
  });

  it('refuses a directory', () => {
    expect(() => resolveUploadPath(workingDir, ctx())).toThrow(/not a regular file/);
  });

  it('refuses a file that does not exist', () => {
    expect(() => resolveUploadPath(join(workingDir, 'nope.md'), ctx())).toThrow(/no such file/);
  });

  it('refuses a file over the per-file cap', () => {
    const big = join(workingDir, 'big.bin');
    writeFileSync(big, Buffer.alloc(2048));
    expect(() => resolveUploadPath(big, ctx({ maxFileBytes: 1024 }))).toThrow(/over the/);
  });

  it('has no attachment directory to send from when the turn had no attachments', () => {
    expect(() => resolveUploadPath(join(attachmentDir, 'invoice.pdf'), ctx({ attachmentDir: null })))
      .toThrow(/outside the directories/);
  });
});

describe('uploadAttachment', () => {
  it('posts the file to the connected origin with the bridge token', async () => {
    const result = await uploadAttachment(join(workingDir, 'report.md'), 'the report', ctx());
    expect(result.id).toBe('att_new');
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe('Bearer tok-xyz');
    expect(received[0]!.length).toBeGreaterThan(0);
  });

  it('uses the server-reported metadata when it sends any', async () => {
    respondWith = {
      status: 200,
      body: { id: 'att_2', name: 'renamed.md', mime_type: 'text/markdown', size: 8 },
    };
    const result = await uploadAttachment(join(workingDir, 'report.md'), undefined, ctx());
    expect(result).toMatchObject({ id: 'att_2', name: 'renamed.md', mimeType: 'text/markdown' });
  });

  it('fails when the server rejects the upload', async () => {
    respondWith = { status: 403, body: { error: 'nope' } };
    await expect(uploadAttachment(join(workingDir, 'report.md'), undefined, ctx()))
      .rejects.toThrow(/HTTP 403/);
  });

  it('fails when the server returns no attachment id', async () => {
    respondWith = { status: 200, body: { ok: true } };
    await expect(uploadAttachment(join(workingDir, 'report.md'), undefined, ctx()))
      .rejects.toThrow(/no attachment id/);
  });

  it('never uploads a file it would have refused', async () => {
    await expect(uploadAttachment(join(outside, 'id_ed25519'), undefined, ctx())).rejects.toThrow();
    expect(received).toEqual([]);
  });
});
