// Shared helpers for unit tests.

import { pino } from 'pino';
import type { Logger } from '../../src/logger.js';

// Silent logger so tests don't spam stdout. We still get a real pino instance
// (so method surfaces match production) but nothing is written.
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
