/**
 * How the main system prompt reaches the Claude CLI: by file, and fresh on
 * every turn. Decision 0014.
 *
 * Two problems with the plain `--system-prompt <text>` /
 * `--append-system-prompt <text>` this replaces:
 *
 *   1. SIZE. Linux refuses a single argv string over 128 KiB (MAX_ARG_STRLEN),
 *      so a prompt past that died at spawn with `spawn E2BIG` — a turn that
 *      failed before the CLI ran. `--system-prompt-file` and
 *      `--append-system-prompt-file` take a path instead and pass the text
 *      whole (measured: 2 MB). Both flags are hidden from `claude --help` but
 *      present at least since 2.1.200, so they are gated on the detected
 *      version like the subagent prompt; an older or unknown version keeps
 *      the argv flags.
 *
 *   2. STALENESS. Claude Code 2.1.257 added `--system-prompt-snapshot`, on by
 *      default: the system prompt of a conversation's FIRST request is
 *      recorded and resent verbatim on every later request and `--resume`,
 *      even when a later launch passes different text, until the conversation
 *      is compacted. A server that rebuilds its prompt every turn was silently
 *      ignored from turn two on. `--system-prompt-snapshot off` renders it
 *      fresh on every request, which is what the bridge had before 2.1.257
 *      and what a per-turn `system_prompt` means. Passed on every turn of a
 *      2.1.257+ CLI, with or without a server prompt (the addendum and the
 *      CLI's own dynamic sections are per turn too).
 *
 * The files are 0600 in a fresh directory under os.tmpdir(), like the turn's
 * mcp.json and the subagent prompt: the text is the server's instructions and
 * not for other local users. They are removed when the process closes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../utils/logger.js';
import { getDetectedClaudeVersion, isVersionAtLeast } from './subagent-prompt.js';

export const SYSTEM_PROMPT_FILE_FLAG = '--system-prompt-file';
export const APPEND_SYSTEM_PROMPT_FILE_FLAG = '--append-system-prompt-file';
export const SNAPSHOT_FLAG = '--system-prompt-snapshot';

/** Oldest Claude Code verified to have both *-file flags (they are older). */
export const SYSTEM_PROMPT_FILE_MIN_VERSION = '2.1.200';

/** First Claude Code version with SNAPSHOT_FLAG (2.1.252 has none; 253 to 256 were never published). */
export const SNAPSHOT_MIN_VERSION = '2.1.257';

/** The written prompt files of one turn, and the way to remove them. */
export interface SystemPromptFilesHandle {
  /** Remove the files and their directory. Idempotent, never throws. */
  release(): void;
}

/**
 * The args that carry the main system prompt and the bridge addendum, and the
 * files they point at (null when nothing was written).
 *
 * `systemPrompt` replaces the CLI's default prompt; `addendum` is appended to
 * whichever prompt applies. Either may be null.
 */
export function prepareClaudeSystemPrompt(
  systemPrompt: string | null,
  addendum: string | null,
  log: Logger,
  version: string | null = getDetectedClaudeVersion(),
): { args: string[]; files: SystemPromptFilesHandle | null } {
  const args: string[] = [];

  if (isVersionAtLeast(version, SNAPSHOT_MIN_VERSION)) {
    args.push(SNAPSHOT_FLAG, 'off');
  }

  if (systemPrompt === null && addendum === null) {
    return { args, files: null };
  }

  if (!isVersionAtLeast(version, SYSTEM_PROMPT_FILE_MIN_VERSION)) {
    log.debug(`claude ${version ?? '(unknown version)'} predates ${SYSTEM_PROMPT_FILE_FLAG} (${SYSTEM_PROMPT_FILE_MIN_VERSION}+): passing the system prompt on argv`);
    if (systemPrompt !== null) args.push('--system-prompt', systemPrompt);
    if (addendum !== null) args.push('--append-system-prompt', addendum);
    return { args, files: null };
  }

  const dir = mkdtempSync(join(tmpdir(), 'ai-bridge-system-claude-'));
  let released = false;
  const files: SystemPromptFilesHandle = {
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover file in /tmp is untidy, not a failed turn.
      }
    },
  };
  try {
    if (systemPrompt !== null) {
      const path = join(dir, 'system-prompt.txt');
      writeFileSync(path, systemPrompt, { mode: 0o600 });
      args.push(SYSTEM_PROMPT_FILE_FLAG, path);
    }
    if (addendum !== null) {
      const path = join(dir, 'append-system-prompt.txt');
      writeFileSync(path, addendum, { mode: 0o600 });
      args.push(APPEND_SYSTEM_PROMPT_FILE_FLAG, path);
    }
  } catch (err) {
    files.release();
    throw err;
  }
  return { args, files };
}
