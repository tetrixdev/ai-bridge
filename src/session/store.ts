/**
 * Session Store
 *
 * Persists conversation_id -> cli_session_id mappings to
 * ~/.ai-bridge/sessions.json so that conversations can be resumed
 * across bridge restarts.
 *
 * Includes TTL-based pruning (default: 7 days).
 *
 * Stored format per PROTOCOL.md:
 * {
 *   "conv_xyz789": {
 *     "provider": "claude",
 *     "cli_session_id": "session_def456",
 *     "created_at": "2026-05-14T10:30:00Z",
 *     "last_used_at": "2026-05-14T11:45:00Z"
 *   }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SessionStore');

/** A single session record stored on disk. */
interface SessionRecord {
  cli_session_id: string;
  provider: string;
  created_at: string;   // ISO 8601
  last_used_at: string;  // ISO 8601
  /** BL-005: Store the original system prompt so session resets can reuse it
   *  even when the server omits system_prompt from the session_reset message. */
  system_prompt?: string | null;
}

/** The full shape of the sessions.json file. */
interface SessionFile {
  [conversationId: string]: SessionRecord;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly ttlMs: number;
  private data: SessionFile;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.dir = path.join(os.homedir(), '.ai-bridge');
    this.filePath = path.join(this.dir, 'sessions.json');
    this.ttlMs = ttlMs;
    this.data = {};
    this.load();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Look up the CLI session ID for a given conversation.
   * Returns null if not found or expired.
   */
  get(conversationId: string): string | null {
    const record = this.data[conversationId];
    if (!record) return null;

    if (this.isExpired(record)) {
      delete this.data[conversationId];
      // ARCH-005: Persist only on mutations that matter (expiry deletion)
      this.persist();
      return null;
    }

    // ARCH-005: Touch last_used_at in memory only — persist on set/delete/shutdown
    record.last_used_at = new Date().toISOString();
    return record.cli_session_id;
  }

  /**
   * Store a mapping from conversation_id to cli_session_id.
   * @param systemPrompt  The system prompt used for the first message in this
   *   conversation (BL-005).  Stored so session resets can restore it even
   *   when the server omits system_prompt from the session_reset message.
   */
  set(conversationId: string, cliSessionId: string, provider: string, systemPrompt?: string | null): void {
    const now = new Date().toISOString();
    this.data[conversationId] = {
      cli_session_id: cliSessionId,
      provider,
      created_at: now,
      last_used_at: now,
      system_prompt: systemPrompt ?? null,
    };
    this.persist();
    log.debug('Session stored', { conversationId, cliSessionId, provider });
  }

  /**
   * BL-005: Retrieve the stored system prompt for a conversation.
   * Returns null if not found or if no system_prompt was stored.
   */
  getSystemPrompt(conversationId: string): string | null {
    return this.data[conversationId]?.system_prompt ?? null;
  }

  /**
   * Remove a specific conversation mapping.
   */
  delete(conversationId: string): boolean {
    if (this.data[conversationId]) {
      delete this.data[conversationId];
      this.persist();
      log.debug('Session deleted', { conversationId });
      return true;
    }
    return false;
  }

  /**
   * Remove all expired sessions. Returns the number of pruned entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, record] of Object.entries(this.data)) {
      if (this.isExpired(record, now)) {
        delete this.data[id];
        pruned++;
      }
    }
    if (pruned > 0) {
      this.persist();
      log.info('Pruned expired sessions', { count: pruned });
    }
    return pruned;
  }

  /**
   * Returns the number of active (non-expired) sessions.
   * CONS-005: Filters out expired sessions before counting.
   */
  size(): number {
    const now = Date.now();
    return Object.values(this.data).filter((record) => !this.isExpired(record, now)).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isExpired(record: SessionRecord, now: number = Date.now()): boolean {
    const lastUsed = new Date(record.last_used_at).getTime();
    return now - lastUsed > this.ttlMs;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Support both old versioned format and new flat format
        if (parsed && typeof parsed === 'object') {
          if ('version' in parsed && 'sessions' in parsed) {
            // Migrate from old format
            const oldSessions = parsed.sessions as Record<string, {
              cli_session_id: string;
              provider_id?: string;
              provider?: string;
              created_at: number | string;
              last_used_at: number | string;
            }>;
            for (const [id, rec] of Object.entries(oldSessions)) {
              this.data[id] = {
                cli_session_id: rec.cli_session_id,
                provider: rec.provider ?? rec.provider_id ?? 'unknown',
                created_at: typeof rec.created_at === 'number' ? new Date(rec.created_at).toISOString() : rec.created_at,
                last_used_at: typeof rec.last_used_at === 'number' ? new Date(rec.last_used_at).toISOString() : rec.last_used_at,
              };
            }
            log.debug('Migrated sessions from old format', { count: Object.keys(this.data).length });
          } else {
            // BL-006: Validate individual records before accepting them.
            // Records with a missing/invalid cli_session_id or non-parseable
            // last_used_at would never expire (NaN > threshold === false) and
            // would be returned by get() indefinitely.
            const rawSessions = parsed as Record<string, unknown>;
            let skipped = 0;
            for (const [id, rec] of Object.entries(rawSessions)) {
              const r = rec as Partial<SessionRecord>;
              if (!r.cli_session_id || typeof r.cli_session_id !== 'string') {
                log.warn('Skipping session record with missing cli_session_id', { id });
                skipped++;
                continue;
              }
              const lastUsed = new Date(r.last_used_at ?? '').getTime();
              if (Number.isNaN(lastUsed)) {
                log.warn('Skipping session record with invalid last_used_at', { id, last_used_at: r.last_used_at });
                skipped++;
                continue;
              }
              this.data[id] = r as SessionRecord;
            }
            if (skipped > 0) {
              log.warn('Skipped invalid session records on load', { count: skipped });
            }
            log.debug('Sessions loaded from disk', { count: Object.keys(this.data).length });
          }
        }
      }
    } catch (err) {
      // UX-004: Log at error level (not just warn) so operators notice that all
      // existing sessions were lost.  Also try to preserve the corrupted file
      // as a .bak so the user has a recovery option.
      log.error('Failed to load sessions file — starting with empty session store', {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        if (fs.existsSync(this.filePath)) {
          const bakPath = this.filePath + '.bak';
          fs.copyFileSync(this.filePath, bakPath);
          log.error('Corrupted sessions file saved as backup', { backupPath: bakPath });
        }
      } catch {
        // Best-effort — ignore errors during backup
      }
    }

    // Prune on load
    this.prune();
  }

  // EFF-007 / CONS-009: persist() uses synchronous file I/O intentionally.
  // The bridge processes one AI request at a time per conversation; persist()
  // is called only on set/delete (at most once per completed request).  The
  // cost of a single synchronous write on an SSD is negligible compared to the
  // multi-second CLI invocations it bookends.  Converting to async would
  // require an async initialize() factory pattern that complicates the
  // constructor and all call sites without meaningful performance benefit.
  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) {
        // SEC-006: Create directory with restricted permissions (owner-only)
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      }
      // SEC-006: Write sessions file with restricted permissions (owner read/write only)
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      log.error('Failed to persist sessions file', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
