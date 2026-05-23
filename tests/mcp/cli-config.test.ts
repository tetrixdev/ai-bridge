/**
 * Per-CLI MCP config helpers — file-shape and arg-shape tests. The actual
 * end-to-end "does each CLI accept this config?" verification is done
 * empirically against the real CLIs during integration testing; this suite
 * only checks the shapes the bridge writes are the ones the CLIs documented.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexMcpArgs,
  writeClaudeMcpConfig,
  writeGeminiSettings,
  BRIDGE_MCP_SERVER_NAME,
  CODEX_BEARER_ENV_VAR,
} from '../../src/mcp/cli-config.js';

const conn = {
  url: 'http://127.0.0.1:12345/mcp',
  bearerToken: 'tok-deadbeef',
};

describe('writeClaudeMcpConfig', () => {
  it('writes a config file with the bridge MCP server registered for HTTP transport', () => {
    const path = writeClaudeMcpConfig(conn);
    const content = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

    expect(content).toEqual({
      mcpServers: {
        [BRIDGE_MCP_SERVER_NAME]: {
          type: 'http',
          url: conn.url,
          headers: { Authorization: `Bearer ${conn.bearerToken}` },
        },
      },
    });
  });

  it('writes the config file with mode 0600 — the file holds the bearer token', () => {
    const path = writeClaudeMcpConfig(conn);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('buildCodexMcpArgs', () => {
  it('returns the two -c override pairs Codex expects', () => {
    const args = buildCodexMcpArgs(conn);
    expect(args).toEqual([
      '-c', `mcp_servers.${BRIDGE_MCP_SERVER_NAME}.url="${conn.url}"`,
      '-c', `mcp_servers.${BRIDGE_MCP_SERVER_NAME}.bearer_token_env_var="${CODEX_BEARER_ENV_VAR}"`,
    ]);
  });

  it('points Codex at the well-known env var name, not the literal token', () => {
    // The token itself must never appear in the args — args are visible in
    // process listings, env vars are not (after AI_BRIDGE_TOKEN-style strip).
    const args = buildCodexMcpArgs(conn).join(' ');
    expect(args).not.toContain(conn.bearerToken);
    expect(args).toContain(CODEX_BEARER_ENV_VAR);
  });
});

describe('writeGeminiSettings', () => {
  it('writes .gemini/settings.json with the bridge server marked trusted', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ai-bridge-gemini-test-'));
    const path = writeGeminiSettings(workDir, conn);

    expect(path).toBe(join(workDir, '.gemini', 'settings.json'));
    const settings = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(settings).toEqual({
      mcpServers: {
        [BRIDGE_MCP_SERVER_NAME]: {
          type: 'http',
          url: conn.url,
          headers: { Authorization: `Bearer ${conn.bearerToken}` },
          trust: true,
        },
      },
    });
  });

  it('writes the settings file with mode 0600', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ai-bridge-gemini-test-'));
    const path = writeGeminiSettings(workDir, conn);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
