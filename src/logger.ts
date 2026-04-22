// Pino-based JSON logger for Retina. Writes structured JSON records to
// stdout (fd 1). The log level is supplied by the caller — R13 will wire it
// to the Zod-validated `Config.LOG_LEVEL`.
import pino, { type Level, type Logger } from 'pino';

export type LogLevel = Level;
export type { Logger };

/**
 * Create a pino JSON logger that writes to stdout.
 *
 * @param level - Minimum log level to emit (e.g. `'info'`, `'debug'`).
 * @returns A configured pino `Logger` instance.
 */
export const createLogger = (level: LogLevel): Logger =>
  pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        // Emit `"level":"info"` instead of pino's default numeric level so
        // downstream log shippers don't need a level-name lookup table.
        level: (label) => ({ level: label }),
      },
    },
    pino.destination(1),
  );
