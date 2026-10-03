/**
 * Is this bridge a service that a restart will bring back on a new version?
 *
 * Self-update ends with the bridge pinning a version in its service's env file
 * and exiting. That is only safe when something WILL start it again, and will
 * start the version just written rather than whatever it ran before. So
 * instead of being told a path, the bridge asks systemd about its own unit and
 * acts only when all of this holds:
 *
 *  - it runs inside a systemd service (INVOCATION_ID, and a `.service` in its
 *    own cgroup), which is what tells a service from a person's terminal;
 *  - that unit restarts it after an exit (`Restart=always` or `on-failure`;
 *    the bridge exits non-zero, so both bring it back);
 *  - the unit's start command takes the version from the environment
 *    (`@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}`), so the pin is what runs;
 *  - exactly one of its env files sets AI_BRIDGE_VERSION, and it is writable.
 *
 * Anything else, and the bridge only logs that the server wants another
 * version. An unpinned unit in particular would come back on whatever npx
 * resolves, and the bridge would restart forever trying to change it.
 *
 * AI_BRIDGE_ENV_FILE names the env file explicitly, for a unit that loads
 * more than one; every other check still applies.
 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const PACKAGE = '@tetrixdev/ai-bridge';

/** A service this bridge can update itself through. */
export interface ManagedService {
  kind: 'systemd';
  scope: 'user' | 'system';
  unit: string;
  envFile: string;
}

export type Detection = { managed: ManagedService } | { reason: string };

/** What detect() reads from the machine, injectable for tests. */
export interface DetectDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readCgroup: () => string;
  showUnit: (scope: 'user' | 'system', unit: string) => string;
  readFile: (path: string) => string;
  writable: (path: string) => boolean;
}

export const realDetectDeps: DetectDeps = {
  env: process.env,
  platform: process.platform,
  readCgroup: () => readFileSync('/proc/self/cgroup', 'utf8'),
  showUnit: (scope, unit) => execFileSync(
    'systemctl',
    [...(scope === 'user' ? ['--user'] : []), 'show', unit, '-p', 'Restart', '-p', 'ExecStart', '-p', 'EnvironmentFiles', '--no-pager'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
  ),
  readFile: (path) => readFileSync(path, 'utf8'),
  writable: (path) => {
    try {
      accessSync(path, constants.W_OK);
      accessSync(dirname(realpathSync(path)), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

const VERSION_LINE = /^\s*(?:export\s+)?AI_BRIDGE_VERSION\s*=/m;
const PINNED_EXEC = /@tetrixdev\/ai-bridge@(?:\$\{AI_BRIDGE_VERSION\}|\$AI_BRIDGE_VERSION)(?:\s|$|;)/;

export function detect(deps: DetectDeps = realDetectDeps): Detection {
  if (deps.platform !== 'linux') {
    return { reason: `self-update needs systemd; on ${deps.platform} the version is updated by hand` };
  }
  if (!deps.env['INVOCATION_ID']) return { reason: 'not running as a systemd service' };

  let cgroup: string;
  try {
    cgroup = deps.readCgroup();
  } catch {
    return { reason: 'could not read this process\'s cgroup' };
  }
  // cgroup v2: one line, `0::/user.slice/.../app.slice/name.service`. Under
  // v1 the systemd hierarchy carries the same path.
  const line = cgroup.split('\n').find((l) => l.startsWith('0::')) ?? cgroup.split('\n').find((l) => l.includes(':name=systemd:'));
  const path = line?.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) ?? '';
  const unit = path.split('/').reverse().find((seg) => seg.endsWith('.service'));
  if (!unit || unit.startsWith('user@')) return { reason: 'could not tell which systemd unit runs this bridge' };
  const scope: 'user' | 'system' = /\/user@\d+\.service\//.test(path) ? 'user' : 'system';

  let shown: string;
  try {
    shown = deps.showUnit(scope, unit);
  } catch {
    return { reason: `systemctl show ${unit} failed` };
  }
  const props = parseShow(shown);

  const restart = props.get('Restart') ?? '';
  if (restart !== 'always' && restart !== 'on-failure') {
    return { reason: `${unit} has Restart=${restart || 'no'}; it would not come back after an update` };
  }
  if (!PINNED_EXEC.test(props.get('ExecStart') ?? '')) {
    return { reason: `${unit} does not start ${PACKAGE}@\${AI_BRIDGE_VERSION}, so a pinned version would not take effect` };
  }

  const explicit = deps.env['AI_BRIDGE_ENV_FILE'];
  const listed = (props.get('EnvironmentFiles') ?? '')
    .split('\n')
    .map((l) => l.replace(/\s*\(ignore_errors=\w+\)\s*$/, '').trim())
    .filter(Boolean);
  const candidates = explicit ? [explicit] : listed;
  const withVersion = candidates.filter((file) => {
    try {
      return VERSION_LINE.test(deps.readFile(file));
    } catch {
      return false;
    }
  });
  if (withVersion.length !== 1) {
    return {
      reason: withVersion.length === 0
        ? `no env file of ${unit} sets AI_BRIDGE_VERSION`
        : `more than one env file of ${unit} sets AI_BRIDGE_VERSION; name one with AI_BRIDGE_ENV_FILE`,
    };
  }
  const envFile = withVersion[0]!;
  if (!deps.writable(envFile)) return { reason: `${envFile} is not writable by this bridge` };

  return { managed: { kind: 'systemd', scope, unit, envFile } };
}

/**
 * `systemctl show` output as a map. A property can repeat (EnvironmentFiles
 * does, once per file); repeats are joined with newlines.
 */
export function parseShow(out: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    props.set(key, props.has(key) ? `${props.get(key)}\n${value}` : value);
  }
  return props;
}

/**
 * Pin a version in the env file, keeping every other line as it was.
 *
 * The previous version is kept beside it, as AI_BRIDGE_PREVIOUS_VERSION, so a
 * person rolling back by hand knows what to roll back to. Written to a
 * temporary file in the same directory and renamed over the original, so a
 * crash mid-write leaves the old file whole rather than a truncated one with
 * the token cut off.
 */
export function pinVersion(envFile: string, version: string, previous: string): void {
  const target = realpathSync(envFile);
  const before = readFileSync(target, 'utf8');
  const lines = before.split('\n');
  const set = (key: string, value: string): void => {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else {
      // Before a trailing empty line, so the file keeps ending in a newline.
      const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      lines.splice(end, 0, `${key}=${value}`);
    }
  };
  set('AI_BRIDGE_VERSION', version);
  set('AI_BRIDGE_PREVIOUS_VERSION', previous);
  const mode = statSync(target).mode & 0o777;
  const tmp = join(dirname(target), `.${Date.now()}-${process.pid}.ai-bridge-env.tmp`);
  writeFileSync(tmp, lines.join('\n'), { mode });
  renameSync(tmp, target);
}

/** What prefetch() runs and touches, injectable for tests. */
export interface PrefetchDeps {
  /** Runs npx; resolves with what it printed, and the error when it failed. */
  run: (args: string[], timeoutMs: number) => Promise<{ error: Error | null; killed: boolean; stdout: string; stderr: string }>;
  lockDir: string;
  /** How long to wait for another bridge on this machine to finish fetching. */
  lockWaitMs: number;
  /** A lock older than this was left by a process that died. */
  lockStaleMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const realPrefetchDeps: PrefetchDeps = {
  run: (args, timeoutMs) => new Promise((resolve) => {
    execFile('npx', args, { cwd: tmpdir(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        error: err,
        killed: Boolean((err as { killed?: boolean } | null)?.killed),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  }),
  lockDir: join(homedir(), '.cache', 'ai-bridge', 'prefetch.lock'),
  lockWaitMs: 5 * 60_000,
  lockStaleMs: 10 * 60_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Make sure a version exists and can be fetched, by fetching it into the npx
 * cache and running it once.
 *
 * `--prefer-online` so a cached copy of an older resolution cannot stand in
 * for it; `--version` so what comes back is the version itself saying its own
 * number, which proves the package installed and starts, not merely that a
 * tarball downloaded. Never throws: resolves with the reason it failed.
 *
 * One fetch at a time per machine. Two npx installs of the same version write
 * into the same cache directory, and when they overlap the result can be half
 * a package (seen 2026-10-03: @modelcontextprotocol/sdk without its
 * package.json), after which every later npx run of that version reuses the
 * broken directory and fails. Several bridges on one machine told to update at
 * once is exactly that overlap, so the fetch takes a lock first.
 *
 * And a directory broken anyway (by something else's npx, or a crash mid
 * install) is repaired: when the run fails because a module is missing from
 * an npx cache directory that holds THIS version, that directory is removed
 * and the fetch tried once more.
 */
export async function prefetch(
  version: string,
  timeoutMs = 180_000,
  deps: PrefetchDeps = realPrefetchDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // "Never throws" is what the updater's retry depends on: it schedules the
  // next attempt only on a failure RESULT. A lock directory that cannot be
  // made, or a broken one that cannot be removed, must come back as one.
  try {
    return await prefetchLocked(version, timeoutMs, deps);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function prefetchLocked(
  version: string,
  timeoutMs: number,
  deps: PrefetchDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const locked = await acquireLock(deps);
  if (!locked) return { ok: false, reason: 'another bridge on this machine has been fetching for too long' };
  try {
    const args = ['-y', '--prefer-online', '--ignore-scripts', `${PACKAGE}@${version}`, '--version'];
    let result = await deps.run(args, timeoutMs);
    if (result.error) {
      const broken = brokenNpxDir(`${result.stderr}\n${result.error.message}`, version);
      if (broken) {
        rmSync(broken, { recursive: true, force: true });
        result = await deps.run(args, timeoutMs);
      }
    }
    const said = result.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (result.error) {
      return { ok: false, reason: result.killed ? 'timed out' : result.error.message.split('\n')[0] ?? 'failed' };
    }
    if (said !== version) return { ok: false, reason: `it reported version "${said}"` };
    return { ok: true };
  } finally {
    try { rmSync(deps.lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** mkdir is atomic: whoever creates the directory holds the lock. */
async function acquireLock(deps: PrefetchDeps): Promise<boolean> {
  mkdirSync(dirname(deps.lockDir), { recursive: true });
  const deadline = Date.now() + deps.lockWaitMs;
  for (;;) {
    try {
      mkdirSync(deps.lockDir);
      return true;
    } catch {
      try {
        if (Date.now() - statSync(deps.lockDir).mtimeMs > deps.lockStaleMs) {
          rmSync(deps.lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between the two calls
      }
    }
    if (Date.now() >= deadline) return false;
    await deps.sleep(2000);
  }
}

/**
 * The npx cache directory a "Cannot find module" error points into, when that
 * directory holds this very version of the bridge, so removing it is safe:
 * nothing runs from an install that cannot start. Null otherwise.
 */
export function brokenNpxDir(errorText: string, version: string): string | null {
  if (!/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(errorText)) return null;
  const m = /((?:\/|[A-Za-z]:\\)[^\s'"]*?[\/\\]_npx[\/\\][0-9a-f]+)[\/\\]node_modules[\/\\]/.exec(errorText);
  if (!m) return null;
  const dir = m[1]!;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', '@tetrixdev', 'ai-bridge', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version === version ? dir : null;
  } catch {
    return null;
  }
}
