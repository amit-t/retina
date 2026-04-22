import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ProviderFailedError, ValidationError } from '../../../src/core/errors.ts';
import type { AppEnv } from '../../../src/http/context.ts';
import { registerErrorHandler } from '../../../src/http/middleware/error.ts';
import { requestIdMiddleware } from '../../../src/http/middleware/request-id.ts';

interface Envelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function buildApp(handler: () => never) {
  const app = new Hono<AppEnv>();
  app.use('*', requestIdMiddleware());
  app.get('/boom', () => {
    handler();
  });
  registerErrorHandler(app);
  return app;
}

describe('errorMiddleware', () => {
  it('converts a RetinaError into the standard envelope with matching status', async () => {
    const app = buildApp(() => {
      throw new ValidationError('field missing', { details: { field: 'image' } });
    });
    const res = await app.request('/boom', { headers: { 'x-request-id': 'req-abc' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('req-abc');
    const body = (await res.json()) as Envelope;
    expect(body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'field missing',
        requestId: 'req-abc',
        details: { field: 'image' },
      },
    });
  });

  it('omits details when the error carries none', async () => {
    const app = buildApp(() => {
      throw new ValidationError('bad');
    });
    const res = await app.request('/boom');
    const body = (await res.json()) as Envelope;
    expect(body.error.details).toBeUndefined();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('bad');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it('passes through ProviderFailedError attempts as details', async () => {
    const attempts = [{ provider: 'openai', model: 'x', code: 'rate_limited', message: '429' }];
    const app = buildApp(() => {
      throw new ProviderFailedError('all exhausted', { details: { attempts } });
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(502);
    const body = (await res.json()) as Envelope;
    expect(body.error.details).toEqual({ attempts });
  });

  it('wraps unknown errors as InternalError 500', async () => {
    const app = buildApp(() => {
      throw new Error('oops');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('unexpected error');
  });
});
