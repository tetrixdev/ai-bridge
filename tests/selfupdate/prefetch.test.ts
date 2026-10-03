/**
 * Fetching a version: one at a time per machine, and repairing an npx cache
 * directory left half-installed (2026-10-03: two installs of 0.24.0 at once
 * left @modelcontextprotocol/sdk without its package.json, and every later run
 * of that version failed the same way).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenNpxDir, prefetch, type PrefetchDeps } from '../../src/selfupdate/service.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function scratch(): string { const d = mkdtempSync(join(tmpdir(), 'prefetch-')); dirs.push(d); return d; }

/** An npx cache directory holding the bridge at `version`. */
function npxDir(root: string, version: string): string {
  const dir = join(root, '_npx', '988bece436e66bb8');
  mkdirSync(join(dir, 'node_modules', '@tetrixdev', 'ai-bridge'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@tetrixdev', 'ai-bridge', 'package.json'), JSON.stringify({ version }));
  return dir;
}

/** The error the real run printed, pointing into `dir`. */
const missing = (dir: string) => `node:internal/modules/esm/resolve:275
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${dir}/node_modules/@modelcontextprotocol/sdk/server/index.js' imported from ${dir}/node_modules/@tetrixdev/ai-bridge/dist/cli.js`;

function deps(root: string, runs: Array<{ error?: string; stdout?: string; stderr?: string }>, over: Partial<PrefetchDeps> = {}) {
  const calls: string[][] = [];
  const d: PrefetchDeps = {
    run: async (args) => {
      calls.push(args);
      const r = runs.shift() ?? {};
      return { error: r.error ? new Error(r.error) : null, killed: false, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    lockDir: join(root, 'prefetch.lock'),
    lockWaitMs: 50,
    lockStaleMs: 10 * 60_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...over,
  };
  return { d, calls };
}

describe('fetching a version', () => {
  it('succeeds when the version runs and says its own number, and releases the lock', async () => {
    const root = scratch();
    const { d, calls } = deps(root, [{ stdout: '0.24.1\n' }]);
    expect(await prefetch('0.24.1', 1000, d)).toEqual({ ok: true });
    expect(calls).toEqual([['-y', '--prefer-online', '--ignore-scripts', '@tetrixdev/ai-bridge@0.24.1', '--version']]);
    expect(existsSync(d.lockDir)).toBe(false);
  });

  it('a version that does not exist fails cleanly, once, and releases the lock', async () => {
    const root = scratch();
    const { d, calls } = deps(root, [{ error: 'Command failed: npx … @tetrixdev/ai-bridge@9.9.9', stderr: 'npm error 404 Not Found' }]);
    expect(await prefetch('9.9.9', 1000, d)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
    expect(existsSync(d.lockDir)).toBe(false);
  });

  it('repairs a half-installed cache directory of this version and tries once more', async () => {
    const root = scratch();
    const dir = npxDir(root, '0.24.1');
    const { d, calls } = deps(root, [{ error: 'Command failed', stderr: missing(dir) }, { stdout: '0.24.1\n' }]);
    expect(await prefetch('0.24.1', 1000, d)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(existsSync(dir)).toBe(false);
  });

  it('waits its turn while another bridge on this machine is fetching', async () => {
    const root = scratch();
    mkdirSync(join(root, 'prefetch.lock'));
    const { d, calls } = deps(root, [{ stdout: '0.24.1\n' }], { lockWaitMs: 30 });
    expect(await prefetch('0.24.1', 1000, d)).toMatchObject({ ok: false, reason: expect.stringMatching(/another bridge/) });
    expect(calls).toHaveLength(0);
  });

  it('takes over a lock left by a process that died', async () => {
    const root = scratch();
    const lock = join(root, 'prefetch.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    const { d } = deps(root, [{ stdout: '0.24.1\n' }]);
    expect(await prefetch('0.24.1', 1000, d)).toEqual({ ok: true });
  });
});

describe('which cache directory is broken', () => {
  it('the one the error points into, when it holds this version', () => {
    const root = scratch();
    const dir = npxDir(root, '0.24.1');
    expect(brokenNpxDir(missing(dir), '0.24.1')).toBe(dir);
  });

  it('none, when that directory holds another version: something may be running from it', () => {
    const root = scratch();
    const dir = npxDir(root, '0.24.0');
    expect(brokenNpxDir(missing(dir), '0.24.1')).toBeNull();
  });

  it('none, for an error that is not a missing module, or names no npx directory', () => {
    const root = scratch();
    const dir = npxDir(root, '0.24.1');
    expect(brokenNpxDir(`npm error 404 Not Found ${dir}/node_modules/x`, '0.24.1')).toBeNull();
    expect(brokenNpxDir("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/usr/lib/node_modules/x/index.js'", '0.24.1')).toBeNull();
  });
});

describe('never throws', () => {
  it('a lock directory that cannot be made comes back as a failure', async () => {
    const root = scratch();
    writeFileSync(join(root, 'file'), 'x');
    const { d } = deps(root, [{ stdout: '0.24.1\n' }], { lockDir: join(root, 'file', 'sub', 'prefetch.lock') });
    expect(await prefetch('0.24.1', 1000, d)).toMatchObject({ ok: false });
  });

  it('a run that throws comes back as a failure', async () => {
    const root = scratch();
    const { d } = deps(root, [], { run: async () => { throw new Error('spawn npx ENOENT'); } });
    expect(await prefetch('0.24.1', 1000, d)).toEqual({ ok: false, reason: 'spawn npx ENOENT' });
  });
});

describe('the lock belongs to whoever holds it', () => {
  it('a fetch whose lock was taken over does not remove the new holder\'s lock', async () => {
    const root = scratch();
    const lock = join(root, 'prefetch.lock');
    const { d } = deps(root, [], {
      run: async () => {
        // While this fetch runs, its lock goes stale and another bridge takes over.
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner'), 'the-other-bridge');
        return { error: null, killed: false, stdout: '0.24.1\n', stderr: '' };
      },
    });
    expect(await prefetch('0.24.1', 1000, d)).toEqual({ ok: true });
    expect(existsSync(join(lock, 'owner'))).toBe(true);
  });
});
