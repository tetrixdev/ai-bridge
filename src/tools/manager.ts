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

/** SEC-005: Denylist of system binary names that must not be used as tool names. */
const RESERVED_TOOL_NAMES = new Set([
  'curl', 'wget', 'node', 'npm', 'npx', 'bash', 'sh', 'zsh',
  'python', 'python3', 'ruby', 'perl', 'git', 'ssh', 'scp',
  'cat', 'ls', 'rm', 'cp', 'mv', 'chmod', 'chown', 'mkdir',
  'kill', 'ps', 'env', 'sudo', 'su', 'tar', 'gzip', 'gunzip',
]);

export class ToolManager {
  private tools = new Map<string, ToolDefinition>();
  private scriptDir: string | null = null;

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

      // SEC-005: Check against denylist of system binary names
      if (RESERVED_TOOL_NAMES.has(tool.name)) {
        log.error('Rejected tool with reserved name', {
          name: tool.name,
          reason: 'Tool name conflicts with a system binary',
        });
        rejectedTools.push(tool.name);
        continue;
      }

      this.tools.set(tool.name, tool);
    }

    // BL-032: Log rejected tools count and names
    if (rejectedTools.length > 0) {
      log.warn('Tools rejected by name validation', {
        count: rejectedTools.length,
        names: rejectedTools,
      });
    }

    log.info('Registered tools', { accepted: this.tools.size, total: tools.length, names: Array.from(this.tools.keys()) });
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
   * @param callbackPort The local HTTP port the bridge is listening on
   *                     for tool call callbacks from spawned scripts.
   * @returns The path to the temporary directory containing the scripts.
   */
  generateScripts(callbackPort: number): string {
    // Clean up any previous script directory
    this.cleanupScripts();

    this.scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bridge-tools-'));
    log.debug('Created tool script directory', { dir: this.scriptDir });

    for (const tool of this.tools.values()) {
      const scriptPath = path.join(this.scriptDir, tool.name);
      const scriptContent = this.buildScript(tool, callbackPort);
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
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
   * The script reads tool arguments as JSON from stdin (the standard way
   * AI CLIs pass arguments to tools), forwards them to the bridge's HTTP
   * callback server, and returns the result.
   *
   * Uses Node.js (guaranteed present) instead of python3 for JSON handling.
   * Tool names are pre-validated by register() so they are safe to embed.
   * Tool descriptions are NOT included in the script to prevent injection (SEC-002).
   */
  private buildScript(tool: ToolDefinition, callbackPort: number): string {
    return `#!/usr/bin/env bash
# Auto-generated tool wrapper: ${tool.name}
# DO NOT EDIT — regenerated on each bridge session.

set -euo pipefail

TOOL_NAME="${tool.name}"
TOOL_CALL_ID="tc_$\{RANDOM}$\{RANDOM}"
CALLBACK_URL="http://127.0.0.1:${callbackPort}/tool-call"

# Read arguments from stdin as JSON (the standard way AI CLIs pass tool args).
# Falls back to empty object if no stdin or invalid JSON.
# EFF-009: Single Node.js invocation for both validation and wrapping.
ARGS_JSON="{}"
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat)
  if [ -n "$STDIN_DATA" ]; then
    ARGS_JSON=$(node -e "
const d = process.argv[1];
try { JSON.parse(d); process.stdout.write(d); }
catch(e) { process.stdout.write(JSON.stringify({input: d})); }
" "$STDIN_DATA")
  fi
fi

# Build the request payload using node for safe JSON construction
# ARCH-001: Include request_id from environment variable in POST body
PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({
  tool_name: process.argv[1],
  tool_call_id: process.argv[2],
  arguments: JSON.parse(process.argv[3]),
  request_id: process.argv[4]
}))" "$TOOL_NAME" "$TOOL_CALL_ID" "$ARGS_JSON" "\${AI_BRIDGE_REQUEST_ID:-}")

# Send the tool call to the bridge and get the result
RESPONSE=$(curl -s -X POST "$CALLBACK_URL" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" \\
  --max-time 300)

# Parse the response: extract result or error using node
# UX-009: Wrapped in try/catch for graceful error on invalid JSON
# UX-019: Use != null check instead of || to avoid coercing 0/false
node -e "
  try { const r = JSON.parse(process.argv[1]); if (r.error) { process.stderr.write(r.error + '\\n'); process.exit(1); } process.stdout.write(r.result != null ? String(r.result) : ''); }
  catch(e) { process.stderr.write('Tool call failed: invalid response from bridge\\n'); process.exit(1); }
" "$RESPONSE"
`;
  }
}
