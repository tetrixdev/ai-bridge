/**
 * What the locally installed Claude CLI can do.
 *
 * `--include-partial-messages` is not available on every version, and an
 * unknown flag is fatal: the CLI exits non-zero before producing a single
 * event, so a bridge that passed it blindly would answer nothing at all on an
 * older machine. Lumpy output is a far better failure than no output, so
 * support is PROBED rather than assumed, and anything unexpected resolves to
 * "unsupported" and the existing whole-message path.
 *
 * The probe is one `claude --help` (~0.4s locally), run at most once per
 * process and shared by every concurrent request through the cached promise.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { getBridgeWorkingDir, stripCredentials } from './env.js';

const log = createLogger('ClaudeCapabilities');

/** Operator kill switch, for a CLI whose partial output turns out to be wrong. */
const DISABLE_ENV_VAR = 'AI_BRIDGE_DISABLE_PARTIAL_STREAMING';

const PARTIAL_FLAG = '--include-partial-messages';

/** How the common CLI argument parsers word an unknown option. */
const OPTION_REJECTION = /(unknown|unrecognized|unrecognised|invalid|unexpected) (option|argument|flag)/i;

/**
 * Hard ceiling on the probe, enforced by us rather than by execFile.
 *
 * `execFile`'s own `timeout` only SENDS a signal; the promise settles when the
 * child's `close` fires. A child that ignores SIGTERM therefore leaves it
 * pending forever — measured, not assumed. That matters far more here than it
 * looks: the result is cached, and the adapter awaits it before the per-request
 * timeout is armed, so a single hung probe would silently stall every Claude
 * turn for the life of the process with no error, no `done`, and nothing in the
 * logs pointing at `claude --help`.
 */
const PROBE_TIMEOUT_MS = 10_000;

let cached: Promise<boolean> | null = null;

/**
 * Does this machine's `claude` accept `--include-partial-messages`?
 *
 * Never throws and never hangs: a missing binary, a timeout, a wedged child, or
 * help text in an unexpected shape all report `false`, which costs granularity
 * and nothing else.
 */
export function supportsPartialMessages(): Promise<boolean> {
  if (cached === null) cached = probe();
  return cached;
}

/** Reset the cached probe. Tests, and the downgrade recovery below. */
export function resetPartialMessageSupportCache(): void {
  cached = null;
}

/**
 * Re-probe on the next turn if this looks like the CLI rejecting our flag.
 *
 * The cache is what makes a mid-session DOWNGRADE unrecoverable: probed once as
 * supported, the bridge would keep passing a flag the newly installed CLI does
 * not have, and every turn would die before emitting anything until someone
 * restarted the bridge — reintroducing precisely the failure the probe exists
 * to prevent. Clearing the cache turns that into a single failed turn.
 */
export function noteCliRejectedPartialFlag(stderr: string): boolean {
  // Both halves are required. A CLI that DOES support the flag and prints its
  // own option list on an unrelated failure mentions the flag too, and taking
  // that as a rejection would re-probe after every such turn.
  if (!stderr.includes(PARTIAL_FLAG) || !OPTION_REJECTION.test(stderr)) return false;
  log.warn(`Claude CLI rejected ${PARTIAL_FLAG} — re-probing before the next turn`);
  resetPartialMessageSupportCache();
  return true;
}

async function probe(): Promise<boolean> {
  const override = process.env[DISABLE_ENV_VAR];
  if (override !== undefined && override !== '' && override !== '0') {
    log.info(`${DISABLE_ENV_VAR} is set — streaming whole messages instead of partial chunks`);
    return false;
  }

  try {
    const supported = await runHelpProbe();
    log.info(supported
      ? 'Claude CLI supports partial message streaming'
      : `Claude CLI does not list ${PARTIAL_FLAG} — falling back to whole-message streaming`);
    return supported;
  } catch (err) {
    log.debug('Could not probe Claude CLI for partial message support', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Run `claude --help` under a timeout we control, and say whether it lists the flag. */
function runHelpProbe(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    // The probe runs a binary off PATH, so it gets the same credential
    // stripping every other spawn does. CLAUDECODE additionally has to go:
    // the CLI refuses to run when it is set, so a bridge running inside Claude
    // Code would probe as "unsupported" and quietly disable streaming
    // everywhere.
    const env = stripCredentials({ ...process.env });
    delete env['CLAUDECODE'];

    let settled = false;

    const child = execFile('claude', ['--help'], {
      // SIGKILL rather than the default SIGTERM, so a child that traps TERM
      // cannot outlive its own timeout. Note this reaches the child only —
      // hence the process-group kill below, for a `claude` that is a shell
      // wrapper whose grandchildren would otherwise survive the probe.
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // Own process group, so the whole tree can be signalled at once.
      ...(process.platform === 'win32' ? {} : { detached: true }),
      env,
      // Pinned like every other Claude spawn, so `--help` cannot walk a project
      // tree the operator did not point us at.
      cwd: getBridgeWorkingDir(),
    }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return void reject(err);
      resolve(((stdout || '') + (stderr || '')).includes(PARTIAL_FLAG));
    });

    // The backstop for the case execFile's own timeout cannot handle. Resolves
    // rather than rejects, so the answer is the safe one either way.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn(`claude --help did not finish within ${PROBE_TIMEOUT_MS}ms — assuming no partial message support`);
      killTree(child);
      resolve(false);
    }, PROBE_TIMEOUT_MS + 500);

    // Nothing should keep the process alive for a probe.
    timer.unref?.();
  });
}

/**
 * Kill a probe and anything it started.
 *
 * A negative pid signals the whole process group, which is the only way to
 * reach a wrapper script's children — measured: with a `claude` that traps
 * SIGTERM and runs `sleep`, killing just the child left the sleep running
 * after both the probe and the bridge had exited.
 */
function killTree(child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean }): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // The group may already be gone, or never became a group leader.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already dead.
  }
}
