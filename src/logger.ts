// Pino-based JSON logger for Retina. Writes structured JSON records to
// stdout (fd 1) by default. The log level is supplied by the caller — R13 will
// wire it to the Zod-validated `Config.LOG_LEVEL`.
import pino, { type DestinationStream, type Level, type Logger } from 'pino';

export type LogLevel = Level;
export type { Logger };

/**
 * Create a pino JSON logger that writes to stdout.
 *
 * @param level - Minimum log level to emit (e.g. `'info'`, `'debug'`).
 * @param destination - Optional pino destination stream. Defaults to a
 *   `pino.destination(1)` (fd 1, stdout). Tests inject a capture stream
 *   (e.g. `node:stream` `PassThrough`) to assert JSON output without
 *   touching the real stdout.
 * @returns A configured pino `Logger` instance.
 */
export const buildLogger = (level: LogLevel, destination?: DestinationStream): Logger =>
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
    destination ?? pino.destination(1),
  );
