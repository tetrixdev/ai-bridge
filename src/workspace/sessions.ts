/**
 * Which directory each CLI session was started in.
 *
 * The server owns the conversation-to-session mapping and remains the single
 * source of truth for it. This is a different thing: a small local record of
 * where a session the bridge itself started is rooted, so a later resume that
 * names somewhere else can be refused instead of silently resumed into a
 * session whose history is all about another checkout.
 *
 * Bounded on purpose. A bridge is a long-lived background service, and an
 * unbounded map keyed by every session it ever ran is a slow leak. Oldest
 * entries are dropped first; losing one only costs the ability to detect a
 * change on that session, which is the same position a freshly restarted
 * bridge is in.
 */

const DEFAULT_CAPACITY = 500;

export class SessionWorkingDirs {
  /** Insertion-ordered, which is what makes the eviction below oldest-first. */
  private readonly map = new Map<string, string>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** Record where a session runs. Re-recording refreshes its position. */
  remember(sessionId: string, workingDir: string): void {
    if (this.map.has(sessionId)) {
      this.map.delete(sessionId);
    }
    this.map.set(sessionId, workingDir);

    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Where this session runs, or undefined if we never saw it (or evicted it). */
  get(sessionId: string): string | undefined {
    return this.map.get(sessionId);
  }

  /** Drop a session — used when the server tells us the session is gone. */
  forget(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Test seam. */
  get size(): number {
    return this.map.size;
  }
}
