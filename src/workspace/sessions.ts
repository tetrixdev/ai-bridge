/**
 * Which directory each CLI session was started in.
 *
 * The server owns the conversation-to-session mapping and remains the single
 * source of truth for it. This is a different thing: a small local record of
 * where a session the bridge itself started is rooted, so a later resume that
 * names somewhere else can be refused instead of silently resumed into a
 * session whose history is all about another checkout — and so a resume that
 * names NOTHING keeps the directory it has.
 *
 * Persisted to disk, because in memory it was worth very little. A bridge is a
 * background service that gets restarted, and an empty map turns "keeps the
 * directory it has" into "runs in the empty scratch directory" — which then
 * fails the CLI's own resume, gets re-issued as a fresh session, and answers
 * confidently about a repository that is not there. That is the exact outcome
 * this module exists to prevent, so surviving a restart is not a nicety.
 *
 * Bounded on purpose. Oldest entries are dropped first; losing one only costs
 * the ability to detect a change on that session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Workspace');

const DEFAULT_CAPACITY = 500;

/** Where the map lives between runs. */
export function sessionStorePath(): string {
  return join(homedir(), '.cache', 'ai-bridge', 'sessions.json');
}

export class SessionWorkingDirs {
  /** Insertion-ordered, which is what makes the eviction below oldest-first. */
  private readonly map = new Map<string, string>();
  /**
   * Every session id this process has recorded or dropped.
   *
   * The merge in save() protects another bridge's entries; without this it
   * would also protect our OWN deleted ones, quietly undoing every forget().
   */
  private readonly seen = new Set<string>();

  /**
   * @param capacity  How many sessions to remember.
   * @param storePath Where to persist. `null` disables persistence entirely,
   *                  which is what the tests want and what a bridge with no
   *                  writable cache directory falls back to.
   */
  constructor(
    private readonly capacity: number = DEFAULT_CAPACITY,
    private readonly storePath: string | null = sessionStorePath(),
  ) {
    this.load();
  }

  /** Record where a session runs. Re-recording refreshes its position. */
  remember(sessionId: string, workingDir: string): void {
    if (this.map.get(sessionId) === workingDir) {
      // Nothing changed — skip the write. A long conversation re-records the
      // same pair on every turn.
      return;
    }
    if (this.map.has(sessionId)) {
      this.map.delete(sessionId);
    }
    this.map.set(sessionId, workingDir);
    this.seen.add(sessionId);

    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }

    this.save();
  }

  /** Where this session runs, or undefined if we never saw it (or evicted it). */
  get(sessionId: string): string | undefined {
    return this.map.get(sessionId);
  }

  /** Drop a session — used when the server tells us the session is gone. */
  forget(sessionId: string): void {
    const had = this.map.delete(sessionId);
    this.seen.add(sessionId);
    if (had) {
      this.save();
    }
  }

  /** Test seam. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Read the map back. Best-effort in every failure mode: a missing, empty,
   * unreadable or corrupt file simply means an empty map, which is the
   * position a first run is in. This must never stop the bridge starting.
   */
  private readRaw(): Record<string, string> {
    if (this.storePath === null) return {};

    let raw: string;
    try {
      raw = readFileSync(this.storePath, 'utf-8');
    } catch {
      return {}; // No file yet, or unreadable. Either way, nothing to merge.
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

      const out: Record<string, string> = {};
      for (const [sessionId, workingDir] of Object.entries(parsed as Record<string, unknown>)) {
        // Values are paths this process will later hand to `spawn` as cwd, so
        // anything that is not a plain string is dropped rather than trusted.
        if (typeof workingDir === 'string' && workingDir !== '') {
          out[sessionId] = workingDir;
        }
      }

      return out;
    } catch {
      log.warn('Session working-directory store is unreadable — starting empty', {
        path: this.storePath,
      });

      return {};
    }
  }

  private load(): void {
    if (this.storePath === null) return;

    try {
      for (const [sessionId, workingDir] of Object.entries(this.readRaw())) {
        this.map.set(sessionId, workingDir);
      }

      // Honour the cap on load too, in case it shrank between runs.
      while (this.map.size > this.capacity) {
        const oldest = this.map.keys().next();
        if (oldest.done) break;
        this.map.delete(oldest.value);
      }
    } catch {
      log.warn('Session working-directory store is unreadable — starting empty', {
        path: this.storePath,
      });
    }
  }

  /**
   * Write the map out, atomically and best-effort.
   *
   * Written to a temporary file and renamed, so a bridge killed mid-write
   * leaves the previous map intact rather than a truncated one that parses to
   * nothing. A failure here is logged once and swallowed: losing the record
   * costs the resume check, and that is a far smaller thing than failing a
   * turn over a full cache directory.
   */
  private save(): void {
    if (this.storePath === null) return;

    try {
      mkdirSync(dirname(this.storePath), { recursive: true });

      // Merge rather than overwrite. One operator can run several bridges —
      // one per server — and they share this file. A whole-file write would
      // make each drop the others' sessions, so after a restart their resumes
      // would land in the empty scratch directory: the precise failure this
      // store exists to prevent, reintroduced by the store itself. Our own
      // entries win, because they are the ones this process just observed.
      const onDisk = this.readRaw();
      // Anything this process has ever known about is ours to decide, so a
      // forget() removes it rather than being undone by the merge below.
      for (const sessionId of this.seen) {
        delete onDisk[sessionId];
      }
      const merged = { ...onDisk, ...Object.fromEntries(this.map) };

      const tmp = `${this.storePath}.${process.pid}.tmp`;
      // 0600: these are paths into the operator's own filesystem.
      writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch (err) {
      log.warn('Could not persist the session working-directory store', {
        path: this.storePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
