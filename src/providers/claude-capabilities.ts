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

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { getBridgeWorkingDir, stripCredentials } from './env.js';

const log = createLogger('ClaudeCapabilities');

/** Operator kill switch, for a CLI whose partial output turns out to be wrong. */
const DISABLE_ENV_VAR = 'AI_BRIDGE_DISABLE_PARTIAL_STREAMING';

const PARTIAL_FLAG = '--include-partial-messages';


/** How the common CLI argument parsers word an unknown option. */
const OPTION_REJECTION = /(unknown|unrecognized|unrecognised|invalid|unexpected) (option|argument|flag)|not defined|no such option/i;

/**
 * Hard ceiling on the probe, enforced by us.
 *
 * The probe must never be able to stall a turn: the answer is cached, and the
 * adapter awaits it before the per-request timeout is armed, so one probe that
 * never settles would silently stop every Claude turn for the life of the
 * process — no error, no `done`, and nothing in the logs pointing at
 * `claude --help`.
 */
let probeTimeoutMs = 10_000;

/**
 * Shorten the probe timeout. TESTS ONLY.
 *
 * Exists because the behaviour worth testing here — that a wedged CLI and its
 * children are killed rather than waited on — can only be observed by letting
 * the timeout fire, and a ten-second unit test is one nobody runs.
 */
export function setProbeTimeoutForTests(ms: number): void {
  probeTimeoutMs = ms;
}

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
    // stripping every other spawn does. CLAUDECODE additionally has to go: the
    // CLI refuses to run when it is set, so a bridge running inside Claude Code
    // would probe as "unsupported" and quietly disable streaming everywhere.
    const env = stripCredentials({ ...process.env });
    delete env['CLAUDECODE'];

    let child: ChildProcess;
    try {
      // spawn, NOT execFile. execFile does not forward `detached` — its option
      // whitelist is cwd/env/gid/shell/signal/uid/windowsHide/
      // windowsVerbatimArguments — so a child started through it stays in the
      // bridge's own process group and a group kill throws ESRCH. An earlier
      // version of this file did exactly that and silently fell back to killing
      // the child alone, which is the case that does not need killing.
      //
      // The group matters for a `claude` that is a shell wrapper: SIGKILL
      // reaches the child, never its descendants, so a wrapper's background
      // work outlives the probe and the bridge.
      child = spawn('claude', ['--help'], {
        env,
        // Pinned like every other Claude spawn, so `--help` cannot walk a
        // project tree the operator did not point us at.
        cwd: getBridgeWorkingDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Scan for the flag as output arrives rather than buffering it all.
    //
    // Buffering with a cap gets this WRONG rather than merely large: a CLI that
    // prints past the cap before reaching the flag reports "unsupported", and
    // the operator loses streaming with nothing to explain it. Keeping only
    // enough tail to catch a match split across two chunks is both correct for
    // any output size and O(flag length) in memory.
    let found = false;
    let tail = '';
    let settled = false;

    // Detaching means the child no longer shares the bridge's process group, so
    // the operator's Ctrl-C reaches the bridge and not the probe. Without this,
    // a probe in flight — and, for a wrapper CLI, everything it started — would
    // outlive the bridge, with nothing left running to time it out. Measured:
    // before this, a wedged fake CLI was still running after its parent exited.
    const killOnExit = (): void => killTree(child);
    process.once('exit', killOnExit);

    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', killOnExit);
      act();
    };

    const onData = (chunk: Buffer): void => {
      if (found) return;
      const text = tail + chunk.toString();
      if (text.includes(PARTIAL_FLAG)) {
        found = true;
        tail = '';
        return;
      }
      tail = text.slice(-(PARTIAL_FLAG.length - 1));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', () => settle(() => resolve(found)));

    const timer = setTimeout(() => {
      // `found` is used, not `false`. The help text is often complete long
      // before the process is: a wrapper that exits while a background child
      // holds the inherited stdout open keeps the pipe from closing, and
      // answering `false` there would cache "unsupported" for the life of the
      // process even though the flag had already been read.
      log.warn(`claude --help did not finish within ${probeTimeoutMs}ms — using what it printed so far`);
      killTree(child);
      settle(() => resolve(found));
    }, probeTimeoutMs);

    // Nothing should keep the process alive for a probe.
    timer.unref?.();
  });
}

/**
 * Kill a probe and everything it started, and let the event loop go.
 *
 * Two separate jobs, because either one alone leaves a failure standing.
 *
 * The KILL uses a negative pid to signal the whole process group, which is the
 * only way to reach a wrapper script's children.
 *
 * The PIPE TEARDOWN is what actually lets the bridge exit. A wrapper that exits
 * while a background child still holds the inherited stdout leaves the child
 * reaped but the pipe open, and libuv keeps the handle referenced, so the loop
 * never drains and the process hangs — measured, and worse than the execFile
 * version this replaced, which destroyed the pipes on its own timeout path.
 * The exit hook cannot save this: `process.once('exit')` only fires once the
 * loop has drained, which is exactly what is not happening.
 *
 * Deliberately NOT guarded on the child having exited. That guard looked
 * prudent — a reaped pid can in principle be recycled, and `-pid` would then
 * signal a stranger's group — but it disabled the kill in the one shape that
 * needs it, and the premise is wrong anyway: while any member of the group is
 * alive the group id keeps the leader's pid reserved, so it cannot be recycled.
 * This is only ever called from the timeout path, before the probe settles.
 */
function killTree(child: ChildProcess): void {
  let signalled = false;
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      signalled = true;
    }
  } catch {
    // Never became a group leader, or the group is already gone.
  }

  if (!signalled) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  }

  // Unconditional: a grandchild that put itself in another process group
  // survives the kill above, and its inherited pipe would still pin the loop.
  child.stdout?.destroy();
  child.stderr?.destroy();
}
