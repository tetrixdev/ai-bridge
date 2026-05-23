/**
 * Shared utilities for provider adapters.
 *
 * Centralizes environment variable construction, prompt building, and
 * stderr buffering that would otherwise be duplicated across all three
 * adapter implementations.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Maximum stderr buffer size (10 KB). */
const MAX_STDERR_BYTES = 10 * 1024;

/** Cached path of the dedicated CLI working directory (created once). */
let cachedWorkingDir: string | null = null;

/**
 * Resolve the dedicated, empty working directory that every provider CLI is
 * spawned in.
 *
 * Claude, Codex and Gemini all auto-load project context files
 * (CLAUDE.md / AGENTS.md / GEMINI.md) from their working directory and its
 * parent directories. If a CLI inherited the bridge process's own cwd it
 * would silently absorb whatever happened to be there. Pinning every spawn
 * to a dedicated empty directory closes that leak.
 *
 * The directory lives under `~/.cache/ai-bridge/` rather than `os.tmpdir()`
 * because Gemini's "trusted folders" gate refuses to load project-scope
 * MCP servers from untrusted paths — and `/tmp/...` is never trusted, even
 * with `--skip-trust` (verified empirically: gemini-cli 0.42.0 reads the
 * project `.gemini/settings.json` but skips MCP initialisation when the
 * folder isn't trusted). Most operators already have `~` trusted via the
 * Gemini interactive setup, and trust inherits to subpaths, so a workdir
 * under HOME inherits trust without modifying `~/.gemini/trustedFolders.json`.
 *
 * NOTE: user-level files (e.g. `~/.claude/CLAUDE.md`) load regardless of
 * cwd — those are outside the working-directory mechanism and not affected
 * here. Closing that residual leakage requires HOME redirection — see
 * `tasks/open/cli-isolation-layer-b.md` in the stack.
 *
 * @returns Absolute path to the empty working directory (created if absent).
 */
export function getBridgeWorkingDir(): string {
  if (cachedWorkingDir) {
    return cachedWorkingDir;
  }
  // Ensure the parent cache dir exists, then mkdtempSync inside it so the
  // workdir name is unique per process. A fixed name would risk a previous
  // run's leftover files breaking the "empty cwd" guarantee.
  const cacheRoot = join(homedir(), '.cache', 'ai-bridge');
  mkdirSync(cacheRoot, { recursive: true });
  const dir = mkdtempSync(join(cacheRoot, 'workdir-'));
  cachedWorkingDir = dir;
  return dir;
}

/**
 * Build the environment variables for spawning a CLI subprocess.
 *
 * The legacy `toolScriptDir` parameter (prepended to PATH for the Bash-wrapper
 * tool plumbing) was removed when tool exposure moved to the bridge-side MCP
 * server. Callers now pass extra env entries directly when they need them
 * (e.g. AI_BRIDGE_MCP_TOKEN for codex's bearer-token-env-var integration).
 *
 * @param requestId  Optional request ID to pass as AI_BRIDGE_REQUEST_ID env
 *                   var for concurrent-request correlation.
 * @param extra      Additional env vars to merge in (overrides process.env).
 * @returns A copy of process.env with the requested modifications applied.
 */
export function buildSpawnEnv(
  requestId?: string,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (requestId) {
    env['AI_BRIDGE_REQUEST_ID'] = requestId;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }
  // Remove bridge credential variables from the child process environment so
  // the token does not leak into /proc/<pid>/environ or the CLI's own logging.
  delete env['AI_BRIDGE_TOKEN'];
  delete env['AI_BRIDGE_SERVER'];
  return env;
}

/**
 * Neutral fallback system prompt used in `isolated` mode when the server did
 * not provide one. Without this the CLI would fall back to its built-in
 * default — typically a coding-agent persona that leaks Claude-Code /
 * Codex / Gemini-CLI conventions into a chat that should be governed by the
 * server-side product. Kept intentionally generic.
 */
export const ISOLATED_FALLBACK_SYSTEM_PROMPT =
  'You are an AI assistant. Use only the tools provided to you to fulfil the user\'s request, and reply in plain prose.';

/**
 * Resolve the system prompt to pass to the CLI for this turn.
 *
 * - If the server sent one, use it as-is (regardless of isolation).
 * - In `isolated` mode with no server prompt, return the neutral fallback so
 *   the CLI's built-in default never seeps through.
 * - In `native` mode with no server prompt, return null — the CLI applies
 *   whatever it normally would.
 *
 * Returns null only when the CLI should be left to its own default.
 */
export function resolveSystemPrompt(
  serverPrompt: string | null,
  isolation: 'isolated' | 'native',
): string | null {
  if (serverPrompt) {
    return serverPrompt;
  }
  return isolation === 'isolated' ? ISOLATED_FALLBACK_SYSTEM_PROMPT : null;
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
