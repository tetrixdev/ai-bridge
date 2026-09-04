/**
 * Where downloaded attachments live on disk, and what they are allowed to be
 * called.
 *
 * Deliberately under the bridge's own cache directory and never inside the
 * working directory. A repository checkout must not be dirtied by the
 * transport: a file that appears in `git status` because someone sent a PDF to
 * a chat is a surprise the developer did not ask for, and one the assistant
 * might then commit. If the file genuinely belongs in the repo, the developer
 * asks the assistant to copy it there — which it can, because it has both the
 * path and a shell.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/** Longest filename the bridge will write, including its extension. */
const MAX_NAME_LENGTH = 120;

/** Root of the per-request attachment directories. */
export function attachmentsRoot(): string {
  return join(homedir(), '.cache', 'ai-bridge', 'attachments');
}

/**
 * Reduce a server-supplied request id to something safe to use as a directory
 * name.
 *
 * The request id is a server-chosen string that the bridge is about to join
 * onto a filesystem path. `../../.ssh` is a perfectly good JSON string.
 */
export function safeRequestDirName(requestId: string): string {
  const cleaned = requestId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  // A short digest of the RAW id, because the sanitiser above is lossy in two
  // ways: `req/1` and `req:1` both become `req_1`, and any two ids sharing a
  // long prefix collide once truncated. Two concurrent turns sharing one
  // directory is not a cosmetic problem — whichever finishes first deletes the
  // other's files while its CLI is still reading the paths named in the
  // preamble, and the model reports a file the user definitely attached as
  // missing or corrupt.
  const digest = createHash('sha256').update(requestId).digest('hex').slice(0, 12);
  return `${cleaned.length > 0 ? cleaned : 'request'}-${digest}`;
}

/** The directory this request's attachments are written into. */
export function attachmentDirFor(requestId: string): string {
  return join(attachmentsRoot(), safeRequestDirName(requestId));
}

/**
 * Request directories with files currently on disk.
 *
 * The per-turn `finally` only runs when the turn settles, which it never does
 * if the process is terminated — the shutdown handler aborts the requests and
 * calls process.exit without waiting for async cleanup. Without this the
 * files, which are whatever a colleague sent into a chat, would sit in the
 * cache indefinitely, contrary to the unqualified promise that they are
 * deleted when the turn ends.
 */
const liveAttachmentDirs = new Set<string>();

let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;

  process.on('exit', () => {
    for (const requestId of liveAttachmentDirs) {
      try {
        rmSync(attachmentDirFor(requestId), { recursive: true, force: true });
      } catch {
        // Best-effort by definition: the process is already going away.
      }
    }
    liveAttachmentDirs.clear();
  });
}

/** Create the request's attachment directory, private to this user. */
export function ensureAttachmentDir(requestId: string, keep = false): string {
  const dir = attachmentDirFor(requestId);
  // 0700: the files are whatever a colleague sent into a chat, and there is no
  // reason for another local account to read them.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // `keep` stays out of the exit hook's list entirely. The operator's whole
  // debugging flow with --keep-attachments is: reproduce, Ctrl-C the bridge,
  // go and look at the files. An exit hook that deleted them on the way out
  // would make the flag do the opposite of what it says, and only on the exit
  // path — so it would look like it worked right up until you went looking.
  if (!keep) {
    installExitHook();
    liveAttachmentDirs.add(requestId);
  }

  return dir;
}

/** Test seam: run the exit-time cleanup, as process termination would. */
export function removeAttachmentDirsOnExit(): void {
  for (const requestId of liveAttachmentDirs) {
    rmSync(attachmentDirFor(requestId), { recursive: true, force: true });
  }
  liveAttachmentDirs.clear();
}

/**
 * Delete a request's attachment directory. Idempotent and best-effort.
 *
 * Called on every terminal outcome — done, error and cancelled alike — because
 * the failure mode of "only on success" is a cache directory that grows
 * without bound precisely on the machines where things go wrong most.
 */
export function removeAttachmentDir(requestId: string): void {
  liveAttachmentDirs.delete(requestId);
  rmSync(attachmentDirFor(requestId), { recursive: true, force: true });
}

/**
 * Turn a server-supplied filename into a single safe path component.
 *
 * The server's filename is never trusted to be one. Everything here is about a
 * name that arrives looking like a path:
 *
 *   - separators of BOTH kinds are stripped, not just the platform's — a
 *     server on Windows sends `docs\report.pdf`, and on Linux that is one
 *     filename containing a backslash rather than a directory;
 *   - `.` and `..` are names that traverse rather than identify;
 *   - a leading dot would write a hidden file, which is a poor thing to be
 *     able to do to someone else's cache directory;
 *   - the length is capped with the extension preserved, because the extension
 *     is what tells the model (and the CLI's own file reader) what it is
 *     holding.
 *
 * @param name  The server's `attachments[].name`.
 * @param id    The attachment id, used when nothing usable survives.
 */
export function sanitiseAttachmentName(name: string, id: string): string {
  // Not safeRequestDirName(): that one appends a digest to guarantee directory
  // uniqueness, which is exactly what a human-readable filename does not want.
  const fallback = `attachment-${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'file'}`;

  // Take the last segment under either separator convention.
  const lastSegment = name.split(/[/\\]/).pop() ?? '';

  let cleaned = lastSegment
    .replace(/\0/g, '')
    // Control characters are not useful in a filename and are actively
    // confusing in a prompt preamble the model is about to read.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Leading dots and whitespace stripped in ONE pass. Doing it in two —
    // whichever order — leaves the other character type able to re-expose what
    // the first pass removed: ". .bashrc" survives a trim-then-strip as
    // ".bashrc", and " .bashrc" survives a strip-then-trim the same way.
    .replace(/^[.\s]+/, '')
    .trimEnd();

  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return fallback;
  }

  if (cleaned.length > MAX_NAME_LENGTH) {
    const ext = extname(cleaned).slice(0, 16);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }

  return cleaned;
}

/**
 * Give each file a distinct name within one request.
 *
 * Two attachments legitimately called `screenshot.png` must not become one
 * file: the second download would overwrite the first, and the model would be
 * told about two paths of which one holds the wrong bytes.
 */
export function disambiguate(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
