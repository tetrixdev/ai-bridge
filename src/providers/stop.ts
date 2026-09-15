import type { ChildProcess } from 'node:child_process';
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
export function stopTurn(child: ChildProcess, why: { requestId: string; provider: string }): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  log.info('Ending the turn', { ...why, signal: 'SIGINT' });
  child.kill('SIGINT');

  const escalate = (signal: NodeJS.Signals, after: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      log.warn('The CLI did not stop — escalating', { ...why, signal });
      child.kill(signal);
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
