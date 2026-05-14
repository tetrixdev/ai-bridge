/**
 * Session Store
 *
 * Persists conversation_id -> cli_session_id mappings to
 * ~/.ai-bridge/sessions.json so that conversations can be resumed
 * across bridge restarts.
 *
 * Includes TTL-based pruning (default: 7 days).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SessionStore');

/** A single session record stored on disk. */
interface SessionRecord {
  cli_session_id: string;
  provider_id: string;
  created_at: number;   // epoch ms
  last_used_at: number;  // epoch ms
}

/** The full shape of the sessions.json file. */
interface SessionFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
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
    this.data = { version: 1, sessions: {} };
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
    const record = this.data.sessions[conversationId];
    if (!record) return null;

    if (this.isExpired(record)) {
      delete this.data.sessions[conversationId];
      this.persist();
      return null;
    }

    // Touch last_used_at
    record.last_used_at = Date.now();
    this.persist();
    return record.cli_session_id;
  }

  /**
   * Store a mapping from conversation_id to cli_session_id.
   */
  set(conversationId: string, cliSessionId: string, providerId: string): void {
    const now = Date.now();
    this.data.sessions[conversationId] = {
      cli_session_id: cliSessionId,
      provider_id: providerId,
      created_at: now,
      last_used_at: now,
    };
    this.persist();
    log.debug('Session stored', { conversationId, cliSessionId, providerId });
  }

  /**
   * Remove a specific conversation mapping.
   */
  delete(conversationId: string): boolean {
    if (this.data.sessions[conversationId]) {
      delete this.data.sessions[conversationId];
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
    for (const [id, record] of Object.entries(this.data.sessions)) {
      if (this.isExpired(record, now)) {
        delete this.data.sessions[id];
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
   */
  size(): number {
    return Object.keys(this.data.sessions).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isExpired(record: SessionRecord, now: number = Date.now()): boolean {
    return now - record.last_used_at > this.ttlMs;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SessionFile;
        if (parsed.version === 1 && typeof parsed.sessions === 'object') {
          this.data = parsed;
          log.debug('Sessions loaded from disk', { count: Object.keys(this.data.sessions).length });
        } else {
          log.warn('Unrecognized session file version, starting fresh');
        }
      }
    } catch (err) {
      log.warn('Failed to load sessions file, starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prune on load
    this.prune();
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      log.error('Failed to persist sessions file', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
