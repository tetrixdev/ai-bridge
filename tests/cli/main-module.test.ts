import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../src/cli.js';

/**
 * Tests for isMainModule() — the guard that decides whether cli.ts should
 * parse argv and start the bridge.
 *
 * Regression: npm installs the package `bin` entry as a symlink
 * (node_modules/.bin/ai-bridge -> .../dist/cli.js). When executed,
 * process.argv[1] is the *symlink* path while import.meta.url resolves to the
 * *real* file path. A plain string comparison fails, so the CLI silently
 * exits without doing anything. The guard must therefore be symlink-aware.
 */
describe('isMainModule', () => {
  let tmpDir: string;
  let realFile: string;
  let realFileUrl: string;
  let symlink: string;
  let otherFile: string;

  beforeAll(() => {
    // Resolve any symlinks in the temp root so the "direct invocation" case is
    // deterministic regardless of how the OS lays out its temp directory.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aib-mainmod-')));

    realFile = path.join(tmpDir, 'cli.js');
    fs.writeFileSync(realFile, '// fake cli entry point\n');
    realFileUrl = pathToFileURL(realFile).href;

    // Simulate the npm bin symlink: bin-link -> cli.js
    symlink = path.join(tmpDir, 'bin-link');
    fs.symlinkSync(realFile, symlink);

    otherFile = path.join(tmpDir, 'unrelated.js');
    fs.writeFileSync(otherFile, '// some other file\n');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for direct invocation (argv1 is the real file)', () => {
    expect(isMainModule(realFile, realFileUrl)).toBe(true);
  });

  it('returns true when argv1 is a symlink to the module (npm bin install)', () => {
    // This is the regression case: the symlink path differs from the real
    // path, but it still resolves to the same file.
    expect(isMainModule(symlink, realFileUrl)).toBe(true);
  });

  it('returns false when argv1 points at an unrelated file (imported as a module)', () => {
    expect(isMainModule(otherFile, realFileUrl)).toBe(false);
  });

  it('returns false when argv1 is undefined', () => {
    expect(isMainModule(undefined, realFileUrl)).toBe(false);
  });

  it('returns false when argv1 does not exist on disk', () => {
    expect(isMainModule(path.join(tmpDir, 'does-not-exist.js'), realFileUrl)).toBe(false);
  });
});
