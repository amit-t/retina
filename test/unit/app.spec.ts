// End-to-end (in-process) verification of the error envelope via buildApp.
//
// This complements the focused middleware specs by asserting the full
// middleware chain (request-id → size-limit → routes → onError) works
// together: a RetinaError thrown from a route must reach the error handler
// with the request id already bound. This is the R02 acceptance criterion:
// thrown ValidationError yields a 400 JSON envelope with x-request-id echoed.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ValidationError } from '../../src/core/errors.js';
import { silentLogger } from './helpers.js';

interface EnvelopeBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

describe('buildApp() error envelope composition', () => {
  it('yields a 400 JSON envelope when ValidationError is thrown, echoing x-request-id', async () => {
    const app = buildApp({ logger: silentLogger(), maxImageBytes: 1024 });
    // Wire an ad-hoc route under the same app so the middleware chain runs
    // exactly as configured. This is the scenario from fix_plan R02 line 21.
    app.get('/throw', () => {
      throw new ValidationError('missing image');
    });

    const res = await app.request('/throw', {
      headers: { 'x-request-id': 'r02-acceptance' },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('r02-acceptance');

    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('missing image');
    expect(body.error.requestId).toBe('r02-acceptance');
  });

  it('returns a 413 envelope when the size limit middleware rejects a request', async () => {
    const app = buildApp({ logger: silentLogger(), maxImageBytes: 16 });
    const res = await app.request('/healthz', {
      method: 'POST',
      headers: { 'content-length': '9999' },
      body: 'oversized-payload',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.details).toMatchObject({ maxBytes: 16, declared: 9999 });
  });
});
