// Thin wrapper around pino so the rest of the app does not import pino
// directly and test code can swap in a no-op logger.
//
// Real wiring (level from config) lives in R13 (`src/index.ts`).

import { type Level, type Logger, type LoggerOptions, pino } from 'pino';

export type { Logger } from 'pino';

export type LogLevel = Level;

export function buildLogger(level: LogLevel = 'info', extra: LoggerOptions = {}): Logger {
  return pino({
    level,
    // JSON to stdout — no pretty transport so production logs stay
    // machine-parseable. Dev ergonomics come from piping through `pino-pretty`
    // at the shell.
    ...extra,
  });
}
