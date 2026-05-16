/**
 * Shared utilities for provider adapters.
 *
 * Centralizes environment variable construction, prompt building, and
 * stderr buffering that would otherwise be duplicated across all three
 * adapter implementations.
 */

/** Maximum stderr buffer size (10 KB). */
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
  // Remove bridge credential variables from the child process environment so
  // the token does not leak into /proc/<pid>/environ or the CLI's own logging.
  delete env['AI_BRIDGE_TOKEN'];
  delete env['AI_BRIDGE_SERVER'];
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
 * Append a chunk to a stderr buffer, capping at MAX_STDERR_BYTES (10 KB).
 *
 * Keeps the FIRST 10 KB rather than the last, because the beginning of CLI
 * stderr almost always contains the root-cause error while the tail tends to
 * be less useful stack traces.
 *
 * @param buffer  Current buffer contents.
 * @param chunk   New data to append.
 * @returns The updated (possibly truncated) buffer.
 */
export function appendStderr(buffer: string, chunk: string): string {
  // Once we have 10 KB, stop accumulating — root-cause is already there.
  if (buffer.length >= MAX_STDERR_BYTES) {
    return buffer;
  }
  buffer += chunk;
  if (buffer.length > MAX_STDERR_BYTES) {
    buffer = buffer.slice(0, MAX_STDERR_BYTES);
  }
  return buffer;
}

/**
 * Produce a user-friendly error message from raw CLI stderr output.
 *
 * Detects common known patterns (auth failures, rate limits) and returns a
 * clear actionable message.  Strips ANSI escape codes and limits to the first
 * meaningful line for unrecognized errors.
 *
 * @param provider  Provider name (e.g. "claude") used in fallback messages.
 * @param stderr    Raw stderr output from the CLI.
 * @param exitCode  Process exit code (for context).
 * @returns A user-facing error string.
 */
export function formatStderrMessage(provider: string, stderr: string, exitCode: number | null): string {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  const clean = stderr.replace(/\x1b\[[0-9;]*[mGKHFJSTsuABCDhl]/g, '').trim();

  if (!clean) {
    return `${provider} CLI exited with code ${exitCode ?? 'unknown'}`;
  }

  const lower = clean.toLowerCase();

  // Auth-related patterns
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthenticated') ||
    lower.includes('auth') ||
    lower.includes('login') ||
    lower.includes('authenticate') ||
    lower.includes('not logged in') ||
    lower.includes('sign in') ||
    lower.includes('credentials')
  ) {
    // Codex uses `codex login`; Claude and Gemini use `<provider> auth login`.
    const authCmd = provider === 'codex' ? `${provider} login` : `${provider} auth login`;
    return `Authentication required — run \`${authCmd}\` to re-authenticate.`;
  }

  // Rate limit patterns
  if (
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) {
    return `Rate limit reached — please wait a moment and try again.`;
  }

  // Return the first non-empty line, capped to 500 characters
  const firstLine = clean.split('\n').find((l) => l.trim()) ?? clean;
  return firstLine.substring(0, 500);
}
