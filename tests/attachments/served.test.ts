/**
 * The record of files this bridge will hand back, and the checks made each
 * time one is served. The rule under test: an id this bridge minted is the only
 * way to a file, and a file that is no longer what was recorded is not served.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileReadRefusal, openRecorded, resolveRange, ServedFiles } from '../../src/attachments/served.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'served-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function refused(p: Promise<unknown>): Promise<FileReadRefusal> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FileReadRefusal);
  return err as FileReadRefusal;
}

describe('the record', () => {
  it('serves a recorded, unchanged file by its id', async () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'hello');
    const files = new ServedFiles(null);
    const id = files.record(path, 5, 'upload');
    const { handle, file } = await openRecorded(files, id);
    expect(file.path).toBe(path);
    expect((await handle.readFile()).toString()).toBe('hello');
    await handle.close();
  });

  it('a path is not an id: nothing unrecorded can be named, ~/.ssh included', async () => {
    const files = new ServedFiles(null);
    files.record(join(root, 'a.txt'), 1, 'upload');
    for (const guess of [join(process.env['HOME'] ?? '/root', '.ssh', 'id_ed25519'), '/etc/passwd', '../a.txt', '']) {
      expect((await refused(openRecorded(files, guess))).code).toBe('file_unknown');
    }
  });

  it('survives a restart when it has somewhere to live', () => {
    const store = join(root, 'store', 'served.json');
    const id = new ServedFiles(store).record('/x/y', 3, 'handed_back');
    expect(new ServedFiles(store).get(id)).toMatchObject({ path: '/x/y', size: 3, source: 'handed_back' });
  });

  it('a corrupt store is an empty record, not a crash', () => {
    const store = join(root, 'bad.json');
    writeFileSync(store, '{not json');
    expect(new ServedFiles(store).size).toBe(0);
  });
});

describe('checked again when served', () => {
  it('a file that is gone says so', async () => {
    const path = join(root, 'b.txt');
    writeFileSync(path, 'x');
    const files = new ServedFiles(null);
    const id = files.record(path, 1, 'upload');
    unlinkSync(path);
    const err = await refused(openRecorded(files, id));
    expect(err.code).toBe('file_gone');
    expect(err.message).toContain('no longer on this machine');
  });

  it('a file whose size changed is not served as the one that was sent', async () => {
    const path = join(root, 'c.txt');
    writeFileSync(path, 'abc');
    const files = new ServedFiles(null);
    const id = files.record(path, 3, 'upload');
    appendFileSync(path, 'def');
    const err = await refused(openRecorded(files, id));
    expect(err.code).toBe('file_changed');
    expect(err.message).toContain('is 6 bytes now and was 3');
  });

  it('a symlink put where the file was is refused, not followed', async () => {
    const secret = join(root, 'secret');
    writeFileSync(secret, 'key');
    const path = join(root, 'd.txt');
    writeFileSync(path, 'key');
    const files = new ServedFiles(null);
    const id = files.record(path, 3, 'upload');
    unlinkSync(path);
    symlinkSync(secret, path);
    expect((await refused(openRecorded(files, id))).code).toBe('file_changed');
  });
});

describe('ranges', () => {
  it('one range is honoured, anything else is the whole file, past the end is 416', () => {
    expect(resolveRange(undefined, 1000)).toEqual({ status: 200, start: 0, end: 999 });
    expect(resolveRange('bytes=100-199', 1000)).toEqual({ status: 206, start: 100, end: 199 });
    // An empty file has no last N bytes: 416, not an empty 206.
    expect(resolveRange('bytes=-10', 0)).toEqual({ status: 416, start: 0, end: -1 });
    expect(resolveRange('bytes=900-', 1000)).toEqual({ status: 206, start: 900, end: 999 });
    expect(resolveRange('bytes=-10', 1000)).toEqual({ status: 206, start: 990, end: 999 });
    expect(resolveRange('bytes=0-5000', 1000)).toEqual({ status: 206, start: 0, end: 999 });
    expect(resolveRange('bytes=0-1,5-9', 1000).status).toBe(200);
    expect(resolveRange('bytes=5000-', 1000).status).toBe(416);
  });
});
