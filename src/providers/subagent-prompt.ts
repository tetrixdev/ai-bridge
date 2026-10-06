/**
 * Per-request subagent prompt (`ai_request.subagent_prompt`).
 *
 * The protocol field is provider-neutral; today only Claude Code can take it,
 * through `--append-subagent-system-prompt-file <file>` (print mode only,
 * Claude Code 2.1.261+). The CLI appends the file's text to the system prompt
 * of every subagent it starts, nested ones included. Forks are not subagents
 * in this sense: they reuse the main system prompt and do not get the text.
 * Other adapters ignore the field with a debug line — see
 * logIgnoredSubagentPrompt().
 *
 * An unknown flag is fatal to the Claude CLI (it exits before the first
 * event), so the flag is gated on the version the Detector found at startup.
 * The flag is hidden from `claude --help`, so the help probe that gates
 * `--include-partial-messages` cannot be used here. An older or unknown
 * version skips the flag with a warning and the turn runs without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../utils/logger.js';

export const SUBAGENT_PROMPT_FLAG = '--append-subagent-system-prompt-file';

/** First Claude Code version with SUBAGENT_PROMPT_FLAG. */
export const SUBAGENT_PROMPT_MIN_VERSION = '2.1.261';

/** The claude version the Detector last found, or null when none/unparsed. */
let detectedClaudeVersion: string | null = null;

/** Called by the Detector on every probe of `claude --version`. */
export function noteDetectedClaudeVersion(version: string | null): void {
  detectedClaudeVersion = version;
}

/** The claude version the bridge is working with (tests and logging). */
export function getDetectedClaudeVersion(): string | null {
  return detectedClaudeVersion;
}

/** Numeric `a.b.c` comparison; anything unparseable compares as "older". */
export function isVersionAtLeast(version: string | null, minimum: string): boolean {
  if (version === null) return false;
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(version);
  const need = parse(minimum);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/**
 * The text to pass, or null for "no flag".
 *
 * Absent, null, empty and whitespace-only all mean none. A non-string is
 * ignored with a warning rather than failing the turn.
 */
export function resolveSubagentPrompt(raw: unknown, log?: Logger): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    log?.warn('Ignoring request subagent_prompt: not a string', { type: Array.isArray(raw) ? 'array' : typeof raw });
    return null;
  }
  return raw.trim().length > 0 ? raw : null;
}

/** A written prompt file, and the way to remove it. */
export interface SubagentPromptFileHandle {
  path: string;
  /** Remove the file and its directory. Idempotent, never throws. */
  release(): void;
}

/**
 * Write the subagent prompt for one Claude turn into a fresh temp directory.
 *
 * Same location and mode as the turn's mcp.json (os.tmpdir(), 0600): the
 * text is the server's product instructions and not for other local users.
 */
export function writeSubagentPromptFile(text: string): SubagentPromptFileHandle {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bridge-subagent-claude-'));
  const path = join(dir, 'subagent-prompt.txt');
  writeFileSync(path, text, { mode: 0o600 });
  let released = false;
  return {
    path,
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
}

/**
 * For Claude: write the file and return the args to add, or skip.
 *
 * Returns null (and no file) when there is no prompt, or when the detected
 * CLI is older than SUBAGENT_PROMPT_MIN_VERSION or of unknown version — in
 * that case with a warning naming the version, because the server asked for
 * something this turn will not do.
 */
export function prepareClaudeSubagentPrompt(
  raw: unknown,
  log: Logger,
  version: string | null = detectedClaudeVersion,
): { args: string[]; file: SubagentPromptFileHandle } | null {
  const text = resolveSubagentPrompt(raw, log);
  if (text === null) return null;
  if (!isVersionAtLeast(version, SUBAGENT_PROMPT_MIN_VERSION)) {
    log.warn(`Skipping subagent_prompt: claude ${version ?? '(unknown version)'} has no ${SUBAGENT_PROMPT_FLAG} (needs ${SUBAGENT_PROMPT_MIN_VERSION}+)`);
    return null;
  }
  const file = writeSubagentPromptFile(text);
  return { args: [SUBAGENT_PROMPT_FLAG, file.path], file };
}

/** For adapters without subagent support: say the field was ignored. */
export function logIgnoredSubagentPrompt(raw: unknown, provider: string, log: Logger): void {
  if (raw === undefined || raw === null || raw === '') return;
  log.debug('Ignoring request subagent_prompt: provider has no subagent prompt support', { provider });
}
