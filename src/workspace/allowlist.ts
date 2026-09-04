/**
 * The operator's allow-list of directories a server may name.
 *
 * Parsing and validation live here; the per-request containment check lives in
 * `resolve.ts`. The split matters: this runs once at startup, where a bad root
 * is an operator typo worth shouting about, while that runs on every request,
 * where a bad path is a server asking for something it may not have.
 *
 * The posture is the same as `--local-tools`: absent means nothing is allowed,
 * and no server can turn it on by sending a field. A bridge started without
 * `--allow-dir` cannot be pointed anywhere, which is the control that actually
 * carries weight — see the security note in the README.
 */

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, resolve as resolvePath } from 'node:path';
import type { WorkspaceRef } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Workspace');

/** One allowed root, after resolution. */
export interface AllowedRoot {
  /** Absolute, symlink-resolved path. Every containment check uses this. */
  path: string;
  /** Human-readable name, for the server's workspace picker. */
  label: string;
}

/**
 * Split one `--allow-dir` entry into its path and optional label.
 *
 * The form is `path[=label]`. Split on the LAST `=` rather than the first, so
 * a directory whose name contains `=` still parses: `~/a=b/repo=My repo`
 * yields `~/a=b/repo` and `My repo`, not `~/a` and `b/repo=My repo`.
 */
function splitEntry(entry: string): { rawPath: string; label: string | null } {
  const eq = entry.lastIndexOf('=');
  if (eq <= 0) {
    return { rawPath: entry, label: null };
  }
  const label = entry.slice(eq + 1).trim();
  return {
    rawPath: entry.slice(0, eq),
    // `path=` with nothing after it is a label the operator forgot to type,
    // not a workspace named the empty string.
    label: label.length > 0 ? label : null,
  };
}

/**
 * Expand a leading `~`.
 *
 * A shell does this for `--allow-dir ~/src`, but nothing does it for
 * `AI_BRIDGE_ALLOWED_DIRS=~/src` read out of a service unit or an env file,
 * which is exactly how onboarding sets it.
 */
function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolvePath(homedir(), input.slice(2));
  return input;
}

/**
 * Build the allow-list from the operator's flags and environment.
 *
 * Every root must already exist and be a directory: an allow-list entry that
 * does not resolve can only ever refuse requests, and doing so silently would
 * present as "the workspace feature is broken" rather than "you typed the path
 * wrong". Bad roots are reported and dropped.
 *
 * @param entries  Raw `--allow-dir` values, each `path[=label]`.
 * @param envValue Raw AI_BRIDGE_ALLOWED_DIRS value, delimiter-separated.
 * @returns The resolved roots, deduplicated, in the order given.
 * @throws  When every entry the operator supplied was invalid — an allow-list
 *          that silently collapsed to empty is worth failing the start over.
 */
export function buildAllowedRoots(entries: string[], envValue?: string): AllowedRoot[] {
  const raw = [
    ...entries,
    ...(envValue ? envValue.split(delimiter) : []),
  ]
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (raw.length === 0) {
    return [];
  }

  const roots: AllowedRoot[] = [];
  const seen = new Set<string>();
  const rejected: string[] = [];

  for (const entry of raw) {
    const { rawPath, label } = splitEntry(entry);

    // `path[=label]` is ambiguous for a directory whose own name contains `=`.
    // Resolve it by asking the filesystem rather than by guessing: try the
    // split first, since that is the documented form, and fall back to reading
    // the whole entry as a path when the split half does not exist but the
    // whole does. Without this, `--allow-dir ~/work/a=b` is silently read as
    // the directory `~/work/a` labelled "b" and then rejected as missing.
    const attempts: { path: string; label: string | null }[] = [{ path: rawPath, label }];
    if (label !== null) {
      attempts.push({ path: entry, label: null });
    }

    let resolved: string | null = null;
    let chosenLabel: string | null = null;
    let failure = '';

    for (const attempt of attempts) {
      const expanded = expandTilde(attempt.path.trim());
      if (expanded.includes('\0')) {
        failure = failure || 'path contains a null byte';
        continue;
      }
      try {
        // realpath, not just resolve: every containment check compares against
        // this value, and comparing a request's real path against a root that
        // is still a symlink would reject legitimate paths (or, worse, accept
        // the wrong ones) depending on which side happened to be resolved.
        const candidate = realpathSync(resolvePath(expanded));
        if (!statSync(candidate).isDirectory()) {
          failure = failure || 'not a directory';
          continue;
        }
        resolved = candidate;
        chosenLabel = attempt.label;
        break;
      } catch (err) {
        failure = failure || (err instanceof Error ? err.message : String(err));
      }
    }

    if (resolved === null) {
      rejected.push(`${entry} (${failure})`);
      continue;
    }

    const finalLabel = chosenLabel;

    if (seen.has(resolved)) {
      // A duplicate is harmless, but keeping the first label is the least
      // surprising resolution and stops the picker showing the same checkout
      // twice.
      continue;
    }
    seen.add(resolved);
    roots.push({ path: resolved, label: finalLabel ?? basename(resolved) });
  }

  for (const bad of rejected) {
    log.error(`--allow-dir entry ignored: ${bad}`);
  }

  if (roots.length === 0) {
    throw new Error(
      `None of the ${raw.length} --allow-dir entr${raw.length === 1 ? 'y' : 'ies'} could be used: `
      + `${rejected.join('; ')}. Each must be an existing directory.`,
    );
  }

  return roots;
}

/** Render the allow-list for the `workspaces` field of the hello message. */
export function toWorkspaceRefs(roots: AllowedRoot[]): WorkspaceRef[] {
  return roots.map((r) => ({ path: r.path, label: r.label }));
}

/** Just the paths, which is all the containment check needs. */
export function rootPaths(roots: AllowedRoot[]): string[] {
  return roots.map((r) => r.path);
}

/** True when a raw path is absolute and free of null bytes. */
export function isUsablePath(input: string): boolean {
  return input.length > 0 && !input.includes('\0') && isAbsolute(input);
}
