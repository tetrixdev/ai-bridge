import { execFileSync, type ChildProcess } from 'node:child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StopTurn');

/**
 * How long each signal is given before the next one, in milliseconds.
 *
 * SIGINT has to survive whatever the CLI is doing when it arrives — a model
 * request in flight, a tool that has just started — and ending a turn cleanly
 * means writing the session out, so it is not instant. Five seconds is long
 * enough for that and short enough that a person watching a stopped turn does
 * not wonder whether the button worked.
 */
const GRACE_MS = 5_000;

/**
 * Stop a CLI turn, and leave a session somebody can resume.
 *
 * **The signal matters, and SIGTERM is the wrong one.** Anthropic's headless
 * documentation is explicit: SIGTERM "leaves the turn that was in progress
 * unfinished and records no result for it", a command that was running is
 * "recorded as killed in the session", and — the part that bites — "when you
 * resume the session, Claude Code continues the turn that SIGTERM left
 * unfinished". SIGINT ends the turn instead.
 *
 * That difference was watched in production rather than read here first. A turn
 * stopped by a bound mid-way through a run of tools was SIGTERMed; the next
 * message resumed that session, the CLI carried on with the turn it had been
 * stopped in, and this bridge logged "tool result received after stream settled
 * — dropping" once per result for five minutes while the server heard nothing
 * at all. The conversation could not be used again.
 *
 * So: SIGINT, then escalate only if it is ignored. A CLI that has not exited
 * five seconds after being asked to end its turn is not going to, and a
 * conversation left holding a process forever is worse than a session that
 * needs replaying.
 */
/**
 * Did WE stop this turn — a server's cancel, or one of our own bounds?
 *
 * If so, the reason belongs to the bridge and not to the CLI, and an adapter
 * must not report what the CLI says on its way out. SIGINT is the signal that
 * asks a CLI to wind down rather than killing it outright, which is exactly why
 * it commonly writes one last error frame before it goes: "interrupted",
 * "error_during_execution". Reporting that tells a server the turn FAILED, when
 * what happened is that it was stopped — and on a resumed turn an error is what
 * `session_lost` is read from, so the server would wipe the session and
 * re-issue the turn somebody had just stopped.
 *
 * Shared rather than repeated per adapter: this is four branches across three
 * CLIs, and the next adapter would be the fifth place to forget it.
 *
 * @param signal the turn's abort signal — a server cancel, a disconnect
 * @param timeouts the turn's clocks, if it has any
 */
export function stoppedByUs(signal: AbortSignal, timeouts: { reason(): string | null } | null): boolean {
  return signal.aborted || (timeouts?.reason() ?? null) !== null;
}

/**
 * Signal the CLI's whole process group, or the CLI alone where there is none.
 *
 * spawnCli() starts every CLI `detached`, so it leads a group of its own and
 * `-pid` reaches everything in it. A child that is not a group leader (a test
 * double, a Windows process) gets the plain signal.
 */
function signalTurn(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);

      return;
    } catch {
      // Not a group leader, or the group is already gone: fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Every process descended from `pid`, as `[pid, pgid]` pairs. Best effort:
 * empty when `ps` is unavailable or fails.
 *
 * Needed because Claude Code runs each shell command in a session of its OWN
 * (measured on 2.1.280: the Bash tool's shell has pgid = sid = its own pid), so
 * a background command is NOT in the CLI's group. SIGINT is enough for that:
 * the CLI stops its own tasks on the way out (measured: nothing survives).
 * SIGKILL is not: the CLI gets no chance, its commands are re-parented to init
 * and run on (measured: a background `sleep` survived a group SIGKILL). So the
 * last step finds them first — while they are still the CLI's descendants —
 * and kills their groups as well.
 */
function descendantsOf(pid: number): Array<[number, number]> {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const children = new Map<number, Array<[number, number]>>();
  for (const line of table.split('\n')) {
    const [p, pp, pg] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(p) || !Number.isInteger(pp) || !Number.isInteger(pg)) continue;
    const list = children.get(pp) ?? [];
    list.push([p, pg]);
    children.set(pp, list);
  }

  const found: Array<[number, number]> = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const entry of children.get(queue.shift()!) ?? []) {
      found.push(entry);
      queue.push(entry[0]);
    }
  }

  return found;
}

/** SIGKILL the CLI's group and every group its descendants lead. */
function killTurn(child: ChildProcess): void {
  const own = process.platform !== 'win32' ? safePgid() : null;
  const strays = process.platform !== 'win32' && child.pid !== undefined ? descendantsOf(child.pid) : [];
  signalTurn(child, 'SIGKILL');
  for (const [pid, pgid] of strays) {
    try {
      // Never our own group: that would be the bridge killing itself.
      if (pgid !== own && pgid > 1) process.kill(-pgid, 'SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function safePgid(): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pgid = Number(out.trim());

    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

export function stopTurn(child: ChildProcess, why: { requestId: string; provider: string }): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  // The whole group, not the CLI alone: with background tasks on, a turn owns
  // more than one process, and stopping the turn must stop what it started.
  log.info('Ending the turn', { ...why, signal: 'SIGINT' });
  signalTurn(child, 'SIGINT');

  const escalate = (signal: NodeJS.Signals, after: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      log.warn('The CLI did not stop — escalating', { ...why, signal });
      if (signal === 'SIGKILL') killTurn(child);
      else signalTurn(child, signal);
    }, after);
    timer.unref?.();

    return timer;
  };

  const term = escalate('SIGTERM', GRACE_MS);
  const kill = escalate('SIGKILL', GRACE_MS * 2);

  // Nothing to escalate to once it is gone, and a timer that fires against a
  // recycled pid is the kind of bug that is impossible to reproduce.
  child.once('exit', () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
}
