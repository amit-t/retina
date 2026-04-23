// R02h — full-composition integration test for `buildApp()`.
//
// Exercises the entire R02 middleware + route stack end-to-end rather than a
// single module. The individual R02a–R02g unit tests cover each piece in
// isolation; this file asserts that when they are wired together via
// `src/app.ts`, a `ValidationError` thrown inside a route handler flows
// through the composed pipeline and lands as a 400 JSON envelope with the
// `x-request-id` header echoed back — the acceptance criterion called out in
// `.ralph/fix_plan.md` R02h.
//
// Pipeline under test:
//
//   request-id → size-limit → route handler (throws ValidationError)
//                                           ↓
//                                     app.onError (createErrorHandler)
//                                           ↓
//                              JSON envelope { error: { code, message,
//                                                       requestId, details? } }

import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { ImageTooLargeError, ValidationError } from '../../src/core/errors.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';

// Silent structural logger so composition tests do not spew pino JSON onto
// the test runner's stdout. Real logger behavior is covered by
// test/unit/logger.spec.ts.
function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

// Matches a canonical 8-4-4-4-12 lowercase UUID v4 string. Same regex as
// test/unit/http/middleware/request-id.spec.ts so the two stay in sync.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('buildApp composition (R02h)', () => {
  it('maps a ValidationError thrown in a route to a 400 JSON envelope with x-request-id echoed', async () => {
    const app = buildApp({ logger: silentLogger() });
    // Routes registered after `buildApp` are still wrapped by the app's
    // global `onError` handler and go through `app.use(...)` middleware
    // registered inside `buildApp`, so this exercises the full composed
    // pipeline rather than a bespoke stack.
    app.get('/throw-validation', () => {
      throw new ValidationError('missing field: foo', {
        details: { path: ['body', 'foo'] },
      });
    });

    const res = await app.request('/throw-validation', {
      headers: { 'x-request-id': 'compose-req-1' },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('compose-req-1');
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string; details?: unknown };
    };
    expect(body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'missing field: foo',
        requestId: 'compose-req-1',
        details: { path: ['body', 'foo'] },
      },
    });
  });

  it('generates a UUID v4 request id when the caller does not supply one', async () => {
    const app = buildApp({ logger: silentLogger() });
    app.get('/throw-validation', () => {
      throw new ValidationError('nope');
    });

    const res = await app.request('/throw-validation');

    expect(res.status).toBe(400);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(UUID_V4_RE);

    const body = (await res.json()) as { error: { requestId: string; code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.requestId).toBe(id);
  });

  it('still serves /healthz through the composed stack and echoes x-request-id', async () => {
    const app = buildApp({ logger: silentLogger() });

    const res = await app.request('/healthz', {
      headers: { 'x-request-id': 'compose-health' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('compose-health');
    const body = (await res.json()) as {
      ok: boolean;
      redis: string;
      providers: Record<string, unknown>;
    };
    expect(body).toEqual({ ok: true, redis: 'down', providers: {} });
  });

  it('rejects bodies exceeding MAX_IMAGE_BYTES before the route runs (size-limit → error envelope)', async () => {
    // Pass a tiny cap so a small stub body is rejected. Routes never run
    // because size-limit throws `ImageTooLargeError` pre-buffering; we
    // still expect the composed error handler to emit the envelope and
    // echo the request id.
    const app = buildApp({ config: { MAX_IMAGE_BYTES: 8 }, logger: silentLogger() });
    let routeHits = 0;
    app.post('/upload', (c) => {
      routeHits += 1;
      return c.json({ ok: true });
    });

    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '1024',
        'x-request-id': 'compose-size',
      },
      body: new Uint8Array(16),
    });

    expect(routeHits).toBe(0);
    expect(res.status).toBe(413);
    expect(res.headers.get('x-request-id')).toBe('compose-size');

    const body = (await res.json()) as {
      error: { code: string; requestId: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.requestId).toBe('compose-size');
    expect(body.error.details).toEqual({ contentLength: 1024, maxBytes: 8 });
    // Sanity: ImageTooLargeError is the class size-limit throws, and the
    // envelope carries its canonical code.
    expect(new ImageTooLargeError().code).toBe('image_too_large');
  });

  it('wraps unknown (non-RetinaError) throws into a 500 internal_error envelope with x-request-id echoed', async () => {
    const app = buildApp({ logger: silentLogger() });
    app.get('/explode', () => {
      throw new Error('boom');
    });

    const res = await app.request('/explode', {
      headers: { 'x-request-id': 'compose-boom' },
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBe('compose-boom');
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.requestId).toBe('compose-boom');
  });
});
