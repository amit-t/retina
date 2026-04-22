import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { ValidationError } from '../../src/core/errors.ts';
import { buildLogger } from '../../src/logger.ts';

function buildTestApp() {
  const logger = buildLogger('silent');
  const app = buildApp({ logger, maxImageBytes: 1024 });
  app.get('/__throw_validation', () => {
    throw new ValidationError('body.image is required', { details: { field: 'image' } });
  });
  app.post('/__echo', (c) => c.json({ ok: true }));
  return app;
}

describe('buildApp()', () => {
  it('healthz responds with MVP shape', async () => {
    const app = buildTestApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redis: 'down', providers: {} });
  });

  it('echoes x-request-id on healthz', async () => {
    const app = buildTestApp();
    const res = await app.request('/healthz', {
      headers: { 'x-request-id': 'rid-1' },
    });
    expect(res.headers.get('x-request-id')).toBe('rid-1');
  });

  it('thrown ValidationError yields a 400 JSON envelope with x-request-id echoed', async () => {
    const app = buildTestApp();
    const res = await app.request('/__throw_validation', {
      headers: { 'x-request-id': 'rid-42' },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('rid-42');
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string; details?: unknown };
    };
    expect(body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'body.image is required',
        requestId: 'rid-42',
        details: { field: 'image' },
      },
    });
  });

  it('generated request id is echoed when client omits the header', async () => {
    const app = buildTestApp();
    const res = await app.request('/__throw_validation');

    expect(res.status).toBe(400);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    const body = (await res.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe(id);
  });

  it('size-limit rejections surface as 413 envelopes', async () => {
    const app = buildTestApp();
    const res = await app.request('/__echo', {
      method: 'POST',
      headers: { 'content-length': '9999' },
      body: 'x'.repeat(16),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('image_too_large');
  });
});
