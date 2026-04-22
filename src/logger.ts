// JSON logger used across the service.
//
// Thin wrapper around pino that:
//   - emits JSON to stdout
//   - takes a level parameter so the bootstrap in R13 can feed it from config
//   - exposes a `Logger` type alias we re-use in deps signatures so middleware
//     and workers don't depend on pino directly
//
// Keep this file tiny. Real transport/redaction configuration lands alongside
// the bootstrap in R13.

import { type LevelWithSilent, type Logger as PinoLogger, pino } from 'pino';

export type Logger = PinoLogger;

export function buildLogger(level: LevelWithSilent = 'info'): Logger {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
