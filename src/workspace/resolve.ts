/**
 * Turning a server's requested working directory into one the bridge will
 * actually spawn a CLI in — or a refusal.
 *
 * Every rule here is a refusal rather than a correction. Silently "fixing" a
 * path the server asked for is how a turn ends up running somewhere nobody
 * chose; silently falling back to the empty scratch directory is worse still,
 * because the turn then LOOKS like it worked and every answer in it is about
 * an empty directory.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { RequestRefusal } from '../errors.js';
import { getBridgeWorkingDir } from '../providers/env.js';

/** Refusal codes this module emits, as stream-event error codes. */
export const WORKING_DIR_NOT_ALLOWED = 'working_dir_not_allowed';
export const WORKING_DIR_NOT_FOUND = 'working_dir_not_found';
export const WORKING_DIR_CHANGED = 'working_dir_changed';

/**
 * Is `candidate` the root itself, or somewhere beneath it?
 *
 * The `+ sep` is what stops `/home/a/srclib` matching the root `/home/a/src`.
 * Both sides must already be resolved: comparing strings before resolving
 * symlinks is precisely the escape this check exists to close.
 */
function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Render the allow-list for an error message, or say there isn't one. */
function describeRoots(allowedRoots: string[]): string {
  if (allowedRoots.length === 0) {
    return 'this bridge was started without --allow-dir, so no directory may be named';
  }
  return `allowed: ${allowedRoots.join(', ')}`;
}

/**
 * Resolve the directory to spawn the CLI in.
 *
 * @param requested     `ai_request.working_dir`, or undefined for today's behaviour.
 * @param allowedRoots  Absolute, already symlink-resolved roots from `--allow-dir`.
 * @param sessionDir    Where the CLI session being resumed was started, when
 *                      the bridge still remembers it. Undefined for a fresh
 *                      session, and for a resume after a bridge restart.
 * @returns The absolute path to spawn in.
 * @throws  RequestRefusal — the turn must not run. The caller reports the code
 *          as an `error` stream event and does not spawn.
 */
export function resolveWorkingDir(
  requested: string | undefined,
  allowedRoots: string[],
  sessionDir?: string,
): string {
  // 1. Nothing named.
  //
  //    On a fresh turn that is the empty scratch directory, exactly as before,
  //    and it is the only path that reaches it.
  //
  //    On a RESUME it is the directory the session already runs in. The server
  //    is not required to resend `working_dir` on every turn — the protocol
  //    says absent means "the default", and the session's own directory is
  //    what the default means once a session exists. Treating absent as "the
  //    scratch directory" instead would refuse the turn as `working_dir_changed`
  //    with a message claiming the request asked for a temp directory it never
  //    mentioned, and the documented recovery (start a fresh session) would
  //    then quietly run in that empty directory — the outcome this whole
  //    module exists to prevent.
  if (requested === undefined || requested === null || requested === '') {
    return sessionDir ?? getBridgeWorkingDir();
  }

  // 2. The operator never opted in. Reported before anything is touched on
  //    disk, because at this point the answer cannot depend on the path.
  if (allowedRoots.length === 0) {
    throw new RequestRefusal(
      WORKING_DIR_NOT_ALLOWED,
      `The server asked to work in "${requested}", but ${describeRoots(allowedRoots)}. `
      + 'Restart the bridge with --allow-dir <path> (repeatable) to permit it.',
    );
  }

  // 3. Shapes that can never be valid, and that a later realpath would report
  //    as a confusing ENOENT.
  if (requested.includes('\0')) {
    throw new RequestRefusal(WORKING_DIR_NOT_ALLOWED, 'The requested working directory contains a null byte.');
  }
  if (!isAbsolute(requested)) {
    throw new RequestRefusal(
      WORKING_DIR_NOT_ALLOWED,
      `The requested working directory "${requested}" is not an absolute path.`,
    );
  }

  // 4a. A lexical containment pre-check, BEFORE touching the filesystem.
  //
  // This is not the security check — 4b is — but it decides what the server is
  // allowed to learn. Without it, a path far outside the allow-list would come
  // back as "does not exist" or "exists", turning the bridge into a filesystem
  // probe for whoever it is connected to. Anything not even lexically inside a
  // root is refused as not-allowed and never stat'd.
  const lexical = resolvePath(requested);
  if (!allowedRoots.some((root) => isWithin(lexical, root))) {
    throw new RequestRefusal(
      WORKING_DIR_NOT_ALLOWED,
      `The server asked to work in "${requested}", which is not inside a permitted root (${describeRoots(allowedRoots)}).`,
    );
  }

  // 5. It must already exist, and it must be a directory. NEVER create it: a
  //    typo that silently starts an empty session is indistinguishable from a
  //    session that worked, and the developer only finds out when the
  //    assistant reports that the repository is empty.
  let resolved: string;
  let isDirectory: boolean;
  try {
    resolved = realpathSync(lexical);
    // Inside the SAME try as the realpath. If the directory disappears between
    // the two calls, a bare Error escapes — and on a resumed turn the bridge
    // translates any non-refusal into `session_lost`, which tells the server to
    // wipe the session and silently re-issue. A vanished directory would then
    // be retried forever instead of reported once.
    isDirectory = statSync(resolved).isDirectory();
  } catch {
    throw new RequestRefusal(
      WORKING_DIR_NOT_FOUND,
      `The requested working directory "${requested}" does not exist. `
      + 'The bridge never creates it — check the path.',
    );
  }
  if (!isDirectory) {
    throw new RequestRefusal(
      WORKING_DIR_NOT_FOUND,
      `The requested working directory "${requested}" is not a directory.`,
    );
  }

  // 4b. The real check, on the resolved path. A symlink sitting inside an
  //     allowed root and pointing outside it passes 4a and fails here, which
  //     is the entire reason the comparison happens after realpath.
  if (!allowedRoots.some((root) => isWithin(resolved, root))) {
    throw new RequestRefusal(
      WORKING_DIR_NOT_ALLOWED,
      `The requested working directory "${requested}" resolves to "${resolved}", `
      + `which is not inside a permitted root (${describeRoots(allowedRoots)}).`,
    );
  }

  // 6. A working directory belongs to a CLI session for that session's whole
  //    life. Resuming a session started elsewhere is incoherent — its history
  //    is all about another checkout and the model has no way to know the
  //    ground moved — so it is reported rather than papered over, and the
  //    server starts a fresh session deliberately.
  //
  //    Compared against the RESOLVED path, so naming the same directory
  //    through a symlink is not mistaken for a change.
  if (sessionDir !== undefined && sessionDir !== resolved) {
    throw new RequestRefusal(
      WORKING_DIR_CHANGED,
      `This conversation's CLI session was started in "${sessionDir}", but the request `
      + `asks for "${resolved}". A session cannot change working directory. `
      + 'Start a new conversation, or send this turn without resuming.',
    );
  }

  return resolved;
}
