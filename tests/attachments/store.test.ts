/**
 * Filenames and directories for downloaded attachments.
 *
 * The server's filename is never trusted to be a safe path component, and the
 * server's request id is never trusted to be a safe directory name.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachmentDirFor,
  attachmentsRoot,
  disambiguate,
  safeRequestDirName,
  sanitiseAttachmentName,
  ensureAttachmentDir,
  removeAttachmentDir,
  removeAttachmentDirsOnExit,
} from '../../src/attachments/store.js';

describe('safeRequestDirName', () => {
  it('keeps an ordinary request id recognisable', () => {
    expect(safeRequestDirName('req_abc123')).toMatch(/^req_abc123-[0-9a-f]{12}$/);
  });

  it('neutralises traversal in a request id', () => {
    // A request id is a server-chosen string about to be joined onto a path.
    expect(safeRequestDirName('../../.ssh')).not.toContain('..');
    expect(safeRequestDirName('../../.ssh')).not.toContain('/');
  });

  it('never returns an empty name', () => {
    expect(safeRequestDirName('')).not.toBe('');
    expect(safeRequestDirName('///')).not.toBe('');
  });

  it('gives DISTINCT ids distinct directories, however they sanitise', () => {
    // The sanitiser alone is lossy — `req/1` and `req:1` both flatten to
    // `req_1`, and long ids collide once truncated. Two turns sharing one
    // directory means the first to finish deletes the other's attachments
    // while its CLI is still reading them.
    const collidingPairs: [string, string][] = [
      ['req/1', 'req:1'],
      ['req.1', 'req-1'],
      [`req_${'a'.repeat(120)}_one`, `req_${'a'.repeat(120)}_two`],
    ];

    for (const [a, b] of collidingPairs) {
      expect(safeRequestDirName(a)).not.toBe(safeRequestDirName(b));
    }
  });

  it('is stable for the same id, so cleanup finds what the download wrote', () => {
    expect(safeRequestDirName('req_abc123')).toBe(safeRequestDirName('req_abc123'));
  });
});

describe('attachmentDirFor', () => {
  it('stays under the bridge cache root, never in a checkout', () => {
    const dir = attachmentDirFor('req_1');
    expect(dir.startsWith(attachmentsRoot())).toBe(true);
  });

  it('cannot be escaped by a hostile request id', () => {
    const dir = attachmentDirFor('../../../etc');
    expect(dir.startsWith(attachmentsRoot())).toBe(true);
  });
});

describe('cleanup when the process dies mid-turn', () => {
  it('takes the attachment directory with it', () => {
    // The per-turn `finally` never runs on SIGTERM: the shutdown handler
    // aborts the requests and calls process.exit without waiting for async
    // cleanup. The files are whatever a colleague sent into a chat.
    const id = 'req_exit_probe';
    const dir = ensureAttachmentDir(id);
    writeFileSync(join(dir, 'secret.pdf'), 'bytes');
    expect(existsSync(dir)).toBe(true);

    removeAttachmentDirsOnExit();

    expect(existsSync(dir)).toBe(false);
  });

  it('leaves --keep-attachments directories alone, which is the point of the flag', () => {
    // The operator's debugging flow is: reproduce, Ctrl-C the bridge, go look
    // at the files. An exit hook that deleted them would make the flag do the
    // opposite of what it says, and only on the exit path — so it would look
    // like it worked right up until you went looking.
    const id = 'req_keep_probe';
    const dir = ensureAttachmentDir(id, true);
    writeFileSync(join(dir, 'invoice.pdf'), 'bytes');

    removeAttachmentDirsOnExit();

    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not try to remove a directory already cleaned up normally', () => {
    const id = 'req_exit_probe_2';
    ensureAttachmentDir(id);
    removeAttachmentDir(id);

    expect(() => removeAttachmentDirsOnExit()).not.toThrow();
  });
});

describe('sanitiseAttachmentName', () => {
  it('keeps an ordinary filename', () => {
    expect(sanitiseAttachmentName('invoice.pdf', 'att_1')).toBe('invoice.pdf');
  });

  it('reduces a path to its last component', () => {
    expect(sanitiseAttachmentName('/etc/passwd', 'att_1')).toBe('passwd');
    expect(sanitiseAttachmentName('../../secrets.txt', 'att_1')).toBe('secrets.txt');
  });

  it('strips Windows separators too, which are just characters here', () => {
    expect(sanitiseAttachmentName('docs\\report.pdf', 'att_1')).toBe('report.pdf');
  });

  it('strips leading dots so nothing writes a hidden file', () => {
    expect(sanitiseAttachmentName('.bashrc', 'att_1')).toBe('bashrc');
    expect(sanitiseAttachmentName('...hidden', 'att_1')).toBe('hidden');
  });

  it('cannot be tricked into a hidden file by mixing dots and whitespace', () => {
    // Stripping dots and trimming in two passes — in either order — lets the
    // other character type re-expose what the first pass removed.
    for (const name of [' .bashrc', '. .bashrc', ' . . .bashrc', '\t.bashrc', '. ..bashrc']) {
      expect(sanitiseAttachmentName(name, 'att_1').startsWith('.')).toBe(false);
    }
  });

  it('falls back to the id when nothing usable survives', () => {
    expect(sanitiseAttachmentName('..', 'att_9f3c')).toBe('attachment-att_9f3c');
    expect(sanitiseAttachmentName('', 'att_9f3c')).toBe('attachment-att_9f3c');
    expect(sanitiseAttachmentName('/', 'att_9f3c')).toBe('attachment-att_9f3c');
  });

  it('drops null bytes and control characters', () => {
    expect(sanitiseAttachmentName('a\0b\nc.txt', 'att_1')).toBe('abc.txt');
  });

  it('caps the length while keeping the extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const out = sanitiseAttachmentName(long, 'att_1');
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('produces a single path component for every input', () => {
    for (const name of ['/etc/passwd', '..\\..\\x', 'a/b/c', '.', '..']) {
      const out = sanitiseAttachmentName(name, 'att_1');
      expect(join('/root', out)).toBe(`/root/${out}`);
      expect(out).not.toMatch(/[/\\]/);
    }
  });
});

describe('disambiguate', () => {
  it('leaves the first use of a name alone', () => {
    expect(disambiguate('a.png', new Set())).toBe('a.png');
  });

  it('numbers later collisions rather than overwriting', () => {
    // Two attachments legitimately called screenshot.png must not become one
    // file, or the model is told about two paths and one holds the wrong bytes.
    const taken = new Set<string>();
    expect(disambiguate('shot.png', taken)).toBe('shot.png');
    expect(disambiguate('shot.png', taken)).toBe('shot-2.png');
    expect(disambiguate('shot.png', taken)).toBe('shot-3.png');
  });

  it('handles names with no extension', () => {
    const taken = new Set<string>();
    disambiguate('README', taken);
    expect(disambiguate('README', taken)).toBe('README-2');
  });
});
