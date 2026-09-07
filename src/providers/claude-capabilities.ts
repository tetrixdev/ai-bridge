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
 * Record that the CLI rejected our flag, and stop passing it.
 *
 * Without this a probe that answered "supported" for a CLI that then rejects
 * the flag would fail EVERY turn, for the life of the process — exactly the
 * failure the probe exists to prevent, reached through the probe.
 *
 * It records `false` rather than clearing the cache. Clearing only helps when
 * the probe's answer went STALE (the CLI was replaced under a running bridge);
 * when the answer was simply WRONG, re-probing asks the same unchanged CLI the
 * same question, gets the same answer, and the turn fails again — forever. The
 * argv parser is the authority here and `--help` is only its description, so
 * the parser's verdict wins and is not re-litigated.
 */
export function noteCliRejectedPartialFlag(stderr: string): boolean {
  // Both halves are required. A CLI that DOES support the flag and prints its
  // own option list on an unrelated failure mentions the flag too, and taking
  // that as a rejection would re-probe after every such turn.
  if (!stderr.includes(PARTIAL_FLAG) || !OPTION_REJECTION.test(stderr)) return false;
  log.warn(`Claude CLI rejected ${PARTIAL_FLAG} — streaming whole messages from now on`);
  cached = Promise.resolve(false);
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
    // stripping every other spawn does. CLAUDECODE goes too, matching what the
    // adapter does for a real turn (claude.ts refuses to run with it set). On
    // 2.1.261 `--help` happens to work either way, so this is consistency with
    // the spawn that matters rather than a fix for an observed failure.
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
    let settled = false;

    // Detaching means the child no longer shares the bridge's process group, so
    // the operator's Ctrl-C reaches the bridge and not the probe. Without this,
    // a probe in flight — and, for a wrapper CLI, everything it started — would
    // outlive the bridge, with nothing left running to time it out. Measured:
    // before this, a wedged fake CLI was still running after its parent exited.
    const killOnExit = (): void => killTree(child);
    process.once('exit', killOnExit);

    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', killOnExit);
      act();
    };

    // ONE scanner per stream. A shared carry-over buffer is wrong in both
    // directions: stderr clobbers the tail stdout was mid-match on (a flag
    // that IS present reads as absent), and a tail ending mid-flag on one
    // stream can complete against the start of the other (a flag that is in
    // neither stream reads as present, and the bridge then passes a fatal one).
    const makeScanner = () => {
      let tail = '';
      return (chunk: Buffer): void => {
        if (found) return;
        const text = tail + chunk.toString();
        if (text.includes(PARTIAL_FLAG)) {
          found = true;
          tail = '';
          return;
        }
        tail = text.slice(-(PARTIAL_FLAG.length - 1));
      };
    };
    child.stdout?.on('data', makeScanner());
    child.stderr?.on('data', makeScanner());

    // A pipe read error must not become an uncaughtException: this function
    // promises never to throw, and an unhandled stream error would take the
    // whole bridge down rather than merely failing the probe. Same reason
    // base.ts attaches one to the child's stdin.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', () => settle(() => resolve(found)));

    timer = setTimeout(() => {
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
 * Deliberately NOT guarded on the child having exited, which is an accepted
 * trade rather than a free one. Such a guard disabled the kill in the shape
 * that needs it most — a wrapper reaped while the children it started live on —
 * so it went. What remains is a genuine race inherent to pid-based group kills:
 * if the whole group is already gone, the pid can have been recycled, and
 * `-pid` is then aimed at whatever holds that group now. Measured in the
 * pipe-hold shape, `kill(-pid, 0)` reports ESRCH at this point, so the window
 * is real and not merely theoretical.
 *
 * It is accepted because the alternative leaks orphaned processes on every
 * wedged probe, the window is one scheduling quantum wide, and the pipe
 * teardown below — not the kill — is what actually lets the bridge exit.
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
