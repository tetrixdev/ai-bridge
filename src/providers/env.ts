/**
 * Shared utilities for provider adapters.
 *
 * Centralizes environment variable construction, prompt building, and
 * stderr buffering that would otherwise be duplicated across all three
 * adapter implementations.
 */

/** SEC-005: Maximum stderr buffer size (10 KB). */
const MAX_STDERR_BYTES = 10 * 1024;

/**
 * Build the environment variables for spawning a CLI subprocess.
 *
 * @param toolScriptDir  Directory containing tool wrapper scripts to prepend
 *                       to PATH, or null to skip PATH modification (e.g. for
 *                       Codex which handles tools internally).
 * @param requestId      Optional request ID to pass as AI_BRIDGE_REQUEST_ID
 *                       env var for concurrent-request correlation.
 * @returns A copy of process.env with the requested modifications applied.
 */
export function buildSpawnEnv(toolScriptDir: string | null, requestId?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (toolScriptDir) {
    env['PATH'] = `${toolScriptDir}:${env['PATH'] ?? ''}`;
  }
  if (requestId) {
    env['AI_BRIDGE_REQUEST_ID'] = requestId;
  }
  return env;
}

/**
 * Build a combined prompt by prepending the system prompt to the user message.
 *
 * Used by providers (Gemini, Codex) whose CLIs lack a dedicated
 * --system-prompt flag, so system instructions must be concatenated
 * into the user-facing prompt string.
 *
 * @param systemPrompt  The system-level instructions.
 * @param userMessage   The user's actual request message.
 * @returns A single string with the system prompt followed by the user message.
 */
export function buildCombinedPrompt(systemPrompt: string, userMessage: string): string {
  return `${systemPrompt}\n\nUser request:\n${userMessage}`;
}

/**
 * SEC-005: Append a chunk to a stderr buffer, capping at MAX_STDERR_BYTES (10 KB).
 * When the limit is exceeded, only the last 10 KB is kept.
 *
 * @param buffer  Current buffer contents.
 * @param chunk   New data to append.
 * @returns The updated (possibly truncated) buffer.
 */
export function appendStderr(buffer: string, chunk: string): string {
  buffer += chunk;
  if (buffer.length > MAX_STDERR_BYTES) {
    buffer = buffer.slice(buffer.length - MAX_STDERR_BYTES);
  }
  return buffer;
}
