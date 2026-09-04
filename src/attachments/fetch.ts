/**
 * Fetching a turn's attachments onto disk.
 *
 * The bytes never travel over the WebSocket. Three caps make that decision for
 * us: the bridge's client accepts 10 MB frames, the server's WebSocket message
 * cap is 1 MB, and its HTTP relay body cap is 16 MB — so a single screenshot,
 * once base64 has added a third, already exceeds the tightest of them. Worse,
 * it would exceed it as a dropped WebSocket message rather than as an error
 * anybody could act on.
 *
 * So the server sends references and the bridge fetches them, over HTTPS, from
 * the one origin it is connected to, with its own connection token.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentRef } from '../protocol/types.js';
import { RequestRefusal } from '../errors.js';
import { assertAllowedAttachmentUrl, AttachmentUrlError } from './origin.js';
import { disambiguate, ensureAttachmentDir, sanitiseAttachmentName } from './store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Attachments');

/** Refusal codes this module emits. */
export const ATTACHMENT_REFUSED = 'attachment_refused';
export const ATTACHMENT_TOO_LARGE = 'attachment_too_large';
export const ATTACHMENT_FAILED = 'attachment_failed';

/** How long a single attachment download may take. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * How many files one turn may carry.
 *
 * The byte caps bound what lands on disk; they do not bound how long the turn
 * waits. Downloads run in sequence with their own timeout, and the CLI has not
 * been spawned yet, so the request timeout is not running either — five
 * hundred attachments from a slow endpoint would hold the request open for
 * most of a day.
 */
const MAX_ATTACHMENTS = 50;

/** Caps on what one turn may pull onto the machine. */
export interface AttachmentLimits {
  /** Largest single file, in bytes. */
  maxFileBytes: number;
  /** Largest total across one request, in bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

/** An attachment that made it onto disk intact. */
export interface SavedAttachment {
  id: string;
  /** The sanitised, collision-free filename actually used. */
  name: string;
  /** Absolute path the model is told about. */
  path: string;
  mimeType: string;
  /** Actual bytes written, which by this point equals the declared size. */
  size: number;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An AbortSignal that fires when either the turn is cancelled or the download
 * takes too long.
 *
 * Built by hand rather than with `AbortSignal.any`, which landed in Node 20.3
 * while this package supports Node 20.0.
 */
function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Download one attachment, enforcing the size cap as the bytes arrive.
 *
 * The declared `size` is checked first so an oversized file is refused before
 * a single byte is pulled, and then again against what actually arrived —
 * because the declared size is the server's claim, and the cap has to hold
 * against a server that is wrong about it or lying.
 */
async function downloadOne(
  ref: AttachmentRef,
  destPath: string,
  token: () => string,
  expectedOrigin: string,
  remainingBytes: number,
  perFileCap: number,
  signal: AbortSignal,
): Promise<number> {
  const url = assertAllowedAttachmentUrl(ref.url, expectedOrigin);
  const cap = Math.min(perFileCap, remainingBytes);

  const { signal: fetchSignal, done } = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` },
      // A redirect is how the host binding above would otherwise be bypassed:
      // an allowed origin answering with a 302 to anywhere it likes. Refusing
      // to follow one keeps the check meaningful.
      redirect: 'error',
      signal: fetchSignal,
    });

    if (!response.ok) {
      throw new Error(`server returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('server returned an empty body');
    }

    const hash = createHash('sha256');
    const sink = createWriteStream(destPath, { mode: 0o600 });
    const reader = response.body.getReader();
    let written = 0;

    // One error listener for the whole download, latched into a variable.
    // Adding a fresh `once('error')` per backpressure pause is how a large
    // file ends up with a listener per chunk — Node warns about it at eleven,
    // and the listeners are never removed on the success path.
    let sinkError: Error | null = null;
    sink.on('error', (err: Error) => { sinkError = err; });
    const throwIfSinkFailed = (): void => {
      if (sinkError) throw sinkError;
    };

    try {
      for (;;) {
        throwIfSinkFailed();
        const { done: finished, value } = await reader.read();
        if (finished) break;
        written += value.byteLength;
        if (written > cap) {
          throw new RequestRefusal(
            ATTACHMENT_TOO_LARGE,
            `Attachment "${ref.name}" exceeded the ${humanBytes(cap)} limit while downloading.`,
          );
        }
        hash.update(value);
        if (!sink.write(value)) {
          // Raced against error and abort, never awaited bare. A write stream
          // that has failed (ENOSPC, quota) emits `error` and then never emits
          // `drain` — a bare await would park here forever, with no `done` and
          // no `error` ever reaching the server, and the provider timeout not
          // yet started because the CLI has not been spawned.
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err: Error) => { cleanup(); reject(err); };
            const onAbort = () => {
              cleanup();
              reject(new Error('download aborted'));
            };
            const cleanup = () => {
              sink.off('drain', onDrain);
              sink.off('error', onError);
              fetchSignal.removeEventListener('abort', onAbort);
            };
            sink.once('drain', onDrain);
            sink.once('error', onError);
            fetchSignal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
      await new Promise<void>((resolve) => sink.end(() => resolve()));
      throwIfSinkFailed();
    } catch (err) {
      sink.destroy();
      await reader.cancel().catch(() => undefined);
      throw err;
    }

    // Both halves are checked, and a mismatch fails the whole request loudly.
    // A half-downloaded PDF is, to the model, indistinguishable from a document
    // that is genuinely corrupt — so it would report the wrong problem with
    // total confidence.
    if (written !== ref.size) {
      throw new RequestRefusal(
        ATTACHMENT_FAILED,
        `Attachment "${ref.name}" is ${written} bytes but the server said ${ref.size}.`,
      );
    }
    const digest = hash.digest('hex');
    if (digest !== ref.sha256.toLowerCase()) {
      throw new RequestRefusal(
        ATTACHMENT_FAILED,
        `Attachment "${ref.name}" failed its checksum (expected ${ref.sha256}, got ${digest}).`,
      );
    }

    return written;
  } finally {
    done();
  }
}

/**
 * Fetch every attachment for a turn.
 *
 * @throws RequestRefusal — the turn does not run. The caller reports the code
 *         and removes the request's attachment directory.
 */
export async function fetchAttachments(opts: {
  attachments: AttachmentRef[];
  requestId: string;
  /**
   * Read at use time, not captured. Each download may take up to two minutes
   * and they run in sequence, so a token refresh part-way through a multi-file
   * turn would otherwise fail every remaining file on an opaque 401.
   */
  token: () => string;
  expectedOrigin: string;
  limits: AttachmentLimits;
  signal: AbortSignal;
}): Promise<SavedAttachment[]> {
  const { attachments, requestId, token, expectedOrigin, limits, signal } = opts;
  if (attachments.length === 0) {
    return [];
  }

  // Refuse on the declared sizes before touching the network, so an obviously
  // oversized request costs nothing.
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new RequestRefusal(
      ATTACHMENT_TOO_LARGE,
      `The turn carries ${attachments.length} attachments, over the ${MAX_ATTACHMENTS} per-request limit.`,
    );
  }

  const declaredTotal = attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
  if (declaredTotal > limits.maxTotalBytes) {
    throw new RequestRefusal(
      ATTACHMENT_TOO_LARGE,
      `The turn's attachments total ${humanBytes(declaredTotal)}, over the `
      + `${humanBytes(limits.maxTotalBytes)} per-request limit.`,
    );
  }
  for (const ref of attachments) {
    if (ref.size > limits.maxFileBytes) {
      throw new RequestRefusal(
        ATTACHMENT_TOO_LARGE,
        `Attachment "${ref.name}" is ${humanBytes(ref.size)}, over the `
        + `${humanBytes(limits.maxFileBytes)} per-file limit.`,
      );
    }
  }

  let dir: string;
  try {
    dir = ensureAttachmentDir(requestId);
  } catch (err) {
    // A local disk problem — ENOSPC, a permissions change on ~/.cache — is not
    // a lost CLI session. Raised as a refusal because a bare Error on a resumed
    // turn is translated into `session_lost`, which makes the server wipe a
    // perfectly good session and re-issue the turn, so a transient full disk
    // would cost the user their whole conversation.
    throw new RequestRefusal(
      ATTACHMENT_FAILED,
      `Could not create the attachment directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const taken = new Set<string>();
  const saved: SavedAttachment[] = [];
  let usedBytes = 0;

  for (const ref of attachments) {
    const name = disambiguate(sanitiseAttachmentName(ref.name, ref.id), taken);
    const destPath = join(dir, name);

    let written: number;
    try {
      written = await downloadOne(
        ref,
        destPath,
        token,
        expectedOrigin,
        limits.maxTotalBytes - usedBytes,
        limits.maxFileBytes,
        signal,
      );
    } catch (err) {
      if (err instanceof RequestRefusal) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // A URL the bridge will not touch is a different thing from a download
      // that went wrong, and the operator reading the log needs to tell them
      // apart: one is a misconfigured (or hostile) server, the other is a
      // network. Decided by the error's TYPE, not by matching its prose —
      // rewording a message must not silently reclassify a host-binding
      // refusal as a transient failure the server may then retry.
      const code = err instanceof AttachmentUrlError ? ATTACHMENT_REFUSED : ATTACHMENT_FAILED;
      throw new RequestRefusal(code, `Attachment "${ref.name}" could not be fetched: ${message}`);
    }

    usedBytes += written;
    saved.push({
      id: ref.id,
      name,
      path: destPath,
      mimeType: ref.mime_type,
      size: written,
    });
  }

  log.info('Attachments saved', {
    requestId,
    count: saved.length,
    bytes: usedBytes,
    dir,
  });

  return saved;
}

/**
 * The note prepended to the user's message telling the model what is on disk.
 *
 * Without it the files are present and invisible: nothing in the conversation
 * says they exist, so the model answers the question as if nothing had been
 * attached. Absolute paths, because the CLI's own file tools take paths and
 * the model should not have to guess at the working directory.
 */
export function buildAttachmentPreamble(saved: SavedAttachment[]): string {
  if (saved.length === 0) return '';

  const lines = saved.map(
    (a) => `- ${a.path} (${a.mimeType || 'unknown type'}, ${humanBytes(a.size)})`,
  );

  return [
    saved.length === 1
      ? 'The user attached a file. It has been saved on this machine at:'
      : `The user attached ${saved.length} files. They have been saved on this machine at:`,
    ...lines,
    '',
    'Read them from those paths when the request refers to them. They are outside '
    + 'the working directory and are deleted when this turn ends, so copy anything '
    + 'that needs to persist.',
    '',
  ].join('\n');
}
