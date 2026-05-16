import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../src/session/store.js';

/**
 * Tests for the SessionStore.
 *
 * Since SessionStore uses a hardcoded path (~/.ai-bridge/sessions.json),
 * we mock the filesystem operations to test in isolation.
 */

describe('SessionStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temporary directory to act as $HOME
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bridge-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('set() and get()', () => {
    it('stores and retrieves a session', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-abc', 'claude');

      const result = store.get('conv-1');
      expect(result).toBe('session-abc');
    });

    it('returns null for non-existent conversation', () => {
      const store = new SessionStore();
      expect(store.get('nonexistent')).toBeNull();
    });

    it('overwrites existing session for the same conversation', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-old', 'claude');
      store.set('conv-1', 'session-new', 'claude');

      expect(store.get('conv-1')).toBe('session-new');
    });

    it('stores multiple sessions independently', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');
      store.set('conv-2', 'session-2', 'codex');
      store.set('conv-3', 'session-3', 'gemini');

      expect(store.get('conv-1')).toBe('session-1');
      expect(store.get('conv-2')).toBe('session-2');
      expect(store.get('conv-3')).toBe('session-3');
    });
  });

  describe('TTL expiry', () => {
    it('returns null for expired sessions', () => {
      const store = new SessionStore(1000); // 1 second TTL
      store.set('conv-1', 'session-1', 'claude');

      // Manually set last_used_at to past
      const filePath = path.join(tmpDir, '.ai-bridge', 'sessions.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data['conv-1'].last_used_at = new Date(Date.now() - 2000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Create a new store that loads from disk
      const store2 = new SessionStore(1000);
      expect(store2.get('conv-1')).toBeNull();
    });

    it('active sessions are not expired', () => {
      const store = new SessionStore(60000); // 60s TTL
      store.set('conv-1', 'session-1', 'claude');

      expect(store.get('conv-1')).toBe('session-1');
    });
  });

  describe('delete()', () => {
    it('removes a session and returns true', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');

      const deleted = store.delete('conv-1');
      expect(deleted).toBe(true);
      expect(store.get('conv-1')).toBeNull();
    });

    it('returns false for non-existent session', () => {
      const store = new SessionStore();
      expect(store.delete('nonexistent')).toBe(false);
    });

    it('does not affect other sessions', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');
      store.set('conv-2', 'session-2', 'codex');

      store.delete('conv-1');
      expect(store.get('conv-2')).toBe('session-2');
    });
  });

  describe('prune()', () => {
    it('removes expired sessions and returns count', () => {
      const store = new SessionStore(1000); // 1s TTL
      store.set('conv-1', 'session-1', 'claude');
      store.set('conv-2', 'session-2', 'codex');

      // Manually expire both
      const filePath = path.join(tmpDir, '.ai-bridge', 'sessions.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const pastDate = new Date(Date.now() - 5000).toISOString();
      data['conv-1'].last_used_at = pastDate;
      data['conv-2'].last_used_at = pastDate;
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Load a new store — prune happens on load
      const store2 = new SessionStore(1000);
      expect(store2.size()).toBe(0);
    });

    it('does not remove non-expired sessions', () => {
      const store = new SessionStore(60000);
      store.set('conv-1', 'session-1', 'claude');
      store.set('conv-2', 'session-2', 'codex');

      const pruned = store.prune();
      expect(pruned).toBe(0);
      expect(store.size()).toBe(2);
    });
  });

  describe('size()', () => {
    it('returns 0 for empty store', () => {
      const store = new SessionStore();
      expect(store.size()).toBe(0);
    });

    it('returns correct count of active sessions', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');
      store.set('conv-2', 'session-2', 'codex');
      expect(store.size()).toBe(2);

      store.delete('conv-1');
      expect(store.size()).toBe(1);
    });

    it('does not count expired sessions', () => {
      const store = new SessionStore(1000);
      store.set('conv-1', 'session-1', 'claude');

      // Manually expire the session
      const filePath = path.join(tmpDir, '.ai-bridge', 'sessions.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data['conv-1'].last_used_at = new Date(Date.now() - 5000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Create new store to read from disk
      const store2 = new SessionStore(1000);
      expect(store2.size()).toBe(0);
    });
  });

  describe('persistence', () => {
    it('persists data to file on set()', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');

      const filePath = path.join(tmpDir, '.ai-bridge', 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data['conv-1']).toBeDefined();
      expect(data['conv-1'].cli_session_id).toBe('session-1');
      expect(data['conv-1'].provider).toBe('claude');
    });

    it('loads persisted data on construction', () => {
      const store1 = new SessionStore();
      store1.set('conv-1', 'session-1', 'claude');
      store1.set('conv-2', 'session-2', 'codex');

      // Construct a new store which should read from the same file
      const store2 = new SessionStore();
      expect(store2.get('conv-1')).toBe('session-1');
      expect(store2.get('conv-2')).toBe('session-2');
    });

    it('creates the .ai-bridge directory if it does not exist', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      expect(fs.existsSync(dirPath)).toBe(false);

      const store = new SessionStore();
      store.set('conv-1', 'session-1', 'claude');

      expect(fs.existsSync(dirPath)).toBe(true);
    });
  });

  describe('getSystemPrompt()', () => {
    it('stores and retrieves system_prompt alongside session', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-abc', 'claude', 'You are a helpful assistant.');
      expect(store.getSystemPrompt('conv-1')).toBe('You are a helpful assistant.');
    });

    it('returns null for system_prompt when not stored', () => {
      const store = new SessionStore();
      store.set('conv-1', 'session-abc', 'claude');
      expect(store.getSystemPrompt('conv-1')).toBeNull();
    });

    it('returns null for system_prompt on non-existent conversation', () => {
      const store = new SessionStore();
      expect(store.getSystemPrompt('no-such-conv')).toBeNull();
    });

    it('persists system_prompt to disk', () => {
      const store1 = new SessionStore();
      store1.set('conv-1', 'session-abc', 'claude', 'Persistent system prompt.');

      const store2 = new SessionStore();
      expect(store2.getSystemPrompt('conv-1')).toBe('Persistent system prompt.');
    });
  });

  describe('migration from old format', () => {
    it('migrates from old versioned format', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      fs.mkdirSync(dirPath, { recursive: true });

      const oldFormat = {
        version: 1,
        sessions: {
          'conv-old': {
            cli_session_id: 'session-old',
            provider_id: 'claude',
            created_at: Date.now() - 1000,
            last_used_at: Date.now(),
          },
        },
      };

      fs.writeFileSync(path.join(dirPath, 'sessions.json'), JSON.stringify(oldFormat));

      const store = new SessionStore();
      expect(store.get('conv-old')).toBe('session-old');
    });

    it('migrates numeric timestamps to ISO strings', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      fs.mkdirSync(dirPath, { recursive: true });

      const now = Date.now();
      const oldFormat = {
        version: 1,
        sessions: {
          'conv-ts': {
            cli_session_id: 'session-ts',
            provider: 'gemini',
            created_at: now - 60000,
            last_used_at: now,
          },
        },
      };

      fs.writeFileSync(path.join(dirPath, 'sessions.json'), JSON.stringify(oldFormat));

      const store = new SessionStore();
      expect(store.get('conv-ts')).toBe('session-ts');

      // Verify it's persisted in the new format
      const filePath = path.join(dirPath, 'sessions.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // After migration, the format should be flat (no version/sessions wrapper)
      if (data['conv-ts']) {
        expect(typeof data['conv-ts'].last_used_at).toBe('string');
      }
    });

    // Migration writes back to disk so the old-format file is replaced,
    // preventing re-migration on every subsequent restart.
    it('writes migrated data back to disk (EFF-001)', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      fs.mkdirSync(dirPath, { recursive: true });
      const filePath = path.join(dirPath, 'sessions.json');

      const oldFormat = {
        version: 1,
        sessions: {
          'conv-eff': {
            cli_session_id: 'session-eff',
            provider: 'claude',
            created_at: Date.now() - 2000,
            last_used_at: Date.now() - 1000,
          },
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(oldFormat));

      // Construct store — migration should write back to disk
      new SessionStore();

      // Read file again — should now be in flat format, not old versioned format
      const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(written).not.toHaveProperty('version');
      expect(written).not.toHaveProperty('sessions');
      expect(written['conv-eff']).toBeDefined();
      expect(written['conv-eff'].cli_session_id).toBe('session-eff');
    });

    // Migration validation — records with missing cli_session_id or invalid
    // last_used_at in the old format must be skipped.
    it('skips migrated records with missing cli_session_id (SEC-007)', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      fs.mkdirSync(dirPath, { recursive: true });

      const oldFormat = {
        version: 1,
        sessions: {
          'bad-conv': {
            // cli_session_id deliberately omitted
            provider: 'claude',
            created_at: Date.now() - 1000,
            last_used_at: Date.now(),
          },
          'good-conv': {
            cli_session_id: 'session-good',
            provider: 'claude',
            created_at: Date.now() - 1000,
            last_used_at: Date.now(),
          },
        },
      };

      fs.writeFileSync(path.join(dirPath, 'sessions.json'), JSON.stringify(oldFormat));

      const store = new SessionStore();
      expect(store.get('bad-conv')).toBeNull();
      expect(store.get('good-conv')).toBe('session-good');
    });

    it('skips migrated records with invalid last_used_at (SEC-007)', () => {
      const dirPath = path.join(tmpDir, '.ai-bridge');
      fs.mkdirSync(dirPath, { recursive: true });

      const oldFormat = {
        version: 1,
        sessions: {
          'nan-conv': {
            cli_session_id: 'session-nan',
            provider: 'claude',
            created_at: Date.now() - 1000,
            last_used_at: 'not-a-date',
          },
          'good-conv': {
            cli_session_id: 'session-good',
            provider: 'claude',
            created_at: Date.now() - 1000,
            last_used_at: Date.now(),
          },
        },
      };

      fs.writeFileSync(path.join(dirPath, 'sessions.json'), JSON.stringify(oldFormat));

      const store = new SessionStore();
      expect(store.get('nan-conv')).toBeNull();
      expect(store.get('good-conv')).toBe('session-good');
    });
  });
});
