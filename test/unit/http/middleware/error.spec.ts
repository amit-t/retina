import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ImageTooLargeError,
  ProviderFailedError,
  ValidationError,
} from '../../../../src/core/errors.js';
import { errorHandler } from '../../../../src/http/middleware/error.js';
import { requestId } from '../../../../src/http/middleware/request-id.js';
import type { AppEnv } from '../../../../src/http/types.js';
import { silentLogger } from '../../helpers.js';

interface EnvelopeBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function appThatThrows(err: unknown): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', requestId());
  a.get('/boom', () => {
    throw err;
  });
  a.onError(errorHandler({ logger: silentLogger() }));
  return a;
}

describe('errorHandler middleware', () => {
  it('maps ValidationError to a 400 envelope with the spec code', async () => {
    const res = await appThatThrows(new ValidationError('bad body')).request('/boom');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('bad body');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    expect(body.error.details).toBeUndefined();
  });

  it('maps ImageTooLargeError to a 413 envelope and preserves details', async () => {
    const err = new ImageTooLargeError('too big', { details: { maxBytes: 10, declared: 99 } });
    const res = await appThatThrows(err).request('/boom');
    expect(res.status).toBe(413);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.details).toEqual({ maxBytes: 10, declared: 99 });
  });

  it('echoes the caller-supplied x-request-id in the envelope', async () => {
    const res = await appThatThrows(new ValidationError('x')).request('/boom', {
      headers: { 'x-request-id': 'trace-xyz' },
    });
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.requestId).toBe('trace-xyz');
    expect(res.headers.get('x-request-id')).toBe('trace-xyz');
  });

  it('wraps unknown errors as InternalError 500 without leaking the original message', async () => {
    const res = await appThatThrows(new Error('raw details leaking')).request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('internal error');
    expect(body.error.message).not.toContain('raw details leaking');
  });

  it('surfaces ProviderFailedError.details.attempts in the envelope', async () => {
    const attempts = [
      { provider: 'openai', model: 'gpt-vision', code: 'timeout', message: 'oops' },
    ];
    const err = new ProviderFailedError('all retries exhausted', { details: { attempts } });
    const res = await appThatThrows(err).request('/boom');
    expect(res.status).toBe(502);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error.code).toBe('provider_failed');
    expect(body.error.details).toEqual({ attempts });
  });
});
