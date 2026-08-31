/**
 * Installing the npm package a local tool lives in.
 *
 * There is no reason to invent a registry. npm already resolves, caches and
 * integrity-checks tarballs, and every tool author already knows how to
 * publish to it. What npm does badly is run arbitrary code from a package
 * during install, before anyone has looked at it, and that is one flag:
 * `--ignore-scripts`. So this module is npm with its worst hole closed, plus
 * three rules of its own:
 *
 *   Pinned exactly. `name@1.2.3` and nothing else. A range or a dist-tag means
 *   what runs on this machine changes without anyone deciding it should, and
 *   the approval a person gave was for the code they looked at.
 *
 *   Integrity remembered. npm verifies a tarball against the integrity hash
 *   the registry advertises; this records the hash that was installed and
 *   refuses a later install of the same spec that resolves to a different one.
 *   An exact version whose bytes changed is the interesting case, and npm
 *   alone would install it without comment.
 *
 *   One directory per space. A tool from a shared space and a tool from a
 *   private space do not share a node_modules tree, so a postinstall that did
 *   run (a dependency of a dependency, on some future npm) cannot reach the
 *   other space's code.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('LocalPackages');

/** How long an install may take before it is killed. Registries are slow sometimes. */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * A package spec this bridge will install: a name, an `@`, and an exact
 * version. No ranges (`^1.2.3`), no tags (`latest`), no URLs, no `file:`.
 */
const PINNED_SPEC = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?([a-z0-9-~][a-z0-9-._~]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** A space id may become a directory name, so it may not become `..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PackageSpec {
  /** `@scope/name` or `name`. */
  name: string;
  /** An exact version, never a range. */
  version: string;
}

export interface InstalledPackage {
  spec: PackageSpec;
  /** The install root. Holds node_modules; this is what node may read. */
  root: string;
  /** The package itself, `<root>/node_modules/<name>`. Tools run with this as cwd. */
  dir: string;
  /** The integrity hash npm resolved, when it recorded one. */
  integrity?: string;
}

/** What was installed here before, so a changed tarball is visible. */
interface InstallRecord {
  spec: string;
  integrity?: string;
  installedAt: string;
}

export function parsePackageSpec(spec: string): PackageSpec {
  const match = PINNED_SPEC.exec(spec.trim());
  if (!match) {
    throw new Error(
      `"${spec}" is not a package this bridge will install. Give an exact version, ` +
      `as in "@scope/name@1.2.3": a range or a dist-tag means the code running on ` +
      `this machine can change without anyone approving the change.`,
    );
  }
  return { name: `${match[1] ?? ''}${match[2]}`, version: match[3]! };
}

/** Where a space's copy of a package lives. Pure, so a test need not install. */
export function packageRoot(dataDir: string, spaceId: string, spec: PackageSpec): string {
  if (!SAFE_SEGMENT.test(spaceId)) {
    throw new Error(
      `"${spaceId}" is not a usable space id: it becomes a directory name, so it may ` +
      `hold only letters, digits, ".", "-" and "_".`,
    );
  }
  const leaf = `${spec.name.replace('/', '__')}@${spec.version}`;
  return join(resolve(dataDir), 'packages', spaceId, leaf);
}

/**
 * Make sure this space has this package, and hand back where it is.
 *
 * Idempotent and quiet on the happy path: an install that is already there is
 * a `package.json` read, not a network call, so a tool that is called every
 * minute does not reinstall every minute.
 */
export async function ensurePackage(
  spec: string,
  options: { dataDir: string; spaceId: string; timeoutMs?: number },
): Promise<InstalledPackage> {
  const parsed = parsePackageSpec(spec);
  const root = packageRoot(options.dataDir, options.spaceId, parsed);
  const dir = join(root, 'node_modules', parsed.name);
  const recordPath = join(root, 'installed.json');

  const installed = await readVersion(join(dir, 'package.json'));
  if (installed === parsed.version) {
    const record = await readRecord(recordPath);
    return { spec: parsed, root, dir, ...(record?.integrity ? { integrity: record.integrity } : {}) };
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  // A private manifest, so npm treats this directory as a project of its own
  // rather than walking up and installing into whatever it finds above.
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'engram-local-tools', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

  log.info('installing a local tool package', { spec, space: options.spaceId, root });
  await npmInstall(`${parsed.name}@${parsed.version}`, root, options.timeoutMs ?? INSTALL_TIMEOUT_MS);

  const version = await readVersion(join(dir, 'package.json'));
  if (version !== parsed.version) {
    throw new Error(
      `installing ${spec} did not produce ${parsed.name}@${parsed.version} ` +
      `(found ${version ?? 'nothing'}). Refusing to run it.`,
    );
  }

  const integrity = await resolvedIntegrity(root, parsed.name);
  const previous = await readRecord(recordPath);
  if (previous?.integrity && integrity && previous.integrity !== integrity) {
    // Same name, same version, different bytes. npm would install it without
    // a word; this is the one case where saying nothing is indefensible.
    throw new Error(
      `${spec} now resolves to different bytes than the copy this machine installed ` +
      `before (${previous.integrity} then, ${integrity} now). Refusing to run it. ` +
      `Delete ${root} to accept the new tarball deliberately.`,
    );
  }

  const record: InstallRecord = {
    spec: `${parsed.name}@${parsed.version}`,
    ...(integrity ? { integrity } : {}),
    installedAt: new Date().toISOString(),
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  return { spec: parsed, root, dir, ...(integrity ? { integrity } : {}) };
}

async function readVersion(manifestPath: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string };
    return raw.version;
  } catch {
    return undefined;
  }
}

async function readRecord(path: string): Promise<InstallRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as InstallRecord;
  } catch {
    return undefined;
  }
}

/** The integrity npm wrote into the tree's own lockfile, when it wrote one. */
async function resolvedIntegrity(root: string, name: string): Promise<string | undefined> {
  for (const file of ['node_modules/.package-lock.json', 'package-lock.json']) {
    try {
      const lock = JSON.parse(await readFile(join(root, file), 'utf8')) as {
        packages?: Record<string, { integrity?: string }>;
      };
      const entry = lock.packages?.[`node_modules/${name}`];
      if (entry?.integrity) return entry.integrity;
    } catch {
      // No lockfile in this shape. The record simply carries no integrity.
    }
  }
  return undefined;
}

/**
 * Run npm, with install scripts off in both the flag and the environment.
 *
 * The flag covers the install; the environment variable covers anything npm
 * itself shells out to. No shell here either: the spec has already been
 * matched against PINNED_SPEC, but composing a command line out of a value
 * that arrived over a WebSocket is a habit worth not having.
 */
function npmInstall(spec: string, cwd: string, timeoutMs: number): Promise<void> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'install', spec,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    '--save-exact',
    '--loglevel=error',
  ];

  return new Promise<void>((settle, fail) => {
    const child = spawn(npm, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        // npm asks for a tty for progress and confirmations; it must never
        // wait for one here, since nobody is watching this run.
        npm_config_progress: 'false',
        npm_config_yes: 'true',
      },
    });

    let stderr = '';
    child.stdout.on('data', (c: Buffer) => log.debug('npm', { out: c.toString('utf8').trim() }));
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`installing ${spec} took longer than ${Math.round(timeoutMs / 1000)}s and was killed`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      fail(new Error(`could not run npm to install ${spec}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) settle();
      else fail(new Error(`npm exited ${code} installing ${spec}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
