import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ImageTooLargeError, RetinaError } from '../../../../src/core/errors';
import { sizeLimit } from '../../../../src/http/middleware/size-limit';

const MAX = 1024;

function buildApp(max = MAX) {
  const app = new Hono();
  app.use('*', sizeLimit(max));
  app.post('/echo', async (c) => c.json({ ok: true }));
  // Surface middleware errors as JSON so the test can inspect shape.
  app.onError((err, c) => {
    if (err instanceof RetinaError) {
      return c.json(
        {
          code: err.code,
          status: err.status,
          details: err.details ?? null,
        },
        err.status as 413,
      );
    }
    return c.json({ code: 'internal_error' }, 500);
  });
  return app;
}

describe('size-limit middleware', () => {
  it('passes through when Content-Length is absent', async () => {
    const app = buildApp();
    const res = await app.request('/echo', { method: 'POST', body: 'hi' });
    expect(res.status).toBe(200);
  });

  it('passes through when Content-Length is under the limit', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-length': String(MAX - 1) },
      body: 'x',
    });
    expect(res.status).toBe(200);
  });

  it('passes through when Content-Length equals the limit', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-length': String(MAX) },
      body: 'x',
    });
    expect(res.status).toBe(200);
  });

  it('rejects with ImageTooLargeError when Content-Length exceeds the limit', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-length': String(MAX + 1) },
      body: 'x',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      code: string;
      status: number;
      details: { contentLength: number; maxBytes: number } | null;
    };
    expect(body.code).toBe('image_too_large');
    expect(body.status).toBe(413);
    expect(body.details).toEqual({ contentLength: MAX + 1, maxBytes: MAX });
  });

  it('ignores non-numeric Content-Length and lets other layers handle it', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-length': 'banana' },
      body: 'x',
    });
    expect(res.status).toBe(200);
  });

  it('throws ImageTooLargeError instance directly when invoked without a surrounding app', async () => {
    const middleware = sizeLimit(10);
    const ctx = {
      req: { header: (name: string) => (name === 'content-length' ? '11' : undefined) },
    };
    let thrown: unknown;
    try {
      await (middleware as unknown as (c: typeof ctx, next: () => Promise<void>) => Promise<void>)(
        ctx,
        async () => {},
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ImageTooLargeError);
    expect(thrown).toBeInstanceOf(RetinaError);
    const err = thrown as ImageTooLargeError;
    expect(err.code).toBe('image_too_large');
    expect(err.status).toBe(413);
    expect(err.details).toEqual({ contentLength: 11, maxBytes: 10 });
  });
});
