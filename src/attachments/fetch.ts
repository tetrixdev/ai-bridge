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
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentRef } from '../protocol/types.js';
import { RequestRefusal } from '../errors.js';
import { AttachmentCache } from './cache.js';
import { assertAllowedAttachmentUrl, AttachmentUrlError } from './origin.js';
import { disambiguate, ensureAttachmentDir, sanitiseAttachmentName } from './store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Attachments');

/** Refusal codes this module emits. */
export const ATTACHMENT_REFUSED = 'attachment_refused';
export const ATTACHMENT_TOO_LARGE = 'attachment_too_large';
export const ATTACHMENT_FAILED = 'attachment_failed';

/**
 * How many files one turn may carry, unless the operator says otherwise.
 *
 * The byte caps bound what lands on disk; they do not bound how long the turn
 * waits. Downloads run in sequence, and the CLI has not been spawned yet, so
 * the request timeout is not running either — five hundred attachments from a
 * slow endpoint would hold the request open for most of a day.
 */
export const DEFAULT_MAX_ATTACHMENTS = 50;

/** Caps on what one turn may pull onto the machine. Reported to the server in `hello`. */
export interface AttachmentLimits {
  /** Largest single file, in bytes. */
  maxFileBytes: number;
  /** Largest total across one request, in bytes. */
  maxTotalBytes: number;
  /** Most files one request may carry. */
  maxCount: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCount: DEFAULT_MAX_ATTACHMENTS,
};

/**
 * When a download is given up on.
 *
 * Two clocks, because they catch different things. A fixed total duration —
 * which is what this used to be, two minutes per file — cannot tell a slow link
 * from a dead one: it refuses a large file that was arriving perfectly well,
 * and it makes whoever is waiting sit out the full two minutes on a connection
 * that died in the first second. Whatever the size cap said, the timeout was
 * the real ceiling.
 *
 * So the working clock is a stall timer: a download that keeps moving is
 * healthy however long it takes, and one that has moved nothing for a minute is
 * not. The overall ceiling stays, set high, for the pathological server that
 * trickles a byte just often enough to never stall.
 */
export interface AttachmentTimeouts {
  /** Longest wait for the next bytes — including the first — before giving up. */
  stallMs: number;
  /** Longest a single file may take in total, however steadily it arrives. */
  ceilingMs: number;
}

/**
 * A minute without a byte, an hour in total.
 *
 * A minute rides out a laptop changing networks or a server warming a file up
 * from object storage; nothing that has been silent that long is coming back.
 * An hour is the default per-file cap (25 MB) at well under a megabit, and
 * still a gigabyte at a few megabits; an operator who raises the size caps
 * into gigabytes should raise this with them.
 */
export const DEFAULT_ATTACHMENT_TIMEOUTS: AttachmentTimeouts = {
  stallMs: 60_000,
  ceilingMs: 60 * 60_000,
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

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An AbortSignal that fires when the turn is cancelled, when the download has
 * made no progress for `stallMs`, or when it has run past `ceilingMs`.
 *
 * `progress()` re-arms the stall clock; `expired` says which clock fired, so
 * the refusal can name it instead of reporting a generic abort.
 *
 * Built by hand rather than with `AbortSignal.any`, which landed in Node 20.3
 * while this package supports Node 20.0.
 */
export function downloadClock(
  signal: AbortSignal,
  timeouts: AttachmentTimeouts,
): { signal: AbortSignal; progress: () => void; expired: () => string | null; done: () => void } {
  const controller = new AbortController();
  let expired: string | null = null;
  const expire = (why: string): void => {
    expired = why;
    controller.abort(new Error(why));
  };
  const onAbort = () => controller.abort(signal.reason);

  let stall = setTimeout(() => expire(`no data for ${formatDuration(timeouts.stallMs)}`), timeouts.stallMs);
  const ceiling = setTimeout(
    () => expire(`still downloading after ${formatDuration(timeouts.ceilingMs)}`),
    timeouts.ceilingMs,
  );

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    progress: () => {
      if (controller.signal.aborted) return;
      clearTimeout(stall);
      stall = setTimeout(() => expire(`no data for ${formatDuration(timeouts.stallMs)}`), timeouts.stallMs);
    },
    expired: () => expired,
    done: () => {
      clearTimeout(stall);
      clearTimeout(ceiling);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)} min`;
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
  timeouts: AttachmentTimeouts,
  signal: AbortSignal,
): Promise<number> {
  const url = assertAllowedAttachmentUrl(ref.url, expectedOrigin);
  const cap = Math.min(perFileCap, remainingBytes);

  const clock = downloadClock(signal, timeouts);
  const fetchSignal = clock.signal;
  let written = 0;
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
    // Unlinked first rather than truncated: a name left over from an earlier
    // attempt at this request may be a hard link into the attachment cache,
    // and truncating it would empty the cached copy along with it.
    rmSync(destPath, { force: true });
    const sink = createWriteStream(destPath, { mode: 0o600 });
    const reader = response.body.getReader();

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
        clock.progress();
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
          // A slow disk is not a stalled server; the wait for it does not count.
          clock.progress();
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
  } catch (err) {
    // Which clock ran out, and how far it got. "Aborted" says nothing; "no data
    // for 60s after 180 MB of 200 MB" says whether to retry or to call IT.
    const why = clock.expired();
    if (why !== null && !(err instanceof RequestRefusal)) {
      throw new Error(`${why} (${humanBytes(written)} of ${humanBytes(ref.size)} received)`);
    }
    throw err;
  } finally {
    clock.done();
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
  /** Operator asked to keep the files after the turn (--keep-attachments). */
  keep?: boolean;
  /**
   * Read at use time, not captured. Downloads can run for a long time and they
   * run in sequence, so a token refresh part-way through a multi-file turn
   * would otherwise fail every remaining file on an opaque 401.
   */
  token: () => string;
  expectedOrigin: string;
  limits: AttachmentLimits;
  timeouts?: AttachmentTimeouts;
  /** Files kept from earlier turns. Absent is a store that never hits. */
  cache?: AttachmentCache;
  signal: AbortSignal;
}): Promise<SavedAttachment[]> {
  const {
    attachments, requestId, token, expectedOrigin, limits, signal, keep = false,
    timeouts = DEFAULT_ATTACHMENT_TIMEOUTS, cache = AttachmentCache.disabled(),
  } = opts;
  if (attachments.length === 0) {
    return [];
  }

  // Refuse on the declared sizes before touching the network, so an obviously
  // oversized request costs nothing.
  if (attachments.length > limits.maxCount) {
    throw new RequestRefusal(
      ATTACHMENT_TOO_LARGE,
      `The turn carries ${attachments.length} attachments, over the ${limits.maxCount} per-request limit.`,
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
    dir = ensureAttachmentDir(requestId, keep);
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
  let reused = 0;

  for (const ref of attachments) {
    const name = disambiguate(sanitiseAttachmentName(ref.name, ref.id), taken);
    const destPath = join(dir, name);

    // A copy kept from an earlier turn, verified against this turn's checksum,
    // stands in for the download. The declared size already passed the caps
    // above, and a hit is exactly that size, so it is counted the same way.
    if (await cache.take(ref.sha256, ref.size, destPath)) {
      reused++;
      usedBytes += ref.size;
      saved.push({ id: ref.id, name, path: destPath, mimeType: ref.mime_type, size: ref.size });
      continue;
    }

    let written: number;
    try {
      written = await downloadOne(
        ref,
        destPath,
        token,
        expectedOrigin,
        limits.maxTotalBytes - usedBytes,
        limits.maxFileBytes,
        timeouts,
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

    cache.put(ref.sha256, written, destPath);
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
    reused,
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
export function buildAttachmentPreamble(
  saved: SavedAttachment[],
  opts: { cached?: boolean } = {},
): string {
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
    // One line, only when it is true. Without it the assistant treats a file
    // from an earlier turn as lost for good, and asks again for something the
    // machine may well still have.
    ...(opts.cached
      ? ['A file attached in an earlier turn may still be on this machine: attached again, it is '
        + 'reused from there instead of downloaded, and fetched again if it is gone.']
      : []),
    '',
  ].join('\n');
}
