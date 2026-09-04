/**
 * `.gemini/settings.json` when the working directory belongs to a developer.
 *
 * Gemini is the only CLI with no per-invocation MCP config flag, so the
 * settings have to be a file in cwd. Once cwd can be someone's checkout, that
 * file stops being ours: it must not overwrite theirs, it must not survive the
 * turn, and two turns must not race on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireGeminiSettings,
  releaseGeminiSettingsOnExit,
  BRIDGE_MCP_SERVER_NAME,
} from '../../src/mcp/cli-config.js';

const conn = { url: 'http://127.0.0.1:9/mcp', bearerToken: 'tok-1' };

let checkout: string;
let settingsPath: string;

beforeEach(() => {
  checkout = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-ws-')));
  settingsPath = join(checkout, '.gemini', 'settings.json');
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe('a managed working directory (a developer checkout)', () => {
  it('writes the settings file and registers the bridge MCP server', () => {
    const handle = acquireGeminiSettings(checkout, conn, true);
    try {
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        mcpServers: Record<string, { url: string }>;
      };
      expect(written.mcpServers[BRIDGE_MCP_SERVER_NAME]?.url).toBe(conn.url);
    } finally {
      handle.release();
    }
  });

  it('removes the file and the .gemini directory it created when the turn ends', () => {
    // The point: `git status` is clean again afterwards.
    acquireGeminiSettings(checkout, conn, true).release();
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(join(checkout, '.gemini'))).toBe(false);
  });

  it('refuses rather than overwriting a settings file the developer already has', () => {
    mkdirSync(join(checkout, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, '{"mine":true}');

    expect(() => acquireGeminiSettings(checkout, conn, true)).toThrow(/already exists/);
    // And theirs is untouched.
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{"mine":true}');
  });

  it('leaves a pre-existing .gemini directory in place when it cleans up', () => {
    mkdirSync(join(checkout, '.gemini'), { recursive: true });
    writeFileSync(join(checkout, '.gemini', 'other.json'), '{}');

    acquireGeminiSettings(checkout, conn, true).release();

    expect(existsSync(settingsPath)).toBe(false);
    // A directory that held something else was never ours to remove.
    expect(existsSync(join(checkout, '.gemini', 'other.json'))).toBe(true);
  });

  it('refuses a second concurrent turn in the same directory', () => {
    // Both turns would otherwise write their own per-spawn bearer token to one
    // path, and the loser's gemini would read the winner's credential — routing
    // its tool calls to the other turn's request id. Silent and wrong.
    const first = acquireGeminiSettings(checkout, conn, true);
    try {
      expect(() => acquireGeminiSettings(checkout, conn, true)).toThrow(/already running/);
    } finally {
      first.release();
    }
  });

  it('frees the directory again once the first turn releases', () => {
    acquireGeminiSettings(checkout, conn, true).release();
    const second = acquireGeminiSettings(checkout, conn, true);
    expect(existsSync(settingsPath)).toBe(true);
    second.release();
  });
});

describe('when the bridge process is killed mid-turn', () => {
  it('still takes its settings file back out of the checkout', () => {
    // The per-turn `finally` only runs when the spawn promise settles, which it
    // never does on SIGTERM, a crash or a SIGKILL. The file would otherwise
    // survive in the repository, show up in `git status`, and — because
    // acquire refuses rather than overwrites — block every future Gemini turn
    // in that checkout until somebody deleted it by hand.
    acquireGeminiSettings(checkout, conn, true);
    expect(existsSync(settingsPath)).toBe(true);

    releaseGeminiSettingsOnExit();

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(join(checkout, '.gemini'))).toBe(false);
  });

  it('frees the directory lock too, so a restarted bridge can use it', () => {
    acquireGeminiSettings(checkout, conn, true);
    releaseGeminiSettingsOnExit();

    const handle = acquireGeminiSettings(checkout, conn, true);
    expect(existsSync(settingsPath)).toBe(true);
    handle.release();
  });

  it('leaves the scratch directory alone, since that file is the bridge own', () => {
    acquireGeminiSettings(checkout, conn, false).release();
    releaseGeminiSettingsOnExit();
    expect(existsSync(settingsPath)).toBe(true);
  });
});

describe('the bridge own scratch directory', () => {
  it('keeps the settings file, which is today behaviour', () => {
    acquireGeminiSettings(checkout, conn, false).release();
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('allows two concurrent turns, which is what a default install does', () => {
    // Locking the shared scratch directory would refuse the SECOND of any two
    // concurrent Gemini turns on an install that never asked for workspaces —
    // a visible regression in the default configuration.
    const first = acquireGeminiSettings(checkout, conn, false);
    try {
      const second = acquireGeminiSettings(checkout, { ...conn, bearerToken: 'tok-2' }, false);
      second.release();
    } finally {
      first.release();
    }
  });

  it('overwrites its own previous file rather than refusing', () => {
    acquireGeminiSettings(checkout, conn, false).release();
    const handle = acquireGeminiSettings(checkout, { ...conn, bearerToken: 'tok-2' }, false);
    try {
      expect(readFileSync(settingsPath, 'utf-8')).toContain('tok-2');
    } finally {
      handle.release();
    }
  });
});
