import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel } from '../../src/logger.js';

describe('createLogger', () => {
  it('returns a logger whose level matches the requested level', () => {
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      const logger = createLogger(level);
      expect(logger.level).toBe(level);
    }
  });

  it('exposes the standard pino logging methods', () => {
    const logger = createLogger('info');
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      expect(typeof logger[method]).toBe('function');
    }
  });

  it('produces independent logger instances per call', () => {
    const a = createLogger('info');
    const b = createLogger('debug');
    expect(a).not.toBe(b);
    expect(a.level).toBe('info');
    expect(b.level).toBe('debug');
  });
});
