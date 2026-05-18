/**
 * Structured logger for the AI Bridge.
 *
 * Supports debug / info / warn / error levels.
 * Debug output is suppressed unless `setDebug(true)` is called (via --debug flag).
 *
 * Output always goes to stderr. When a log file is configured (via
 * `setLogFile`, backing the CLI's --log-file flag) every line is also appended
 * there, so a bridge run launched in a terminal leaves a durable record to
 * diagnose against after the terminal is gone.
 */

import { closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

let currentLevel: LogLevel = 'info';

/** Enable or disable debug-level output. */
export function setDebug(enabled: boolean): void {
  currentLevel = enabled ? 'debug' : 'info';
}

/** Returns true if debug logging is currently enabled. */
export function isDebugEnabled(): boolean {
  return currentLevel === 'debug';
}

// ── optional file output ───────────────────────────────────────────────────

/** Rotate the log file once it grows past this size, keeping one old copy. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let fileFd: number | null = null;

/**
 * Tee log output to a file, in addition to stderr.
 *
 * Writes go through synchronous `writeSync` rather than a WriteStream: the
 * bridge logs key events immediately before `process.exit()` (failed startup,
 * fatal errors), and a stream's buffered writes would be lost when the process
 * exits. A logger is low-volume, so synchronous appends cost nothing.
 *
 * Bounded retention without a full rotation library: if the target file is
 * already larger than MAX_LOG_BYTES it is renamed to `<path>.1` (overwriting
 * any previous `.1`) before a fresh file is opened — so the bridge keeps at
 * most ~10 MB of logs and can never fill the disk on a long run.
 *
 * Pass an empty/undefined path to disable file logging. A path that cannot be
 * opened is reported once on stderr and otherwise ignored — file logging must
 * never take the bridge down.
 */
export function setLogFile(path: string | undefined | null): void {
  closeLogFile();
  if (!path) return;

  try {
    try {
      if (statSync(path).size > MAX_LOG_BYTES) {
        renameSync(path, path + '.1');
      }
    } catch {
      // File does not exist yet (or cannot be stat'd) — nothing to rotate.
    }
    fileFd = openSync(path, 'a');
  } catch (err) {
    process.stderr.write(
      `${formatTimestamp()} [WRN] [Logger] could not open log file ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    fileFd = null;
  }
}

/** Close the log file, if one is open. Call before process exit. */
export function closeLogFile(): void {
  if (fileFd !== null) {
    try {
      closeSync(fileFd);
    } catch {
      // Already closed / invalid descriptor — nothing actionable.
    }
    fileFd = null;
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>): string {
  const ts = formatTimestamp();
  const label = LEVEL_LABEL[level];
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${label}] [${component}] ${message}${metaStr}`;
}

/**
 * Write a formatted log line to stderr and, when configured, the log file.
 * Both sinks share the same level threshold.
 */
function emit(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const line = formatMessage(level, component, message, meta) + '\n';
  process.stderr.write(line);
  if (fileFd !== null) {
    try {
      writeSync(fileFd, line);
    } catch {
      // A failed file write must never break logging to stderr.
    }
  }
}

/**
 * Create a scoped logger for a specific component.
 *
 * ```ts
 * const log = createLogger('Bridge');
 * log.info('Connected', { url: 'wss://...' });
 * ```
 */
export function createLogger(component: string) {
  return {
    debug(message: string, meta?: Record<string, unknown>): void {
      emit('debug', component, message, meta);
    },

    info(message: string, meta?: Record<string, unknown>): void {
      emit('info', component, message, meta);
    },

    warn(message: string, meta?: Record<string, unknown>): void {
      emit('warn', component, message, meta);
    },

    error(message: string, meta?: Record<string, unknown>): void {
      emit('error', component, message, meta);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
