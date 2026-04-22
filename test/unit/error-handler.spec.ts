import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ImageTooLargeError,
  ProviderFailedError,
  TemplateNotFoundError,
  ValidationError,
} from '../../src/core/errors.js';
import { errorHandler } from '../../src/http/middleware/error.js';
import { requestId } from '../../src/http/middleware/request-id.js';
import type { HonoEnv } from '../../src/http/types.js';
import { buildLogger } from '../../src/logger.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function makeApp(throwable: unknown) {
  const logger = buildLogger('silent');
  const app = new Hono<HonoEnv>();
  app.use('*', requestId({ logger }));
  app.get('/boom', () => {
    throw throwable as Error;
  });
  app.onError(errorHandler({ logger }));
  return app;
}

describe('errorHandler', () => {
  it('maps ValidationError to 400 envelope with requestId', async () => {
    const app = makeApp(new ValidationError('body.missing'));
    const res = await app.request('/boom', { headers: { 'x-request-id': 'abc-1' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('abc-1');
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('body.missing');
    expect(body.error.requestId).toBe('abc-1');
  });

  it('maps ImageTooLargeError to 413 and forwards details', async () => {
    const app = makeApp(
      new ImageTooLargeError('too big', { details: { maxBytes: 100, declared: 500 } }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.details).toEqual({ maxBytes: 100, declared: 500 });
  });

  it('maps TemplateNotFoundError to 404', async () => {
    const app = makeApp(new TemplateNotFoundError('unknown id'));
    const res = await app.request('/boom');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('template_not_found');
  });

  it('maps ProviderFailedError to 502 with attempts in details', async () => {
    const app = makeApp(
      new ProviderFailedError('all exhausted', {
        details: { attempts: [{ provider: 'openai', model: 'x', code: '500', message: 'boom' }] },
      }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('provider_failed');
    expect(body.error.details).toEqual({
      attempts: [{ provider: 'openai', model: 'x', code: '500', message: 'boom' }],
    });
  });

  it('coerces unknown errors to 500 internal_error', async () => {
    const app = makeApp(new Error('mystery'));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('internal_error');
  });

  it('coerces thrown TypeError to 500 internal_error (non-RetinaError path)', async () => {
    const app = makeApp(new TypeError('unexpected undefined'));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('internal_error');
  });
});
