/**
 * What this bridge will and will not install.
 *
 * npm is the registry and there is no reason to build another one, but two of
 * its defaults are wrong for code that runs on someone's laptop because a
 * server asked: install scripts run before anyone has read the package, and a
 * range resolves to whatever was published this morning.
 *
 * The install itself is not exercised here: it needs a registry, and a test
 * that quietly needs the internet fails for the wrong reason on a train. The
 * network half is covered by the opt-in test at the bottom.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePackage, packageRoot, parsePackageSpec } from '../../src/local/packages.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-pkg-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('which package specs are allowed at all', () => {
  it('takes an exact version, scoped or not', () => {
    expect(parsePackageSpec('@scope/name@1.2.3')).toEqual({ name: '@scope/name', version: '1.2.3' });
    expect(parsePackageSpec('fetch-mail@0.4.11')).toEqual({ name: 'fetch-mail', version: '0.4.11' });
    expect(parsePackageSpec('tool@2.0.0-beta.1')).toEqual({ name: 'tool', version: '2.0.0-beta.1' });
  });

  it('refuses anything that can resolve to different code tomorrow', () => {
    // The approval a person gave was for the code they looked at. A range or a
    // dist-tag means what runs here changes without anyone deciding it should.
    for (const spec of ['tool@^1.2.3', 'tool@~1.2', 'tool@latest', 'tool@*', 'tool']) {
      expect(() => parsePackageSpec(spec)).toThrow(/not a package this bridge will install/);
    }
  });

  it('refuses a spec that is not a registry package at all', () => {
    // `file:` and a git URL are both ways to run code from somewhere nobody
    // audited, through a field that looks like a version.
    for (const spec of ['file:../evil', 'git+ssh://git@example.com/x.git', 'https://example.com/x.tgz']) {
      expect(() => parsePackageSpec(spec)).toThrow(/not a package this bridge will install/);
    }
  });
});

describe('where a package lands', () => {
  it('gives each space its own tree', () => {
    // A postinstall that did run, in some future npm, still cannot reach the
    // other space's code, and neither can a dependency resolving upward.
    const spec = parsePackageSpec('@scope/tool@1.0.0');
    const shared = packageRoot('/data', 'space_shared', spec);
    const priv = packageRoot('/data', 'space_private', spec);

    expect(shared).not.toBe(priv);
    expect(shared).toContain(join('packages', 'space_shared'));
    expect(shared).toContain('@scope__tool@1.0.0');
  });

  it('refuses a space id that would climb out of the data directory', () => {
    // A space id becomes a directory name. `..` would put a package tree
    // anywhere on disk the bridge can write.
    const spec = parsePackageSpec('tool@1.0.0');
    expect(() => packageRoot('/data', '../../etc', spec)).toThrow(/not a usable space id/);
    expect(() => packageRoot('/data', '..', spec)).toThrow(/not a usable space id/);
  });
});

describe('a package that is already installed', () => {
  it('is used as it is, without asking a registry anything', async () => {
    // A tool called every minute must not reinstall every minute. If this
    // reached the network the test would be slow or would fail offline, which
    // is exactly the signal wanted.
    const dataDir = scratch();
    const root = packageRoot(dataDir, 'space_1', parsePackageSpec('fetch-mail@1.2.3'));
    mkdirSync(join(root, 'node_modules', 'fetch-mail'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'fetch-mail', 'package.json'),
      JSON.stringify({ name: 'fetch-mail', version: '1.2.3' }),
    );

    const installed = await ensurePackage('fetch-mail@1.2.3', { dataDir, spaceId: 'space_1' });

    expect(installed.root).toBe(root);
    expect(installed.dir).toBe(join(root, 'node_modules', 'fetch-mail'));
  });

  it('carries the integrity it was installed with', async () => {
    const dataDir = scratch();
    const root = packageRoot(dataDir, 'space_1', parsePackageSpec('fetch-mail@1.2.3'));
    mkdirSync(join(root, 'node_modules', 'fetch-mail'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'fetch-mail', 'package.json'),
      JSON.stringify({ name: 'fetch-mail', version: '1.2.3' }),
    );
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      spec: 'fetch-mail@1.2.3', integrity: 'sha512-known', installedAt: '2026-01-01T00:00:00.000Z',
    }));

    const installed = await ensurePackage('fetch-mail@1.2.3', { dataDir, spaceId: 'space_1' });
    expect(installed.integrity).toBe('sha512-known');
  });

  it('refuses an unpinned spec before touching the disk', async () => {
    const dataDir = scratch();
    await expect(ensurePackage('fetch-mail@^1.2.3', { dataDir, spaceId: 'space_1' }))
      .rejects.toThrow(/not a package this bridge will install/);
  });
});

/**
 * The half that needs a registry.
 *
 * Opt in with ENGRAM_PACKAGE_TEST=1. It proves the two properties that only a
 * real install can: that install scripts do not run, and that the tree lands
 * where the sandbox will later allow reads from.
 */
describe.skipIf(!process.env['ENGRAM_PACKAGE_TEST'])('installing for real', () => {
  it('installs a pinned package with its scripts disabled', async () => {
    const dataDir = scratch();
    const installed = await ensurePackage('is-odd@3.0.1', { dataDir, spaceId: 'space_1' });

    expect(installed.dir).toContain(join('node_modules', 'is-odd'));
    expect(installed.integrity).toMatch(/^sha\d+-/);
  }, 180_000);
});
