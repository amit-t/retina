import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ImageTooLargeError } from '../../../src/core/errors.ts';
import type { AppEnv } from '../../../src/http/context.ts';
import { sizeLimitMiddleware } from '../../../src/http/middleware/size-limit.ts';

function buildApp(maxBytes: number) {
  const app = new Hono<AppEnv>();
  app.use('*', sizeLimitMiddleware({ maxBytes }));
  app.post('/probe', (c) => c.json({ ok: true }));
  return app;
}

describe('sizeLimitMiddleware', () => {
  it('allows requests under the cap', async () => {
    const app = buildApp(1024);
    const res = await app.request('/probe', {
      method: 'POST',
      headers: { 'content-length': '16' },
      body: 'x'.repeat(16),
    });
    expect(res.status).toBe(200);
  });

  it('throws ImageTooLargeError when content-length exceeds the cap', async () => {
    const app = buildApp(8);
    let caught: unknown;
    app.onError((err, c) => {
      caught = err;
      return c.text('captured', 500);
    });
    await app.request('/probe', {
      method: 'POST',
      headers: { 'content-length': '1024' },
      body: 'x'.repeat(16),
    });
    expect(caught).toBeInstanceOf(ImageTooLargeError);
    const err = caught as ImageTooLargeError;
    expect(err.status).toBe(413);
    expect(err.details).toMatchObject({ declared: 1024, maxBytes: 8 });
  });

  it('skips the check when content-length header is absent', async () => {
    const app = buildApp(8);
    const res = await app.request('/probe', { method: 'POST', body: 'anything' });
    expect(res.status).toBe(200);
  });
});
