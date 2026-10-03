/**
 * Following the version the server says this bridge should run.
 *
 * The server's `welcome` may carry `desired_bridge_version`. When it differs
 * from what is running -- higher or lower, the server decides -- and this
 * bridge is a service that can be restarted onto it (see service.ts), then:
 *
 *  1. fetch that version and run it once (`--version`). If that fails, keep
 *     running as we are and try again later, backing off. A failed update must
 *     never leave the machine without a bridge.
 *  2. wait until nothing is in progress: no turn (sub-agents run inside one),
 *     no upload, no file going either way, no app call. Work is never cut off.
 *  3. pin the version in the service's env file, disconnect cleanly and exit
 *     non-zero; the service manager starts the new version.
 *
 * Loop protection. Each attempt is recorded in a small state file before the
 * exit. If the bridge comes back still on the version it left from, the pin
 * did not take, and the next attempt at that version waits longer each time
 * (5 minutes, doubling, at most a day) instead of restarting every few seconds.
 *
 * What this cannot cover: a new version that crashes before it gets as far as
 * running this code. The old one has already gone, so nothing is left to roll
 * back; the `--version` run in step 1 is what keeps that rare.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SELF_UPDATE_FLOOR, compareVersions, parseVersion } from './version.js';
import type { Detection } from './service.js';

/** How long a failed fetch waits before the next one: 5 min, doubling, at most 6 h. */
export const FETCH_RETRY_MS = (failures: number): number => Math.min(5 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3_600_000);
/** How long after an attempt that did not take before the next one: 5 min, doubling, at most 24 h. */
export const ATTEMPT_BACKOFF_MS = (attempts: number): number => Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 24 * 3_600_000);
/** How often to look whether the bridge has become idle. */
export const IDLE_POLL_MS = 5_000;

export interface AttemptState {
  /** The version the bridge exited to run. */
  target: string;
  /** The version that exited. Still running this one after a restart means the pin did not take. */
  from: string;
  /** Attempts at `target` from `from` so far. */
  attempts: number;
  /** When the last attempt was made, ms since epoch. */
  at: number;
}

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface UpdaterDeps {
  currentVersion: string;
  /** Opted out by flag or AI_BRIDGE_SELF_UPDATE. */
  optedOut: boolean;
  detection: Detection;
  prefetch: (version: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** True when nothing is in progress. */
  isIdle: () => boolean;
  /** Pin the version in the env file. Throws when it cannot. */
  pin: (version: string, previous: string) => void;
  /** Disconnect and exit so the service manager restarts the bridge. Does not return. */
  restart: (version: string) => void;
  statePath: string;
  log: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class SelfUpdater {
  private readonly d: Required<UpdaterDeps>;
  /** The version currently being worked towards, or null. */
  private target: string | null = null;
  private timer: unknown = null;
  private fetchFailures = 0;
  /** Warned already, per version, so a reconnect loop does not repeat it. */
  private readonly warned = new Set<string>();

  constructor(deps: UpdaterDeps) {
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  /** Will this bridge follow a desired version? What the `self_update` capability says. */
  get enabled(): boolean {
    return !this.d.optedOut && 'managed' in this.d.detection;
  }

  /**
   * Called once at startup, before connecting: notes an attempt that worked,
   * and says plainly when one did not.
   */
  start(): void {
    const state = this.readState();
    if (!state) return;
    if (state.target === this.d.currentVersion) {
      this.d.log.info(`Self-update: now running ${state.target} (was ${state.from})`);
      this.clearState();
    } else if (state.from === this.d.currentVersion) {
      this.d.log.warn(`Self-update: restarted to run ${state.target} but came back on ${state.from}; the pin did not take. Backing off before trying again.`, {
        attempts: state.attempts,
      });
    }
  }

  /** The `desired_bridge_version` of a welcome, or undefined when it had none. */
  onDesired(raw: unknown): void {
    if (raw === undefined || raw === null) {
      this.cancel();
      return;
    }
    const version = parseVersion(raw);
    if (version === null) {
      this.warnOnce(`invalid:${String(raw)}`, 'Self-update: the server asked for a version that is not a strict semver string; ignored', { value: String(raw).slice(0, 80) });
      this.cancel();
      return;
    }
    if (version === this.d.currentVersion) {
      this.cancel();
      return;
    }
    if (compareVersions(version, SELF_UPDATE_FLOOR) < 0) {
      this.warnOnce(`floor:${version}`, `Self-update: the server asked for ${version}, older than ${SELF_UPDATE_FLOOR}, the first version that updates itself. Staying on ${this.d.currentVersion} rather than be stranded there.`);
      this.cancel();
      return;
    }
    if (!this.enabled) {
      const why = this.d.optedOut ? 'self-update is turned off' : (this.d.detection as { reason: string }).reason;
      this.warnOnce(`manual:${version}`, `The server wants ai-bridge ${version}; this one runs ${this.d.currentVersion}. Not updating by itself (${why}). Update it by hand.`);
      return;
    }
    if (this.target === version) return; // already on its way
    this.cancel();
    this.target = version;
    this.fetchFailures = 0;

    const state = this.readState();
    if (state && state.target === version && state.from === this.d.currentVersion) {
      const nextAt = state.at + ATTEMPT_BACKOFF_MS(state.attempts);
      if (nextAt > this.d.now()) {
        this.d.log.warn(`Self-update to ${version}: last attempt did not take; next try in ${Math.round((nextAt - this.d.now()) / 60_000)} min`);
        this.schedule(() => this.fetch(version), nextAt - this.d.now());
        return;
      }
    }
    this.d.log.info(`Self-update: the server wants ${version}; this bridge runs ${this.d.currentVersion}. Fetching it.`);
    void this.fetch(version);
  }

  /** Stop working towards a version: the server no longer asks for it. */
  cancel(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.target = null;
  }

  private async fetch(version: string): Promise<void> {
    if (this.target !== version) return;
    let result: { ok: true } | { ok: false; reason: string };
    try {
      result = await this.d.prefetch(version);
    } catch (err) {
      // prefetch() promises not to throw; if one ever does, it is a failed
      // fetch like any other, retried later, never an end to retrying.
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (this.target !== version) return; // superseded while fetching
    if (!result.ok) {
      this.fetchFailures++;
      const wait = FETCH_RETRY_MS(this.fetchFailures);
      this.d.log.warn(`Self-update: could not fetch ${version} (${result.reason}). Staying on ${this.d.currentVersion}; trying again in ${Math.round(wait / 60_000)} min.`);
      this.schedule(() => this.fetch(version), wait);
      return;
    }
    this.d.log.info(`Self-update: ${version} fetched and runs; restarting onto it as soon as nothing is in progress.`);
    this.waitIdle(version);
  }

  private waitIdle(version: string): void {
    if (this.target !== version) return;
    if (!this.d.isIdle()) {
      this.schedule(() => this.waitIdle(version), IDLE_POLL_MS);
      return;
    }
    this.go(version);
  }

  private go(version: string): void {
    const previous = this.readState();
    const attempts = previous && previous.target === version && previous.from === this.d.currentVersion ? previous.attempts + 1 : 1;
    try {
      // Recorded first: if the pin lands and the restart does not happen, the
      // next start still knows an attempt was made.
      this.writeState({ target: version, from: this.d.currentVersion, attempts, at: this.d.now() });
      this.d.pin(version, this.d.currentVersion);
    } catch (err) {
      const wait = ATTEMPT_BACKOFF_MS(attempts);
      this.d.log.error(`Self-update: could not pin ${version} (${err instanceof Error ? err.message : String(err)}). Staying on ${this.d.currentVersion}; trying again in ${Math.round(wait / 60_000)} min.`);
      this.schedule(() => this.waitIdle(version), wait);
      return;
    }
    this.target = null;
    this.d.log.info(`Self-update: pinned ${version}; restarting.`);
    this.d.restart(version);
  }

  private schedule(fn: () => void, ms: number): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private warnOnce(key: string, message: string, data?: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.d.log.warn(message, data);
  }

  private readState(): AttemptState | null {
    try {
      const s = JSON.parse(readFileSync(this.d.statePath, 'utf8')) as Partial<AttemptState>;
      if (typeof s.target !== 'string' || typeof s.from !== 'string' || typeof s.attempts !== 'number' || typeof s.at !== 'number') return null;
      return s as AttemptState;
    } catch {
      return null;
    }
  }

  private writeState(state: AttemptState): void {
    mkdirSync(dirname(this.d.statePath), { recursive: true });
    const tmp = `${this.d.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.d.statePath);
  }

  private clearState(): void {
    try {
      writeFileSync(this.d.statePath, '{}');
    } catch { /* nothing to clear */ }
  }
}
