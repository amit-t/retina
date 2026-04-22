import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InternalError, RetinaError } from '../../../../src/core/errors';
import {
  createErrorHandler,
  type ErrorMiddlewareLogger,
} from '../../../../src/http/middleware/error';

function createLogger(): ErrorMiddlewareLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildApp(opts: {
  logger: ErrorMiddlewareLogger;
  throwFn: () => Promise<unknown> | unknown;
  attachRequestId?: string;
}) {
  const app = new Hono();
  if (opts.attachRequestId !== undefined) {
    const { attachRequestId } = opts;
    app.use('*', async (c, next) => {
      c.set('requestId', attachRequestId);
      await next();
    });
  }
  app.get('/boom', async () => {
    await opts.throwFn();
    return new Response('unreachable');
  });
  app.onError(createErrorHandler({ logger: opts.logger }));
  return app;
}

describe('createErrorHandler', () => {
  describe('RetinaError', () => {
    it('maps a RetinaError to the envelope with the error status code', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('invalid_request', 400, 'bad body');
        },
        attachRequestId: 'req-123',
      });

      const res = await app.request('/boom');

      expect(res.status).toBe(400);
      expect(res.headers.get('x-request-id')).toBe('req-123');
      await expect(res.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'bad body',
          requestId: 'req-123',
        },
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('includes details when the RetinaError carries them', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('provider_failed', 502, 'all providers exhausted', {
            details: {
              attempts: [{ provider: 'openai', model: 'gpt-4o', code: '500', message: 'boom' }],
            },
          });
        },
        attachRequestId: 'req-provider',
      });

      const res = await app.request('/boom');

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { details?: unknown } };
      expect(body.error.details).toEqual({
        attempts: [{ provider: 'openai', model: 'gpt-4o', code: '500', message: 'boom' }],
      });
    });

    it('omits details when the RetinaError has none', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('job_not_found', 404, 'missing');
        },
        attachRequestId: 'req-nd',
      });

      const res = await app.request('/boom');
      const body = (await res.json()) as Record<string, unknown> & {
        error: Record<string, unknown>;
      };
      expect('details' in body.error).toBe(false);
    });

    it('honours subclasses of RetinaError', async () => {
      const logger = createLogger();
      class ImageTooLargeError extends RetinaError {
        constructor() {
          super('image_too_large', 413, 'too big');
        }
      }
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new ImageTooLargeError();
        },
        attachRequestId: 'req-large',
      });

      const res = await app.request('/boom');
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('image_too_large');
    });

    it('logs RetinaError at warn (not error)', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('invalid_request', 400, 'nope');
        },
        attachRequestId: 'req-log',
      });

      await app.request('/boom');

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [payload, label] = logger.warn.mock.calls[0] ?? [];
      expect(label).toBe('retina_error');
      expect(payload).toMatchObject({
        requestId: 'req-log',
        code: 'invalid_request',
        status: 400,
      });
    });
  });

  describe('unknown errors', () => {
    it('wraps non-RetinaError throws in InternalError 500', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new Error('kaboom');
        },
        attachRequestId: 'req-unk',
      });

      const res = await app.request('/boom');
      expect(res.status).toBe(500);
      expect(res.headers.get('x-request-id')).toBe('req-unk');
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('internal_error');
      expect(body.error.message).toBe('Internal server error');
    });

    it('logs unknown errors at error with the stack', async () => {
      const logger = createLogger();
      const boom = new Error('kaboom');
      const app = buildApp({
        logger,
        throwFn: () => {
          throw boom;
        },
        attachRequestId: 'req-stack',
      });

      await app.request('/boom');

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [payload, label] = logger.error.mock.calls[0] ?? [];
      expect(label).toBe('internal_error');
      expect(payload).toMatchObject({
        requestId: 'req-stack',
        code: 'internal_error',
        status: 500,
      });
      expect(typeof (payload as Record<string, unknown>).stack).toBe('string');
      expect(String((payload as Record<string, unknown>).stack)).toContain('kaboom');
    });

    it('still produces a 500 envelope when a non-Error value reaches the handler', async () => {
      // Hono's core only invokes onError for `Error` instances; non-Error
      // throws bubble out of the app entirely. We therefore exercise the
      // handler directly with a non-Error input to confirm the defensive
      // branch in `serializeError` does not explode.
      const logger = createLogger();
      const handler = createErrorHandler({ logger });
      const app = new Hono();
      app.get('/', async (c) => {
        const res = await handler('string-thrown' as unknown as Error, c);
        return res;
      });

      const res = await app.request('/', { headers: { 'x-request-id': 'req-str' } });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('internal_error');
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [payload] = logger.error.mock.calls[0] ?? [];
      // When a non-Error is given, `err.name`/`err.message` are absent and
      // the stack is undefined; the payload records the raw value via
      // `serializeError`.
      expect((payload as Record<string, unknown>).stack).toBeUndefined();
      expect((payload as Record<string, unknown>).err).toEqual({ value: 'string-thrown' });
    });

    it('does not include details on the InternalError envelope by default', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new Error('boom');
        },
        attachRequestId: 'req-nodet',
      });

      const res = await app.request('/boom');
      const body = (await res.json()) as { error: Record<string, unknown> };
      expect('details' in body.error).toBe(false);
    });
  });

  describe('requestId resolution', () => {
    it('uses the requestId set on the Hono context', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('invalid_request', 400, 'x');
        },
        attachRequestId: 'ctx-id',
      });

      const res = await app.request('/boom');
      expect(res.headers.get('x-request-id')).toBe('ctx-id');
      const body = (await res.json()) as { error: { requestId: string } };
      expect(body.error.requestId).toBe('ctx-id');
    });

    it('falls back to the incoming x-request-id header when context is empty', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('invalid_request', 400, 'x');
        },
      });

      const res = await app.request('/boom', { headers: { 'x-request-id': 'hdr-id' } });
      expect(res.headers.get('x-request-id')).toBe('hdr-id');
      const body = (await res.json()) as { error: { requestId: string } };
      expect(body.error.requestId).toBe('hdr-id');
    });

    it('falls back to "unknown" when neither context nor header provides one', async () => {
      const logger = createLogger();
      const app = buildApp({
        logger,
        throwFn: () => {
          throw new RetinaError('invalid_request', 400, 'x');
        },
      });

      const res = await app.request('/boom');
      expect(res.headers.get('x-request-id')).toBe('unknown');
      const body = (await res.json()) as { error: { requestId: string } };
      expect(body.error.requestId).toBe('unknown');
    });
  });

  describe('InternalError class (sanity)', () => {
    it('carries code=internal_error and status=500', () => {
      const err = new InternalError();
      expect(err.code).toBe('internal_error');
      expect(err.status).toBe(500);
      expect(err).toBeInstanceOf(RetinaError);
    });
  });
});
