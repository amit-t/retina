import { type Logger, type LoggerOptions, pino } from 'pino';

export type { Logger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface BuildLoggerOptions {
  /** Extra bindings attached to every log line (e.g. `{service: 'retina'}`). */
  base?: Record<string, unknown>;
}

/**
 * Build a pino JSON logger writing to stdout at the given level.
 *
 * The level is passed explicitly so the caller (R13 bootstrap) can wire it to
 * the validated `Config.LOG_LEVEL`. This module intentionally does not read
 * `process.env` so it stays testable.
 */
export function buildLogger(level: LogLevel, options: BuildLoggerOptions = {}): Logger {
  const opts: LoggerOptions = {
    level,
    // Default pino serializers handle `err` objects; we want ISO timestamps
    // for greppable logs.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
  if (options.base !== undefined) opts.base = options.base;
  return pino(opts);
}
