/**
 * Per-CLI MCP configuration helpers.
 *
 * Each provider CLI accepts MCP server configuration in its own shape:
 *
 *   - Claude:  --mcp-config <jsonfile> --strict-mcp-config
 *              file: { mcpServers: { bridge: { type, url, headers } } }
 *   - Codex:   -c mcp_servers.bridge.url=... -c mcp_servers.bridge.bearer_token_env_var=...
 *              token is read from the env var at runtime, so the bridge sets
 *              that env var on the spawned codex process.
 *   - Gemini:  .gemini/settings.json in the CLI's cwd
 *              file: { mcpServers: { bridge: { type, url, headers, trust } } }
 *
 * All three are written into the bridge's per-process temp directory (one
 * directory per CLI invocation when files are needed, otherwise inline `-c`
 * arguments). Files are written with mode 0600 so the bearer token in the
 * Authorization header is not readable by other local users.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The MCP server name we register under in every CLI's config. */
export const BRIDGE_MCP_SERVER_NAME = 'bridge';

/** Env var name codex reads the bearer token from. */
export const CODEX_BEARER_ENV_VAR = 'AI_BRIDGE_MCP_TOKEN';

/**
 * Connection info for the bridge's local MCP server. Both fields come from
 * BridgeMcpServer.start().
 */
export interface McpConnection {
  /** HTTP MCP endpoint, e.g. `http://127.0.0.1:54321/mcp`. */
  url: string;
  /** Bearer token for the Authorization header. */
  bearerToken: string;
}

/**
 * Write a per-invocation Claude MCP config file and return its path.
 *
 * Returned path is in a per-process temp directory; the caller is responsible
 * for cleanup if it needs aggressive disk hygiene, but the OS reaper handles
 * /tmp eventually.
 */
export function writeClaudeMcpConfig(conn: McpConnection): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bridge-mcp-claude-'));
  const path = join(dir, 'mcp.json');
  const config = {
    mcpServers: {
      [BRIDGE_MCP_SERVER_NAME]: {
        type: 'http',
        url: conn.url,
        headers: { Authorization: `Bearer ${conn.bearerToken}` },
      },
    },
  };
  // mode 0600: the file holds the bridge's MCP bearer token in the
  // Authorization header, which is the only secret on disk.
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}

/**
 * Build the `-c` config-override args for codex.
 *
 * Codex reads `mcp_servers.<name>.url`, `mcp_servers.<name>.bearer_token_env_var`,
 * and `mcp_servers.<name>.default_tools_approval_mode` from its TOML config;
 * we keep the user's existing config intact by injecting only these keys via
 * `-c <key>=<value>`.
 *
 * `default_tools_approval_mode = "approve"` is the headless-friendly setting:
 * the codex `exec --json` flow has no way to surface an interactive approval
 * prompt, and the global `approval_policy = never` does NOT auto-approve MCP
 * tool calls — verified empirically with codex-cli 0.131.0, both `auto` and
 * `prompt` produce `"user cancelled MCP tool call"` in headless mode. Only
 * `approve` (which counter-intuitively means "pre-approved", not "must
 * approve manually") lets MCP calls go through. The other values codex
 * accepts here are `auto` and `prompt`.
 *
 * The bearer token is read from AI_BRIDGE_MCP_TOKEN at runtime, so the
 * caller must put `conn.bearerToken` in the spawn env under that name.
 */
export function buildCodexMcpArgs(conn: McpConnection): string[] {
  return [
    '-c', `mcp_servers.${BRIDGE_MCP_SERVER_NAME}.url="${conn.url}"`,
    '-c', `mcp_servers.${BRIDGE_MCP_SERVER_NAME}.bearer_token_env_var="${CODEX_BEARER_ENV_VAR}"`,
    '-c', `mcp_servers.${BRIDGE_MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}

/**
 * Write `.gemini/settings.json` inside the given working directory, with our
 * MCP server registered and marked trusted.
 *
 * Gemini has no per-invocation MCP config flag — it loads settings from the
 * project's `.gemini/` directory (the cwd's). The bridge already spawns gemini
 * in a dedicated temp working dir (see getBridgeWorkingDir()), so we drop the
 * settings file there once at welcome time.
 *
 * `trust: true` auto-approves MCP tool calls without prompting. Built-in tools
 * (shell, edit) still require approval in default mode — and the bridge does
 * NOT pass `--yolo` in restricted mode — so the model can only use our tools.
 */
export function writeGeminiSettings(workingDir: string, conn: McpConnection): string {
  const settingsDir = join(workingDir, '.gemini');
  mkdirSync(settingsDir, { recursive: true });
  const path = join(settingsDir, 'settings.json');
  const settings = {
    mcpServers: {
      [BRIDGE_MCP_SERVER_NAME]: {
        type: 'http',
        url: conn.url,
        headers: { Authorization: `Bearer ${conn.bearerToken}` },
        trust: true,
      },
    },
  };
  // mode 0600 for the same reason as the Claude config file.
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return path;
}
