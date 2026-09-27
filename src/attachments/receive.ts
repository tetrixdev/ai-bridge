/**
 * A file a person is sending to this machine, arriving now.
 *
 * The other shape of inbound file. `attachments` on an `ai_request` are
 * references to files the SERVER holds, fetched when a turn starts, kept for
 * that turn and deleted after it. This is a file the server does not hold at
 * all: somebody picked it in a chat composer, the server is passing the bytes
 * straight through from their browser, and the copy on this machine is the only
 * copy there is. So it is not a cache entry and it is not deleted when a turn
 * ends. It lands in `<working folder>/file-uploads/`, beside the work it is
 * about, and stays there like anything else the person put in that folder.
 *
 * The bytes still never travel over the WebSocket, for the reason
 * `fetch.ts` gives: the socket's frame caps are far below a file. The socket
 * carries three small frames (`upload_offer`, `upload_sent`, `upload_abort`)
 * and one answer (`upload_done`); the bytes come over one authenticated HTTP
 * GET from the same origin attachments are fetched from.
 *
 * Nothing is visible under its real name until the digest the server computed
 * from the browser's bytes matches the one computed here. Until then the file
 * is a hidden `.part`, and every failure — refused, too large, cancelled,
 * stalled, a checksum that disagrees — removes it.
 */

import { createHash } from 'node:crypto';
import {
  constants as fsConstants, copyFileSync, createWriteStream, linkSync, lstatSync, mkdirSync,
  openSync, rmSync, writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { RequestRefusal } from '../errors.js';
import { resolveWorkingDir } from '../workspace/resolve.js';
import {
  DEFAULT_ATTACHMENT_TIMEOUTS,
  downloadClock,
  humanBytes,
  type AttachmentTimeouts,
} from './fetch.js';
import { assertAllowedAttachmentUrl } from './origin.js';
import { sanitiseAttachmentName } from './store.js';

/** The folder, inside the working folder, that uploads land in. */
export const UPLOADS_DIR = 'file-uploads';

/** Refusal codes this module emits, on top of the working_dir_* ones it passes through. */
export const UPLOAD_REFUSED = 'upload_refused';
export const UPLOAD_TOO_LARGE = 'upload_too_large';
export const UPLOAD_FAILED = 'upload_failed';
export const UPLOAD_CANCELLED = 'upload_cancelled';

/** How long, after the bytes have all arrived, to wait for the server's digest. */
const SENT_WAIT_MS = 60_000;

/** `upload_offer`, as the server sends it. */
export interface UploadOffer {
  id: string;
  /** Where to GET the bytes. Must be on the connected server's origin. */
  url: string;
  /** The thread's working folder. Checked against the allow-list like any `working_dir`. */
  working_dir: string;
  name: string;
  mime_type?: string;
  /** Exact byte count the browser declared. What arrives must be this, no more, no less. */
  size: number;
}

/** `upload_sent`: what the server counted and hashed as the bytes went through it. */
export interface UploadSent {
  size: number;
  sha256: string;
}

/** A file that is now on this machine under its own name. */
export interface ReceivedUpload {
  /** Absolute path of the file. */
  path: string;
  /** The name it was given, which differs from the offered one on a collision. */
  name: string;
  size: number;
  sha256: string;
}

/**
 * Receive one upload.
 *
 * @param sent   Resolves when the server's `upload_sent` arrives. Created by the
 *               caller when the offer arrives, because the frame can overtake
 *               the last bytes of the HTTP body and must not be missed.
 * @param signal Aborts on `upload_abort` and when the socket drops.
 * @throws RequestRefusal — with a code the server turns into a sentence. The
 *         partial file is gone by the time this throws.
 */
export async function receiveUpload(opts: {
  offer: UploadOffer;
  allowedRoots: string[];
  token: () => string;
  expectedOrigin: string;
  maxFileBytes: number;
  timeouts?: AttachmentTimeouts;
  sent: Promise<UploadSent>;
  signal: AbortSignal;
}): Promise<ReceivedUpload> {
  const { offer, allowedRoots, token, expectedOrigin, maxFileBytes, sent, signal } = opts;
  const timeouts = opts.timeouts ?? DEFAULT_ATTACHMENT_TIMEOUTS;

  if (allowedRoots.length === 0) {
    // Said before anything else: a talk-only machine has no folder anybody
    // chose, and inventing one (the scratch dir, the home dir) would put a
    // person's file somewhere they never agreed to.
    throw new RequestRefusal(
      UPLOAD_REFUSED,
      'This machine has no folder set up for chats (the bridge was started without --allow-dir), '
      + 'so there is nowhere on it to put a file.',
    );
  }
  if (!Number.isSafeInteger(offer.size) || offer.size < 0) {
    throw new RequestRefusal(UPLOAD_REFUSED, `The upload's declared size (${String(offer.size)}) is not a byte count.`);
  }
  if (offer.size > maxFileBytes) {
    throw new RequestRefusal(
      UPLOAD_TOO_LARGE,
      `"${offer.name}" is ${humanBytes(offer.size)}, over this machine's ${humanBytes(maxFileBytes)} per-file limit.`,
    );
  }
  // The URL is checked before the folder is touched: a server that names a
  // host other than itself gets nothing, not even a directory created.
  let url: URL;
  try {
    url = assertAllowedAttachmentUrl(offer.url, expectedOrigin);
  } catch (err) {
    throw new RequestRefusal(UPLOAD_REFUSED, messageOf(err));
  }

  // The same rules as a turn's working_dir, by the same function: inside an
  // allowed root after realpath, existing, a directory. Its refusals keep
  // their own codes (working_dir_not_allowed / _not_found).
  const workingDir = resolveWorkingDir(offer.working_dir, allowedRoots);
  const dir = uploadsDirIn(workingDir);

  const partial = join(dir, `.${offer.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.part`);
  let fd: number;
  try {
    // `wx`: never follows or reuses whatever is already at that name.
    fd = openSync(partial, 'wx', 0o600);
  } catch (err) {
    throw new RequestRefusal(UPLOAD_FAILED, `Could not start writing into ${dir}: ${messageOf(err)}`);
  }

  try {
    const { size, sha256 } = await download(url, partial, fd, offer, token, timeouts, signal);
    const server = await withTimeout(sent, SENT_WAIT_MS, signal,
      'the server never confirmed what it sent');
    // Three numbers that must agree: what the browser declared, what the
    // server counted, what arrived here. And one digest. Anything else is a
    // file that is not the one the person picked.
    if (size !== offer.size || server.size !== size) {
      throw new RequestRefusal(
        UPLOAD_FAILED,
        `"${offer.name}" arrived as ${size} bytes; ${offer.size} were declared and the server passed on ${server.size}.`,
      );
    }
    if (server.sha256.toLowerCase() !== sha256) {
      throw new RequestRefusal(
        UPLOAD_FAILED,
        `"${offer.name}" failed its checksum (the server sent ${server.sha256}, this machine received ${sha256}).`,
      );
    }
    const name = commit(partial, dir, sanitiseAttachmentName(offer.name, offer.id));
    return { path: join(dir, name), name, size, sha256 };
  } finally {
    // A no-op after a commit, which has already unlinked it.
    rmSync(partial, { force: true });
  }
}

/**
 * `<workingDir>/file-uploads`, made if it is not there, refused if it is not
 * a plain directory.
 *
 * A symlink is refused rather than followed. In `workspace` the assistant has
 * a shell in this folder, and `file-uploads -> ~/.ssh` would otherwise be a way
 * to have the next file somebody sends written somewhere they never chose.
 */
export function uploadsDirIn(workingDir: string): string {
  const dir = join(workingDir, UPLOADS_DIR);
  let made = false;
  try {
    mkdirSync(dir, { mode: 0o700 });
    made = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new RequestRefusal(UPLOAD_FAILED, `Could not create ${dir}: ${messageOf(err)}`);
    }
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RequestRefusal(
      UPLOAD_REFUSED,
      `${dir} is not a plain folder (it is a link or a file), so nothing is written through it.`,
    );
  }
  if (made) {
    // Kept out of git. The folder sits inside somebody's checkout, and a PDF a
    // client sent turning up in `git status` -- or being committed by an
    // assistant told to "commit everything" -- is a surprise nobody asked for.
    // Only on creation, so a person who deletes it has the last word.
    try {
      writeFileSync(join(dir, '.gitignore'), '# Files sent from a chat. Not part of the project unless you add them.\n*\n', { flag: 'wx' });
    } catch { /* best effort: the upload matters more than the ignore file */ }
  }
  return dir;
}

/**
 * Give the verified file its real name without ever replacing another file.
 *
 * `link` fails with EEXIST instead of overwriting, which makes "pick a free
 * name" and "take it" one atomic step, so two uploads of `report.pdf` at the
 * same moment become `report.pdf` and `report-2.pdf` rather than one of them.
 * Where hard links are unsupported, an exclusive copy does the same job.
 */
function commit(partial: string, dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= 1000; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    const target = join(dir, candidate);
    try {
      try {
        linkSync(partial, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw err;
        copyFileSync(partial, target, fsConstants.COPYFILE_EXCL);
      }
      rmSync(partial, { force: true });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new RequestRefusal(UPLOAD_FAILED, `Could not save "${name}" in ${dir}: ${messageOf(err)}`);
    }
  }
  throw new RequestRefusal(UPLOAD_FAILED, `There are already a thousand files called "${name}" in ${dir}.`);
}

/** Stream the body into `fd`, hashing and counting, capped at the declared size. */
async function download(
  url: URL, partial: string, fd: number, offer: UploadOffer, token: () => string,
  timeouts: AttachmentTimeouts, signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const clock = downloadClock(signal, timeouts);
  // The stream owns the descriptor from here: it closes it on end and on
  // destroy, so nothing else may (a closed number can be reused at once).
  const sink = createWriteStream(partial, { fd, autoClose: true });
  let sinkError: Error | null = null;
  sink.on('error', (err: Error) => { sinkError = err; });
  let written = 0;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` },
      // As for attachments: a redirect is how the origin check would be bypassed.
      redirect: 'error',
      signal: clock.signal,
    });
    if (!response.ok || !response.body) {
      let why = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string; message?: string };
        why = body.error ?? body.message ?? why;
      } catch { /* not JSON */ }
      throw new RequestRefusal(UPLOAD_FAILED, `The server would not hand over "${offer.name}": ${why}`);
    }
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (sinkError) throw sinkError;
        const { done, value } = await reader.read();
        if (done) break;
        clock.progress();
        written += value.byteLength;
        if (written > offer.size) {
          throw new RequestRefusal(
            UPLOAD_FAILED,
            `"${offer.name}" kept coming past the ${offer.size} bytes that were declared.`,
          );
        }
        hash.update(value);
        if (!sink.write(value)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err: Error) => { cleanup(); reject(err); };
            const onAbort = () => { cleanup(); reject(new Error('aborted')); };
            const cleanup = () => {
              sink.off('drain', onDrain);
              sink.off('error', onError);
              clock.signal.removeEventListener('abort', onAbort);
            };
            sink.once('drain', onDrain);
            sink.once('error', onError);
            clock.signal.addEventListener('abort', onAbort, { once: true });
          });
          clock.progress();
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    }
    await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (sinkError) throw sinkError;
    return { size: written, sha256: hash.digest('hex') };
  } catch (err) {
    sink.destroy();
    if (err instanceof RequestRefusal) throw err;
    if (signal.aborted) {
      throw new RequestRefusal(UPLOAD_CANCELLED, `The upload of "${offer.name}" was stopped: ${reasonOf(signal)}`);
    }
    const why = clock.expired();
    throw new RequestRefusal(
      UPLOAD_FAILED,
      why !== null
        ? `The upload of "${offer.name}" stalled: ${why} (${humanBytes(written)} of ${humanBytes(offer.size)} received).`
        : `The upload of "${offer.name}" failed after ${humanBytes(written)} of ${humanBytes(offer.size)}: ${messageOf(err)}`,
    );
  } finally {
    clock.done();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new RequestRefusal(UPLOAD_FAILED, `${what} within ${ms / 1000}s.`)); }, ms);
    const onAbort = () => { done(); reject(new RequestRefusal(UPLOAD_CANCELLED, `The upload was stopped: ${reasonOf(signal)}`)); };
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { done(); resolve(v); }, (e: unknown) => { done(); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

function reasonOf(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return r instanceof Error ? r.message : typeof r === 'string' ? r : 'cancelled';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
