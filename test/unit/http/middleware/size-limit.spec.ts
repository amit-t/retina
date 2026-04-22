import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ImageTooLargeError, isRetinaError } from '../../../../src/core/errors.js';
import { sizeLimit } from '../../../../src/http/middleware/size-limit.js';
import type { AppEnv } from '../../../../src/http/types.js';

// We capture the error the middleware throws so we can assert on the typed
// error separately from envelope rendering (which is tested alongside the
// error middleware).
function app(maxBytes: number): { hono: Hono<AppEnv>; caught: { err: unknown } } {
  const caught: { err: unknown } = { err: undefined };
  const a = new Hono<AppEnv>();
  a.use('*', sizeLimit({ maxBytes }));
  a.post('/upload', (c) => c.json({ ok: true }));
  a.onError((err, c) => {
    caught.err = err;
    return c.json({ caught: true }, 500);
  });
  return { hono: a, caught };
}

describe('sizeLimit middleware', () => {
  it('throws ImageTooLargeError when Content-Length exceeds the cap', async () => {
    const { hono, caught } = app(100);
    const res = await hono.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '101' },
      body: 'x',
    });
    expect(res.status).toBe(500);
    expect(isRetinaError(caught.err)).toBe(true);
    expect(caught.err).toBeInstanceOf(ImageTooLargeError);
    const err = caught.err as ImageTooLargeError;
    expect(err.status).toBe(413);
    expect(err.code).toBe('image_too_large');
    expect(err.details).toEqual({ maxBytes: 100, declared: 101 });
  });

  it('passes through when Content-Length is exactly at the cap', async () => {
    const { hono, caught } = app(100);
    const res = await hono.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: 'x',
    });
    expect(res.status).toBe(200);
    expect(caught.err).toBeUndefined();
  });

  it('passes through when Content-Length is absent (chunked body)', async () => {
    const { hono, caught } = app(100);
    const res = await hono.request('/upload', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(caught.err).toBeUndefined();
  });

  it('ignores a non-numeric Content-Length and passes through', async () => {
    const { hono, caught } = app(100);
    const res = await hono.request('/upload', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
    });
    expect(res.status).toBe(200);
    expect(caught.err).toBeUndefined();
  });
});
