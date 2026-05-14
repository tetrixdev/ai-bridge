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

/** Strict pattern for safe tool names: alphanumeric, underscores, hyphens only. */
const SAFE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolManager {
  private tools = new Map<string, ToolDefinition>();
  private scriptDir: string | null = null;

  /**
   * Register tool definitions received from the server.
   * Replaces any previously registered tools.
   * Tool names are validated against a safe pattern to prevent path traversal.
   */
  register(tools: ToolDefinition[]): void {
    this.tools.clear();
    for (const tool of tools) {
      // SEC-001: Validate tool names to prevent path traversal and filesystem abuse
      if (!SAFE_TOOL_NAME_PATTERN.test(tool.name)) {
        log.error('Rejected tool with unsafe name', {
          name: tool.name.substring(0, 100),
          reason: 'Tool names must be 1-64 chars, alphanumeric/underscore/hyphen only',
        });
        continue;
      }
      this.tools.set(tool.name, tool);
    }
    log.info('Registered tools', { count: this.tools.size, names: Array.from(this.tools.keys()) });
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
CALLBACK_URL="http://127.0.0.1:${callbackPort}/tool-call"

# Read arguments from stdin as JSON (the standard way AI CLIs pass tool args).
# Falls back to empty object if no stdin or invalid JSON.
ARGS_JSON="{}"
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat)
  if [ -n "$STDIN_DATA" ]; then
    # Validate it's valid JSON, fall back to wrapping as string
    if node -e "JSON.parse(process.argv[1])" "$STDIN_DATA" 2>/dev/null; then
      ARGS_JSON="$STDIN_DATA"
    else
      # Wrap raw text as {"input": "..."} using node for safe JSON encoding
      ARGS_JSON=$(node -e "process.stdout.write(JSON.stringify({input: process.argv[1]}))" "$STDIN_DATA")
    fi
  fi
fi

# Build the request payload using node for safe JSON construction
PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({tool_name: process.argv[1], arguments: JSON.parse(process.argv[2])}))" "$TOOL_NAME" "$ARGS_JSON")

# Send the tool call to the bridge and get the result
RESPONSE=$(curl -s -X POST "$CALLBACK_URL" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" \\
  --max-time 300)

# Parse the response: extract result or error using node
node -e "
  const r = JSON.parse(process.argv[1]);
  if (r.error) { process.stderr.write(r.error + '\\n'); process.exit(1); }
  process.stdout.write(r.result || '');
" "$RESPONSE"
`;
  }
}
