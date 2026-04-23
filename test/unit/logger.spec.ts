import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildLogger, type LogLevel } from '../../src/logger.js';

/**
 * Collect every chunk pino writes to `stream` into a single joined string.
 * Used by the JSON-output tests below to assert the emitted NDJSON.
 */
const capture = (stream: PassThrough): { lines: () => string[]; text: () => string } => {
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0),
  };
};

/** Let pino's next-tick flush drain before assertions. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('buildLogger', () => {
  it('returns a logger whose level matches the requested level', () => {
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      const logger = buildLogger(level);
      expect(logger.level).toBe(level);
    }
  });

  it('exposes the standard pino logging methods', () => {
    const logger = buildLogger('info');
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      expect(typeof logger[method]).toBe('function');
    }
  });

  it('produces independent logger instances per call', () => {
    const a = buildLogger('info');
    const b = buildLogger('debug');
    expect(a).not.toBe(b);
    expect(a.level).toBe('info');
    expect(b.level).toBe('debug');
  });

  it('emits JSON with level label, message, and iso timestamp', async () => {
    const stream = new PassThrough();
    const sink = capture(stream);
    const logger = buildLogger('info', stream);

    logger.info({ foo: 'bar' }, 'hello');
    await flush();

    const [line, ...rest] = sink.lines();
    expect(rest).toHaveLength(0);
    expect(line).toBeDefined();
    const record = JSON.parse(line as string);
    expect(record.level).toBe('info');
    expect(record.msg).toBe('hello');
    expect(record.foo).toBe('bar');
    // `pino.stdTimeFunctions.isoTime` → ISO 8601 string, not epoch ms.
    expect(typeof record.time).toBe('string');
    expect(() => new Date(record.time).toISOString()).not.toThrow();
  });

  it('suppresses records below the configured level', async () => {
    const stream = new PassThrough();
    const sink = capture(stream);
    const logger = buildLogger('info', stream);

    logger.trace('trace-hidden');
    logger.debug('debug-hidden');
    logger.info('info-visible');
    logger.warn('warn-visible');
    logger.error('error-visible');
    await flush();

    const output = sink.text();
    expect(output).not.toContain('"msg":"trace-hidden"');
    expect(output).not.toContain('"msg":"debug-hidden"');
    expect(output).toContain('"msg":"info-visible"');
    expect(output).toContain('"msg":"warn-visible"');
    expect(output).toContain('"msg":"error-visible"');
  });

  it('includes debug records when level is debug', async () => {
    const stream = new PassThrough();
    const sink = capture(stream);
    const logger = buildLogger('debug', stream);

    logger.debug('debug-visible');
    logger.info('info-visible');
    await flush();

    const output = sink.text();
    expect(output).toContain('"msg":"debug-visible"');
    expect(output).toContain('"msg":"info-visible"');
  });

  it('writes one JSON record per line (NDJSON)', async () => {
    const stream = new PassThrough();
    const sink = capture(stream);
    const logger = buildLogger('info', stream);

    logger.info('first');
    logger.info('second');
    logger.info('third');
    await flush();

    const lines = sink.lines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // Every emitted line must be standalone JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
