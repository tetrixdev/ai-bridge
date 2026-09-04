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

import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Gemini settings, when the working directory belongs to somebody else
// ---------------------------------------------------------------------------

/**
 * Directories that currently have a bridge-written `.gemini/settings.json`.
 *
 * Gemini is the one CLI with no per-invocation MCP config flag: the settings
 * have to be a file in cwd, and there is exactly one such path per directory.
 * Two turns sharing a directory therefore cannot each have their own — and the
 * file carries a PER-SPAWN bearer token, so the loser does not merely read
 * stale config, it reads the other turn's credential and has its tool calls
 * routed to the other turn's request id.
 *
 * That is silent and wrong, so the second turn is refused instead. It is a
 * real narrowing — concurrent Gemini turns in one directory used to "work" —
 * but what they were doing was racing on which token won.
 */
const geminiSettingsLocks = new Set<string>();

/** Cleanup for one turn's Gemini settings file. Always call it, once. */
export interface GeminiSettingsHandle {
  /** Absolute path of the settings file that was written. */
  path: string;
  /** Remove the file if we own it, and release the directory lock. */
  release(): void;
}

/**
 * Write `.gemini/settings.json` for one turn, and hand back the way to undo it.
 *
 * @param workingDir  Where gemini will be spawned.
 * @param conn        The MCP connection to register.
 * @param managed     True when `workingDir` is a checkout the server named.
 *
 *   `managed` decides who owns the file. In the bridge's own scratch directory
 *   (false) the file is ours, it is rewritten every turn and it stays there —
 *   today's behaviour, unchanged. In a developer's checkout (true) it is a
 *   file in somebody's repository: an existing one is never overwritten (the
 *   turn is refused instead, because clobbering a developer's Gemini config is
 *   not ours to do), and the one we write is removed when the turn ends so
 *   `git status` is clean again.
 *
 * @throws Error when the directory is already in use by another turn, or when
 *         a managed directory already has its own settings file.
 */
export function acquireGeminiSettings(
  workingDir: string,
  conn: McpConnection,
  managed: boolean,
): GeminiSettingsHandle {
  const settingsDir = join(workingDir, '.gemini');
  const path = join(settingsDir, 'settings.json');

  // Only managed directories are locked.
  //
  // Locking the bridge's own scratch directory would refuse the SECOND of any
  // two concurrent Gemini turns on an install that never asked for workspaces,
  // because getBridgeWorkingDir() hands every such turn the same directory —
  // a visible regression in the default configuration, in exchange for a race
  // that predates this feature. The race there is real (both turns write their
  // own bearer token to one path) and is called out in the README; the fix for
  // it is a per-turn scratch directory, which is a change to how every
  // provider is spawned and does not belong in this commit.
  if (managed && geminiSettingsLocks.has(workingDir)) {
    throw new Error(
      `another Gemini turn is already running in "${workingDir}". Gemini reads its MCP `
      + 'configuration from a file in the working directory, so two turns cannot share one. '
      + 'Retry when the other turn finishes, or use a different workspace.',
    );
  }

  const dirExisted = existsSync(settingsDir);
  const fileExisted = existsSync(path);

  if (managed && fileExisted) {
    throw new Error(
      `"${path}" already exists. The bridge will not overwrite a Gemini settings file in `
      + 'your checkout. Move it aside, or use a provider that does not need one (Claude '
      + 'and Codex take their MCP configuration per invocation).',
    );
  }

  if (managed) {
    geminiSettingsLocks.add(workingDir);
  }
  try {
    writeGeminiSettings(workingDir, conn);
  } catch (err) {
    geminiSettingsLocks.delete(workingDir);
    throw err;
  }

  return {
    path,
    release(): void {
      geminiSettingsLocks.delete(workingDir);
      // Only clean up what we put in someone else's directory. In the bridge's
      // own scratch dir the file is ours to keep, and removing it every turn
      // would just mean writing it again on the next one.
      if (!managed) return;
      try {
        rmSync(path, { force: true });
        // Take the `.gemini` directory too, but only if we created it and it
        // is empty — a directory that held something else is not ours.
        if (!dirExisted && readdirSync(settingsDir).length === 0) {
          // rmdirSync, not rmSync: rmSync refuses a directory unless told to
          // recurse, and recursing is exactly what must not happen here — the
          // emptiness check above is the safety, and it would be pointless if
          // the call could delete a non-empty directory anyway.
          rmdirSync(settingsDir);
        }
      } catch {
        // Best-effort. A leftover settings file is untidy; throwing here would
        // turn a completed turn into a failed one, which is worse.
      }
    },
  };
}
