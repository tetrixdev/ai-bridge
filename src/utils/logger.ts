/**
 * Structured logger for the AI Bridge.
 *
 * Supports debug / info / warn / error levels.
 * Debug output is suppressed unless `setDebug(true)` is called (via --debug flag).
 */

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

/** Returns the current minimum log level. */
export function getLevel(): LogLevel {
  return currentLevel;
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
  return `${ts} [${label}] [${component}]${metaStr} ${message}`;
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
      if (shouldLog('debug')) {
        process.stderr.write(formatMessage('debug', component, message, meta) + '\n');
      }
    },

    info(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('info')) {
        process.stderr.write(formatMessage('info', component, message, meta) + '\n');
      }
    },

    warn(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('warn')) {
        process.stderr.write(formatMessage('warn', component, message, meta) + '\n');
      }
    },

    error(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('error')) {
        process.stderr.write(formatMessage('error', component, message, meta) + '\n');
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
