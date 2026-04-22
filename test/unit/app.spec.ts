import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ValidationError } from '../../src/core/errors.js';
import { buildLogger } from '../../src/logger.js';

function makeApp() {
  const logger = buildLogger('silent');
  return buildApp({ logger, maxImageBytes: 100 });
}

interface HealthBody {
  ok: boolean;
  redis: 'up' | 'down';
  providers: Record<string, 'up' | 'down'>;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

describe('buildApp', () => {
  it('GET /healthz returns the R02 stub shape', async () => {
    const app = makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({ ok: true, redis: 'down', providers: {} });
  });

  it('attaches an x-request-id header to successful responses', async () => {
    const app = makeApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('echoes caller x-request-id back on success', async () => {
    const app = makeApp();
    const res = await app.request('/healthz', { headers: { 'x-request-id': 'trace-xyz' } });
    expect(res.headers.get('x-request-id')).toBe('trace-xyz');
  });

  it('returns the canonical error envelope when a route throws a RetinaError', async () => {
    const logger = buildLogger('silent');
    const app = buildApp({ logger, maxImageBytes: 100 });
    app.get('/throw', () => {
      throw new ValidationError('bad input', { details: { path: ['body', 'image'] } });
    });
    const res = await app.request('/throw', { headers: { 'x-request-id': 'req-42' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('req-42');
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('bad input');
    expect(body.error.requestId).toBe('req-42');
    expect(body.error.details).toEqual({ path: ['body', 'image'] });
  });

  it('enforces the size-limit middleware in front of routes (413 with echoed request id)', async () => {
    const app = makeApp();
    const res = await app.request('/healthz', {
      method: 'POST',
      headers: { 'content-length': '9999', 'x-request-id': 'too-big' },
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('x-request-id')).toBe('too-big');
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.requestId).toBe('too-big');
  });
});
