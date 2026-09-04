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
  const cleaned = requestId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'request';
}

/** The directory this request's attachments are written into. */
export function attachmentDirFor(requestId: string): string {
  return join(attachmentsRoot(), safeRequestDirName(requestId));
}

/** Create the request's attachment directory, private to this user. */
export function ensureAttachmentDir(requestId: string): string {
  const dir = attachmentDirFor(requestId);
  // 0700: the files are whatever a colleague sent into a chat, and there is no
  // reason for another local account to read them.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Delete a request's attachment directory. Idempotent and best-effort.
 *
 * Called on every terminal outcome — done, error and cancelled alike — because
 * the failure mode of "only on success" is a cache directory that grows
 * without bound precisely on the machines where things go wrong most.
 */
export function removeAttachmentDir(requestId: string): void {
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
  const fallback = `attachment-${safeRequestDirName(id)}`;

  // Take the last segment under either separator convention.
  const lastSegment = name.split(/[/\\]/).pop() ?? '';

  let cleaned = lastSegment
    .replace(/\0/g, '')
    // Control characters are not useful in a filename and are actively
    // confusing in a prompt preamble the model is about to read.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim();

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
