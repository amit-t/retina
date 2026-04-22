import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ImageTooLargeError, type RetinaError } from '../../src/core/errors.js';
import { sizeLimit } from '../../src/http/middleware/size-limit.js';
import type { HonoEnv } from '../../src/http/types.js';

function makeApp(maxBytes: number) {
  const app = new Hono<HonoEnv>();
  app.use('*', sizeLimit({ maxBytes }));
  app.post('/upload', (c) => c.json({ ok: true }));
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}

describe('sizeLimit middleware', () => {
  it('throws ImageTooLargeError when Content-Length exceeds max on POST', async () => {
    const app = makeApp(100);
    let captured: unknown;
    app.onError((err, c) => {
      captured = err;
      return c.json({ caught: true }, 500);
    });
    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '200' },
    });
    expect(res.status).toBe(500);
    expect(captured).toBeInstanceOf(ImageTooLargeError);
    const e = captured as RetinaError;
    expect(e.code).toBe('image_too_large');
    expect(e.status).toBe(413);
    expect(e.details).toEqual({ maxBytes: 100, declared: 200 });
  });

  it('allows requests with Content-Length at or below max', async () => {
    const app = makeApp(100);
    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '100' },
    });
    expect(res.status).toBe(200);
  });

  it('allows requests with no Content-Length header (streaming defers to normalizer)', async () => {
    const app = makeApp(100);
    const res = await app.request('/upload', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('ignores Content-Length on GET requests', async () => {
    const app = makeApp(10);
    const res = await app.request('/probe', {
      method: 'GET',
      headers: { 'content-length': '9999' },
    });
    expect(res.status).toBe(200);
  });

  it('allows non-numeric Content-Length (defers to normalizer)', async () => {
    const app = makeApp(100);
    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
    });
    expect(res.status).toBe(200);
  });
});
