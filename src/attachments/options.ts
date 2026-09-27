/**
 * The operator's attachment settings: one table for the flag, the environment
 * variable and the key in an installed service's env file.
 *
 * One table because the three used to be written separately, and drifted. The
 * size caps had a flag and no environment variable, so a machine whose setup
 * wrote `AI_BRIDGE_ATTACHMENT_MAX_MB` into the service's env file ran with the
 * default and nothing said so. Every setting listed here reaches the bridge
 * the same three ways, and survives `ai-bridge install`, because they are all
 * generated from this list.
 */

import { join } from 'node:path';
import {
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_ATTACHMENT_TIMEOUTS,
  type AttachmentLimits,
  type AttachmentTimeouts,
} from './fetch.js';
import {
  attachmentCacheRoot,
  attachmentCacheScope,
  DEFAULT_ATTACHMENT_CACHE,
  type AttachmentCacheSettings,
} from './cache.js';

export interface AttachmentOptionValues {
  attachmentMaxMb?: string | undefined;
  attachmentTotalMb?: string | undefined;
  attachmentMaxCount?: string | undefined;
  attachmentStallSeconds?: string | undefined;
  attachmentTimeoutMinutes?: string | undefined;
  attachmentCacheTtlHours?: string | undefined;
  attachmentCacheMaxMb?: string | undefined;
}

export interface AttachmentOption {
  /** Commander flag spelling, with its argument. */
  flag: string;
  /** Commander's camel-cased key for the flag. */
  key: keyof AttachmentOptionValues;
  /** Environment variable, and the key in an install's env file. */
  env: string;
  description: string;
}

const MB = 1024 * 1024;

export const ATTACHMENT_OPTIONS: readonly AttachmentOption[] = [
  {
    flag: '--attachment-max-mb <n>', key: 'attachmentMaxMb', env: 'AI_BRIDGE_ATTACHMENT_MAX_MB',
    description: `Largest single attachment the bridge will download, in MB (default ${DEFAULT_ATTACHMENT_LIMITS.maxFileBytes / MB}).`,
  },
  {
    flag: '--attachment-total-mb <n>', key: 'attachmentTotalMb', env: 'AI_BRIDGE_ATTACHMENT_TOTAL_MB',
    description: `Largest total of attachments per request, in MB (default ${DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes / MB}).`,
  },
  {
    flag: '--attachment-max-count <n>', key: 'attachmentMaxCount', env: 'AI_BRIDGE_ATTACHMENT_MAX_COUNT',
    description: `Most attachments one request may carry (default ${DEFAULT_ATTACHMENT_LIMITS.maxCount}).`,
  },
  {
    flag: '--attachment-stall-seconds <n>', key: 'attachmentStallSeconds', env: 'AI_BRIDGE_ATTACHMENT_STALL_SECONDS',
    description: 'Give up on an attachment download that has received nothing for this long, in seconds '
      + `(default ${DEFAULT_ATTACHMENT_TIMEOUTS.stallMs / 1000}). A download that keeps moving is never cut off by this.`,
  },
  {
    flag: '--attachment-timeout-minutes <n>', key: 'attachmentTimeoutMinutes', env: 'AI_BRIDGE_ATTACHMENT_TIMEOUT_MINUTES',
    description: 'Longest a single attachment download may take in total, however steadily it arrives, in minutes '
      + `(default ${DEFAULT_ATTACHMENT_TIMEOUTS.ceilingMs / 60_000}).`,
  },
  {
    flag: '--attachment-cache-ttl-hours <n>', key: 'attachmentCacheTtlHours', env: 'AI_BRIDGE_ATTACHMENT_CACHE_TTL_HOURS',
    description: 'Keep a downloaded attachment for later turns until it has gone unused this long, in hours '
      + `(default ${DEFAULT_ATTACHMENT_CACHE.ttlMs / 3_600_000}). 0 turns the cache off.`,
  },
  {
    flag: '--attachment-cache-max-mb <n>', key: 'attachmentCacheMaxMb', env: 'AI_BRIDGE_ATTACHMENT_CACHE_MAX_MB',
    description: 'Cap on the attachments kept for later turns, in MB; the least recently used go first '
      + `(default ${DEFAULT_ATTACHMENT_CACHE.maxBytes / MB}). 0 turns the cache off.`,
  },
];

/** Every environment variable in the table: what an install's env file may carry. */
export const ATTACHMENT_ENV_KEYS: readonly string[] = ATTACHMENT_OPTIONS.map((o) => o.env);

/**
 * A number the operator typed, held to what the setting can mean.
 *
 * Throws rather than falling back to a default: a mistyped cap that silently
 * becomes 25 MB is one nobody notices until a large attachment is refused for
 * reasons that make no sense.
 */
function parseSetting(
  raw: string,
  flag: string,
  unit: string,
  opts: { zeroAllowed?: boolean; integer?: boolean } = {},
): number {
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  const floor = opts.zeroAllowed ? value >= 0 : value > 0;
  if (!Number.isFinite(value) || !floor || (opts.integer && !Number.isInteger(value))) {
    const shape = opts.integer ? 'whole number' : 'number';
    const sign = opts.zeroAllowed ? 'zero or a positive' : 'a positive';
    throw new Error(`${flag.split(' ')[0]} must be ${sign} ${shape} of ${unit} (got "${raw}")`);
  }
  return value;
}

function flagFor(key: keyof AttachmentOptionValues): string {
  return ATTACHMENT_OPTIONS.find((o) => o.key === key)!.flag;
}

/**
 * Check every value that is set, without resolving anything else.
 *
 * What `ai-bridge install` calls before writing a value into a service: a typo
 * found then is a message on the screen of the person typing, and the same typo
 * found when the service starts is a unit that restarts every five seconds
 * with the reason in a journal nobody is reading.
 *
 * @throws Error naming the flag.
 */
export function validateAttachmentOptions(values: AttachmentOptionValues): void {
  resolveAttachmentSettings(values, 'wss://validation.invalid/');
}

export interface ResolvedAttachmentSettings {
  limits: AttachmentLimits;
  timeouts: AttachmentTimeouts;
  cache: AttachmentCacheSettings & { dir: string };
  /** Where the record of files this bridge will hand back lives (attachments/served.ts).
   *  Scoped like the cache: per installation and server, never shared. */
  servedFilesPath: string;
}

/**
 * Turn the operator's values — flag, environment or env file, whichever won —
 * into what the bridge runs with. Unset means the default.
 *
 * @param installName  The name the service was installed under, when it was;
 *                     it decides whose attachment store this bridge uses.
 * @throws Error naming the flag, when a value is unusable.
 */
export function resolveAttachmentSettings(
  values: AttachmentOptionValues,
  serverUrl: string,
  installName?: string,
): ResolvedAttachmentSettings {
  const read = (
    key: keyof AttachmentOptionValues,
    unit: string,
    scale: number,
    fallback: number,
    opts: { zeroAllowed?: boolean; integer?: boolean } = {},
  ): number => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    return Math.floor(parseSetting(raw, flagFor(key), unit, opts) * scale);
  };

  return {
    limits: {
      maxFileBytes: read('attachmentMaxMb', 'megabytes', MB, DEFAULT_ATTACHMENT_LIMITS.maxFileBytes),
      maxTotalBytes: read('attachmentTotalMb', 'megabytes', MB, DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes),
      maxCount: read('attachmentMaxCount', 'attachments', 1, DEFAULT_ATTACHMENT_LIMITS.maxCount, { integer: true }),
    },
    timeouts: {
      stallMs: read('attachmentStallSeconds', 'seconds', 1000, DEFAULT_ATTACHMENT_TIMEOUTS.stallMs),
      ceilingMs: read('attachmentTimeoutMinutes', 'minutes', 60_000, DEFAULT_ATTACHMENT_TIMEOUTS.ceilingMs),
    },
    cache: {
      dir: join(attachmentCacheRoot(), attachmentCacheScope(serverUrl, installName)),
      ttlMs: read('attachmentCacheTtlHours', 'hours', 3_600_000, DEFAULT_ATTACHMENT_CACHE.ttlMs, { zeroAllowed: true }),
      maxBytes: read('attachmentCacheMaxMb', 'megabytes', MB, DEFAULT_ATTACHMENT_CACHE.maxBytes, { zeroAllowed: true }),
    },
    servedFilesPath: join(attachmentCacheRoot(), '..', 'served-files', `${attachmentCacheScope(serverUrl, installName)}.json`),
  };
}
