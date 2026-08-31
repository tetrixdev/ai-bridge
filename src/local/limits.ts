/**
 * How fast a space may run local tools.
 *
 * A local call spawns a process on someone's laptop. A panel with a render
 * loop, or a retry that does not back off, calls at UI speed, and without a
 * limit the bridge answers by forking at UI speed: hundreds of processes, each
 * holding a decrypted credential, on a machine that was doing something else.
 * Nothing about that is hypothetical or malicious. It is an ordinary front-end
 * bug reaching the far side of a WebSocket.
 *
 * Two limits, and each catches what the other cannot:
 *
 *   A concurrency cap bounds how many run AT ONCE, which is what stops the
 *   machine falling over. It refuses rather than queues: an unbounded queue is
 *   the same fork bomb with a delay, and a refusal is something the caller can
 *   see and fix.
 *
 *   A minimum interval bounds how many run PER SECOND, which the cap alone
 *   does not: a tool that finishes in 20ms never reaches the cap however fast
 *   it is called. This one waits rather than refuses, because spacing out two
 *   legitimate calls costs a moment and refusing them costs a feature. The cap
 *   is what keeps the waiting bounded: a call waiting for its slot is holding
 *   one, so at most `maxConcurrent` are ever in the room.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('LocalLimits');

/** Two at once per space. Enough for a panel that runs a pair side by side. */
export const MAX_CONCURRENT_PER_SPACE = 2;

/** A quarter second between starts. Slow for a render loop, invisible to a person. */
export const MIN_INTERVAL_MS = 250;

export interface LimiterOptions {
  maxConcurrent?: number;
  minIntervalMs?: number;
}

/** Thrown when a space is already running as much as it is allowed to. */
export class TooManyLocalCalls extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyLocalCalls';
  }
}

export class SpaceLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  /** In flight per space, counting calls still waiting out the interval. */
  private readonly inFlight = new Map<string, number>();
  /** When the most recent call for a space was allowed to start. */
  private readonly lastStart = new Map<string, number>();

  constructor(options: LimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_PER_SPACE;
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  }

  /**
   * Take a slot for this space, waiting out the minimum interval if needed.
   *
   * Returns the function that gives the slot back. Call it in a `finally`: a
   * slot that is never released is a space that can never run a tool again,
   * which is a worse outage than the one this class prevents.
   */
  async acquire(spaceId: string): Promise<() => void> {
    const running = this.inFlight.get(spaceId) ?? 0;
    if (running >= this.maxConcurrent) {
      log.warn('refusing a local call: this space is already at its limit', {
        space: spaceId, running, max: this.maxConcurrent,
      });
      throw new TooManyLocalCalls(
        `this space is already running ${running} local tools, which is the limit. ` +
        `Wait for one to finish. Calls arriving faster than tools finish are ` +
        `usually a caller retrying or re-rendering in a loop, not work that needs doing.`,
      );
    }
    this.inFlight.set(spaceId, running + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const now = this.inFlight.get(spaceId) ?? 1;
      if (now <= 1) this.inFlight.delete(spaceId);
      else this.inFlight.set(spaceId, now - 1);
    };

    try {
      const since = Date.now() - (this.lastStart.get(spaceId) ?? -Infinity);
      if (since < this.minIntervalMs) {
        const wait = this.minIntervalMs - since;
        log.debug('spacing out a local call', { space: spaceId, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastStart.set(spaceId, Date.now());
      return release;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** How many calls this space has in flight. For tests and for the log. */
  running(spaceId: string): number {
    return this.inFlight.get(spaceId) ?? 0;
  }
}
