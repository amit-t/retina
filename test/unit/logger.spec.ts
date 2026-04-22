import { describe, expect, it } from 'vitest';
import { buildLogger } from '../../src/logger.js';

describe('buildLogger', () => {
  it('creates a logger at the requested level', () => {
    const logger = buildLogger('warn');
    expect(logger.level).toBe('warn');
  });

  it('supports child loggers with bound context', () => {
    const logger = buildLogger('info');
    const child = logger.child({ requestId: 'req-1' });
    expect(child.level).toBe('info');
  });

  it('honors base bindings when provided', () => {
    const logger = buildLogger('debug', { base: { service: 'retina' } });
    expect(logger.level).toBe('debug');
  });
});
