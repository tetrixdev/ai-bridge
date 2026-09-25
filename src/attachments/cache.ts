/**
 * Attachments that outlive the turn they arrived in.
 *
 * The per-turn directory is still what the assistant is given and still goes
 * when the turn ends — that part is unchanged. What this adds is a second name
 * for the same bytes, kept for a while: content-addressed on the `sha256` the
 * server already sends, so a file attached in three turns is downloaded once,
 * and a 200 MB dump the assistant wants to look at again does not cost another
 * trip over HTTPS.
 *
 * It is a cache and nothing more, and every decision here follows from that:
 *
 *   - A miss is an ordinary download. Nothing in this file may fail a turn;
 *     every error in it means "not cached", which is what makes eviction safe at
 *     any moment, including halfway through somebody else's lookup.
 *   - A hit is re-verified against the checksum before it is trusted. The entry
 *     and the per-turn file are one inode when the link succeeds, so an
 *     assistant that edited its copy in place has edited this one too. The check
 *     is what turns that from silent corruption into a re-download.
 *   - It has a real lifetime: unused files expire, the total is capped, and the
 *     oldest go first. `--keep-attachments` already exists for "never delete";
 *     unbounded retention on somebody's laptop is a worse bug than re-fetching.
 *
 * One store per install, never one per machine. Several bridges can run side by
 * side, one per server, and a store shared between them would hand a file one
 * server's user sent to a turn another server asked for. The hash is not
 * guessable, but "not guessable" is a weaker statement than "not shared", and
 * the saving from sharing across servers is close to nothing: the same file
 * rarely reaches one machine from two different applications.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, createReadStream, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nameFromServer, normaliseName } from '../service/naming.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Attachments');

/** How long, and how much, the store keeps. */
export interface AttachmentCacheSettings {
  /** How long a file may go unused before it expires. 0 turns the store off. */
  ttlMs: number;
  /** Cap on the store's total size. 0 turns the store off. */
  maxBytes: number;
}

/**
 * Three days and a gigabyte.
 *
 * Three days covers the conversation somebody comes back to after a weekend,
 * which is the case the store exists for; past that, re-downloading is the
 * right trade. A gigabyte is noticeable on nobody's laptop and still holds a
 * few database dumps. Both are per install, so a machine running two bridges
 * can hold twice that.
 */
export const DEFAULT_ATTACHMENT_CACHE: AttachmentCacheSettings = {
  ttlMs: 72 * 60 * 60 * 1000,
  maxBytes: 1024 * 1024 * 1024,
};

/** A half-written entry older than this is a crash's leftovers, not a write in progress. */
const STALE_TEMP_MS = 60 * 60 * 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Root of every install's store. Beside, not inside, the per-turn directories. */
export function attachmentCacheRoot(): string {
  return join(homedir(), '.cache', 'ai-bridge', 'attachment-cache');
}

/**
 * The directory name that keeps one install's store apart from another's.
 *
 * The install's name when the service recorded one, else the name `install`
 * would have given it — so a bridge run by hand against a server shares the
 * store of the service installed for that same server, and nothing else.
 *
 * A digest of the server (host and device) is appended however the name was
 * found, because a name alone does not pin the server: `install --force` can
 * point an existing name somewhere else, and that must not inherit the old
 * server's files.
 */
export function attachmentCacheScope(serverUrl: string, installName?: string): string {
  let host = serverUrl;
  let device = '';
  try {
    const url = new URL(serverUrl);
    host = url.host.toLowerCase();
    device = url.searchParams.get('device') ?? '';
  } catch {
    // Unparseable is still a string, and the digest of it is still distinct.
  }
  let name: string;
  try {
    name = installName ? normaliseName(installName) : nameFromServer(serverUrl);
  } catch {
    name = nameFromServer(serverUrl);
  }
  const digest = createHash('sha256').update(`${host}\n${device}`).digest('hex').slice(0, 12);
  return `${name}-${digest}`;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export class AttachmentCache {
  /**
   * @param dir       This install's store. `null` is a store that holds nothing.
   * @param link      Test seam for a filesystem that refuses hard links.
   */
  constructor(
    readonly dir: string | null,
    readonly settings: AttachmentCacheSettings,
    private readonly link: (from: string, to: string) => void = linkSync,
  ) {}

  /** A store that never hits and never keeps anything. */
  static disabled(): AttachmentCache {
    return new AttachmentCache(null, { ttlMs: 0, maxBytes: 0 });
  }

  get enabled(): boolean {
    return this.dir !== null && this.settings.ttlMs > 0 && this.settings.maxBytes > 0;
  }

  /** The entry for a digest, or null when the digest is not one. It came from a server and is about to be joined onto a path. */
  private entryFor(sha256: string): string | null {
    const digest = sha256.toLowerCase();
    if (!this.dir || !SHA256_HEX.test(digest)) return null;
    return join(this.dir, digest);
  }

  /**
   * Put a verified copy of a cached file at `destPath`.
   *
   * Returns false on any miss — absent, expired, the wrong size, a checksum that
   * no longer matches, or a filesystem that would not cooperate — and the caller
   * downloads as it always did. Never throws.
   */
  async take(sha256: string, size: number, destPath: string): Promise<boolean> {
    if (!this.enabled) return false;
    const entry = this.entryFor(sha256);
    if (!entry) return false;

    try {
      const stat = statSync(entry, { throwIfNoEntry: false });
      if (!stat) return false;
      if (stat.size !== size || Date.now() - stat.mtimeMs > this.settings.ttlMs) {
        rmSync(entry, { force: true });
        return false;
      }

      // Cleared first: a link onto an existing name fails, and a copy onto a
      // name that is ALREADY this inode would truncate the entry it is reading.
      rmSync(destPath, { force: true });
      if (!this.linkOrCopy(entry, destPath)) return false;

      // Verified where the assistant will read it, after the link, so there is
      // no window between checking one file and handing over another.
      const digest = await sha256Of(destPath);
      if (digest !== sha256.toLowerCase()) {
        log.warn('Cached attachment failed its checksum; downloading it again', { sha256 });
        rmSync(destPath, { force: true });
        rmSync(entry, { force: true });
        return false;
      }

      // Last use, not first download, is what "oldest" means for eviction.
      const now = new Date();
      utimesSync(entry, now, now);
      return true;
    } catch (err) {
      log.debug('Attachment cache lookup failed; downloading instead', {
        error: err instanceof Error ? err.message : String(err),
      });
      rmSync(destPath, { force: true });
      return false;
    }
  }

  /**
   * Keep a freshly downloaded, verified file for later turns. Best-effort: a
   * failure here costs a future download and nothing else.
   */
  put(sha256: string, size: number, fromPath: string): void {
    if (!this.enabled || !this.dir) return;
    const entry = this.entryFor(sha256);
    // A file bigger than the whole store would be evicted by the next sweep;
    // not worth the link.
    if (!entry || size > this.settings.maxBytes) return;

    const temp = join(this.dir, `.${sha256.toLowerCase()}.${randomBytes(6).toString('hex')}`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (statSync(entry, { throwIfNoEntry: false })) {
        const now = new Date();
        utimesSync(entry, now, now);
        return;
      }
      // Written under a temporary name and renamed into place, so a concurrent
      // lookup sees a whole entry or none.
      if (!this.linkOrCopy(fromPath, temp)) return;
      renameSync(temp, entry);
    } catch (err) {
      log.debug('Could not keep attachment for later turns', {
        error: err instanceof Error ? err.message : String(err),
      });
      rmSync(temp, { force: true });
    }
  }

  /**
   * Expire what has gone unused past the TTL, then evict the least recently
   * used until the store fits its cap. A store that has been turned off is
   * emptied, so switching it off does not leave the files it had behind for
   * ever.
   */
  sweep(now = Date.now()): { removed: number; bytes: number } {
    if (!this.dir) return { removed: 0, bytes: 0 };
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { removed: 0, bytes: 0 };
    }

    const live: { path: string; size: number; used: number }[] = [];
    let removed = 0;
    const drop = (path: string): void => {
      try {
        rmSync(path, { force: true });
        removed++;
      } catch {
        // Somebody else's sweep got there first, or it is in use on Windows.
      }
    };

    for (const name of names) {
      const path = join(this.dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      if (name.startsWith('.')) {
        if (now - stat.mtimeMs > STALE_TEMP_MS) drop(path);
        continue;
      }
      if (!this.enabled || !SHA256_HEX.test(name) || now - stat.mtimeMs > this.settings.ttlMs) {
        drop(path);
        continue;
      }
      live.push({ path, size: stat.size, used: stat.mtimeMs });
    }

    live.sort((a, b) => a.used - b.used);
    let bytes = live.reduce((sum, f) => sum + f.size, 0);
    for (const file of live) {
      if (bytes <= this.settings.maxBytes) break;
      drop(file.path);
      bytes -= file.size;
    }

    if (removed > 0) {
      log.debug('Attachment cache swept', { removed, bytes });
    }
    return { removed, bytes };
  }

  /**
   * A hard link where the filesystem allows one, a copy where it does not.
   *
   * The link is the point — no second copy on disk, and nothing to copy — but it
   * fails across filesystems, on some network mounts and on FAT, and the cache
   * must keep working there, just less cheaply.
   */
  private linkOrCopy(from: string, to: string): boolean {
    try {
      this.link(from, to);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      copyFileSync(from, to);
      return true;
    }
  }
}
