/**
 * A long-lived Claude token for a bridge that runs as a service.
 *
 * `claude setup-token` prints a token (CLAUDE_CODE_OAUTH_TOKEN) meant for
 * exactly this: a machine nobody signs into interactively, such as a server
 * reached over SSH. Claude Code reads it from its environment, so the bridge
 * puts it there, and every CLI it spawns inherits it.
 *
 * The token lives in a file of its own (0600), named by AI_BRIDGE_CLAUDE_ENV or
 * `--claude-env`, rather than in the bridge's env file or the unit: one copy,
 * renewed by editing one line and restarting. A token already in the
 * environment wins, so a person can still override it for one run.
 */
import { readFileSync, statSync } from 'node:fs';

export const CLAUDE_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

export type ClaudeTokenOutcome =
  | { status: 'loaded'; path: string }
  | { status: 'already_set' }
  | { status: 'unreadable'; path: string; reason: string }
  | { status: 'no_token'; path: string }
  | { status: 'too_open'; path: string; mode: string };

/** The token in a KEY=value file, or null. `export ` and one pair of quotes
 *  are accepted, since that is how people write a file they also `source`. */
export function parseClaudeEnv(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${CLAUDE_TOKEN_KEY}=`)) continue;
    let value = line.slice(CLAUDE_TOKEN_KEY.length + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/**
 * Put the token from `path` into `env`, unless one is already there.
 *
 * Refuses a file others can read rather than using it: a token anybody on the
 * machine could copy is a sign-in anybody on the machine has. Every refusal is
 * returned with its reason, for the caller to log; none of them is fatal,
 * because a bridge with other CLIs still has work to do without Claude.
 */
export function loadClaudeToken(path: string, env: NodeJS.ProcessEnv = process.env): ClaudeTokenOutcome {
  if (env[CLAUDE_TOKEN_KEY]) return { status: 'already_set' };
  let text: string;
  try {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      return { status: 'too_open', path, mode: mode.toString(8).padStart(3, '0') };
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { status: 'unreadable', path, reason: err instanceof Error ? err.message : String(err) };
  }
  const token = parseClaudeEnv(text);
  if (!token) return { status: 'no_token', path };
  env[CLAUDE_TOKEN_KEY] = token;
  return { status: 'loaded', path };
}
