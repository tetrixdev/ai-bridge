/**
 * Tool Manager
 *
 * Receives tool definitions from the server (via the WelcomeMessage)
 * and manages them for provider adapters. Generates temporary Bash
 * scripts that CLI tools can invoke; those scripts call back to the
 * bridge process which then routes the tool call over WebSocket.
 *
 * Flow:
 *   Server -> Welcome (tools[]) -> ToolManager.register()
 *   ToolManager generates wrapper scripts in a temp directory
 *   Provider adapters add that temp dir to PATH when spawning CLIs
 *   CLI invokes tool script -> script contacts bridge -> bridge sends tool_call
 *   Server resolves -> bridge feeds result back to CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolDefinition } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ToolManager');

/** Strict pattern for safe tool names: must start with a letter, alphanumeric/underscore/hyphen only. */
const SAFE_TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Denylist of system binary names that must not be used as tool names. */
const RESERVED_TOOL_NAMES = new Set([
  'curl', 'wget', 'node', 'npm', 'npx', 'bash', 'sh', 'zsh',
  'python', 'python3', 'ruby', 'perl', 'git', 'ssh', 'scp',
  'cat', 'ls', 'rm', 'cp', 'mv', 'chmod', 'chown', 'mkdir',
  'kill', 'ps', 'env', 'sudo', 'su', 'tar', 'gzip', 'gunzip',
  'openssl', 'nc', 'ncat', 'netcat', 'socat', 'find', 'grep',
  'awk', 'sed', 'echo', 'printf', 'head', 'tail', 'wc', 'tee',
  'test', 'true', 'false', 'xargs', 'sort', 'uniq', 'cut', 'tr',
  'make',
]);

export class ToolManager {
  private tools = new Map<string, ToolDefinition>();
  private scriptDir: string | null = null;
  /** Names of tools most recently rejected by register(). */
  private rejectedTools: string[] = [];

  /**
   * Register tool definitions received from the server.
   * Replaces any previously registered tools.
   * Tool names are validated against a safe pattern and denylist.
   */
  register(tools: ToolDefinition[]): void {
    this.tools.clear();
    const rejectedTools: string[] = [];

    for (const tool of tools) {
      // Validate tool name against regex pattern
      if (!SAFE_TOOL_NAME_PATTERN.test(tool.name)) {
        log.error('Rejected tool with unsafe name', {
          name: tool.name.substring(0, 100),
          reason: 'Tool names must start with a letter and be 1-64 chars of alphanumeric/underscore/hyphen',
        });
        rejectedTools.push(tool.name.substring(0, 100));
        continue;
      }

      // Check against the denylist case-insensitively — on case-insensitive
      // filesystems (macOS) a tool named 'Curl' would shadow the system 'curl'.
      if (RESERVED_TOOL_NAMES.has(tool.name.toLowerCase())) {
        log.error('Rejected tool with reserved name', {
          name: tool.name,
          reason: 'Tool name conflicts with a system binary',
        });
        rejectedTools.push(tool.name);
        continue;
      }

      this.tools.set(tool.name, tool);
    }

    // Expose rejected tool names so the bridge can notify the server.
    this.rejectedTools = rejectedTools;

    if (rejectedTools.length > 0) {
      log.warn('Tools rejected by name validation', {
        count: rejectedTools.length,
        names: rejectedTools,
      });
    }

    log.info('Registered tools', { accepted: this.tools.size, total: tools.length, names: Array.from(this.tools.keys()) });
  }

  /**
   * Return the list of tool names rejected during the last register() call.
   */
  getRejectedToolNames(): string[] {
    return this.rejectedTools;
  }

  /**
   * Get a tool definition by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool definitions.
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns the number of registered tools.
   */
  count(): number {
    return this.tools.size;
  }

  /**
   * Returns the set of registered tool names.
   * Useful for passing to ToolCallbackServer for validation.
   */
  getRegisteredNames(): Set<string> {
    return new Set(this.tools.keys());
  }

  /**
   * Generate temporary Bash wrapper scripts for all registered tools.
   *
   * Each script, when invoked by a CLI tool, will:
   *   1. Collect arguments as JSON
   *   2. Send them to the bridge process via a local HTTP callback
   *   3. Wait for the result
   *   4. Print the result to stdout
   *
   * @param callbackPort  The local HTTP port the bridge is listening on
   *                      for tool call callbacks from spawned scripts.
   * @param secret        Optional bearer token for callback server auth.
   * @param timeoutMs     HTTP timeout for the callback request in ms.  Should
   *                      match the server-configured request_timeout so the
   *                      bash script does not outlive the bridge-side timeout.
   *                      Defaults to 300 000 ms (5 min).
   * @returns The path to the temporary directory containing the scripts.
   */
  generateScripts(callbackPort: number, secret?: string, timeoutMs: number = 300_000): string {
    // Clean up any previous script directory
    this.cleanupScripts();

    this.scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bridge-tools-'));
    log.debug('Created tool script directory', { dir: this.scriptDir });

    for (const tool of this.tools.values()) {
      const scriptPath = path.join(this.scriptDir, tool.name);
      const scriptContent = this.buildScript(tool, callbackPort, secret, timeoutMs);
      // 0o700 (owner-only) so other local users cannot read the embedded
      // callback bearer secret.
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });
      log.debug('Generated tool script', { tool: tool.name, path: scriptPath });
    }

    return this.scriptDir;
  }

  /**
   * Get the directory containing generated tool scripts, or null if
   * scripts have not been generated yet.
   */
  getScriptDir(): string | null {
    return this.scriptDir;
  }

  /**
   * Remove all generated tool scripts and the temp directory.
   */
  cleanupScripts(): void {
    if (this.scriptDir) {
      try {
        fs.rmSync(this.scriptDir, { recursive: true, force: true });
        log.debug('Cleaned up tool script directory', { dir: this.scriptDir });
      } catch (err) {
        log.warn('Failed to clean up tool scripts', {
          dir: this.scriptDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.scriptDir = null;
    }
  }

  /**
   * Build the Bash script content for a single tool.
   *
   * Embeds the bearer token for callback server authentication.  Tool names
   * are pre-validated by register() so they are safe to embed; tool
   * descriptions are NOT included to prevent injection.
   */
  private buildScript(tool: ToolDefinition, callbackPort: number, secret?: string, timeoutMs: number = 300_000): string {
    const secretArg = secret ?? '';
    return `#!/usr/bin/env bash
# Auto-generated tool wrapper: ${tool.name}
# DO NOT EDIT — regenerated on each bridge session.

set -euo pipefail

# Read the JSON payload from the first CLI argument when present; otherwise
# fall back to stdin (some AI CLIs pass tool args one way, some the other).
PAYLOAD_DATA=""
if [ "$#" -ge 1 ] && [ -n "\${1:-}" ]; then
  PAYLOAD_DATA="$1"
elif [ ! -t 0 ]; then
  PAYLOAD_DATA=$(cat)
fi

# Single Node.js invocation for input parsing, payload building, HTTP call,
# and output extraction.
node -e '
const http = require("http");
const payloadData = process.argv[1];
const toolName = process.argv[2];
const toolCallId = process.argv[3];
const requestId = process.argv[4];
const secret = process.argv[5];

// Parse the payload as JSON, fall back to wrapping as {input: ...}
let args = {};
if (payloadData) {
  try { args = JSON.parse(payloadData); } catch { args = { input: payloadData }; }
}

const payload = JSON.stringify({
  tool_name: toolName,
  tool_call_id: toolCallId,
  arguments: args,
  request_id: requestId
});

const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
if (secret) headers["Authorization"] = "Bearer " + secret;

const req = http.request({ hostname: "127.0.0.1", port: ${callbackPort}, path: "/tool-call", method: "POST", headers, timeout: ${timeoutMs} }, (res) => {
  let body = "";
  res.on("data", (c) => { body += c; });
  res.on("end", () => {
    try {
      const r = JSON.parse(body);
      if (r.error) { process.stderr.write(r.error + "\\n"); process.exit(1); }
      process.stdout.write(r.result != null ? String(r.result) : "");
    } catch {
      process.stderr.write("Tool call failed: invalid response from bridge\\n");
      process.exit(1);
    }
  });
});
req.on("error", (e) => { process.stderr.write("Tool call failed: " + e.message + "\\n"); process.exit(1); });
req.write(payload);
req.end();
// The $RANDOM-based ID here is discarded — the callback server overrides it
// with a cryptographically strong UUID before use.
' "$PAYLOAD_DATA" "${tool.name}" "tc_\${RANDOM}\${RANDOM}" "\${AI_BRIDGE_REQUEST_ID:-}" "${secretArg}"
`;
  }
}
