/**
 * Keeping a file on this machine instead of sending it.
 *
 * The other half of `bridge__attach_file`. Which half runs is the SERVER's
 * decision, because only the server knows what this machine is: somewhere
 * somebody works, where a file belongs and a copy taken elsewhere is a copy of
 * their work, or a processor, where nothing survives the turn.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeTypeFor, resolveUploadPath } from '../../src/attachments/upload.js';

describe('mimeTypeFor', () => {
  it('names the common things and admits ignorance about the rest', () => {
    expect(mimeTypeFor('/tmp/report.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('/tmp/notes.MD')).toBe('text/markdown');
    // The honest answer for a file nobody can identify. A browser saving it
    // does the right thing regardless, and the server sends nosniff either way.
    expect(mimeTypeFor('/tmp/thing.qqq')).toBe('application/octet-stream');
    expect(mimeTypeFor('/tmp/noextension')).toBe('application/octet-stream');
  });
});

describe('the path a kept file is asked for by', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-'));
  writeFileSync(join(dir, 'report.txt'), 'kept here');
  const ctx = {
    workingDir: dir, attachmentDir: null, apiOrigin: 'http://localhost',
    token: () => 't', signal: undefined,
  } as unknown as Parameters<typeof resolveUploadPath>[1];

  it('accepts a file inside the working directory', () => {
    expect(resolveUploadPath(join(dir, 'report.txt'), ctx)).toBe(join(dir, 'report.txt'));
  });

  it('refuses one outside it, which is the whole point of re-resolving', () => {
    // The path came FROM this machine and went back to the server, so it
    // arrives as input however it started. Resolving it again with the same
    // function the upload uses means one rule rather than two that drift.
    expect(() => resolveUploadPath('/etc/passwd', ctx)).toThrow();
    expect(() => resolveUploadPath(join(dir, '..', '..', 'etc', 'passwd'), ctx)).toThrow();
  });
});
