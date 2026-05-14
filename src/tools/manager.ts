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

export class ToolManager {
  private tools = new Map<string, ToolDefinition>();
  private scriptDir: string | null = null;

  /**
   * Register tool definitions received from the server.
   * Replaces any previously registered tools.
   */
  register(tools: ToolDefinition[]): void {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    log.info('Registered tools', { count: tools.length, names: tools.map((t) => t.name) });
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
   */
  private buildScript(tool: ToolDefinition, callbackPort: number): string {
    // The script collects all positional arguments into a JSON payload
    // and POSTs them to the bridge's local callback server.
    return `#!/usr/bin/env bash
# Auto-generated tool wrapper for: ${tool.name}
# Description: ${tool.description}
# DO NOT EDIT — this file is regenerated on each bridge session.

set -euo pipefail

TOOL_NAME="${tool.name}"
CALLBACK_URL="http://127.0.0.1:${callbackPort}/tool-call"

# Collect all arguments into a JSON object.
# For simplicity, we pass the raw arguments as a single "input" field.
ARGS_JSON=$(cat <<'ARGS_EOF'
{}
ARGS_EOF
)

# If stdin has data, read it as the input
if [ ! -t 0 ]; then
  INPUT=$(cat)
  ARGS_JSON=$(printf '{"input": %s}' "$(echo "$INPUT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')")
fi

# If positional arguments were provided, pass them
if [ $# -gt 0 ]; then
  ARGS_JSON=$(printf '{"args": %s}' "$(printf '%s\\n' "$@" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))' 2>/dev/null || echo '[]')")
fi

# Send the tool call to the bridge and print the result
RESPONSE=$(curl -s -X POST "$CALLBACK_URL" \\
  -H "Content-Type: application/json" \\
  -d "$(printf '{"tool_name": "%s", "arguments": %s}' "$TOOL_NAME" "$ARGS_JSON")" \\
  --max-time 300)

# Check for errors
if echo "$RESPONSE" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if not d.get("error") else 1)' 2>/dev/null; then
  echo "$RESPONSE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",""))' 2>/dev/null
else
  echo "$RESPONSE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error","Unknown error"),file=sys.stderr)' 2>/dev/null
  exit 1
fi
`;
  }
}
