import { describe, expect, it } from 'vitest';
import {
  ImageFetchError,
  ImageTooLargeError,
  InternalError,
  isRetinaError,
  JobNotFoundError,
  ProviderFailedError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  RedisUnavailableError,
  RetinaError,
  TemplateNotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../../src/core/errors.ts';

describe('RetinaError subclasses', () => {
  const cases: Array<{
    ctor: new (msg?: string) => RetinaError;
    code: string;
    status: number;
  }> = [
    { ctor: ValidationError, code: 'invalid_request', status: 400 },
    { ctor: ImageTooLargeError, code: 'image_too_large', status: 413 },
    { ctor: UnsupportedMediaTypeError, code: 'unsupported_media_type', status: 415 },
    { ctor: ImageFetchError, code: 'image_fetch_failed', status: 400 },
    { ctor: TemplateNotFoundError, code: 'template_not_found', status: 404 },
    { ctor: JobNotFoundError, code: 'job_not_found', status: 404 },
    { ctor: ProviderFailedError, code: 'provider_failed', status: 502 },
    { ctor: ProviderTimeoutError, code: 'provider_timeout', status: 504 },
    { ctor: ProviderRateLimitError, code: 'provider_rate_limited', status: 429 },
    { ctor: RedisUnavailableError, code: 'redis_unavailable', status: 503 },
    { ctor: InternalError, code: 'internal_error', status: 500 },
  ];

  for (const { ctor, code, status } of cases) {
    it(`${ctor.name} carries code=${code} status=${status}`, () => {
      const err = new ctor('boom');
      expect(err).toBeInstanceOf(RetinaError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe('boom');
      expect(err.name).toBe(ctor.name);
    });
  }

  it('propagates details and cause', () => {
    const cause = new Error('root');
    const err = new ValidationError('bad', {
      cause,
      details: { field: 'image.url' },
    });
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ field: 'image.url' });
  });

  it('isRetinaError discriminates non-Retina errors', () => {
    expect(isRetinaError(new ValidationError())).toBe(true);
    expect(isRetinaError(new Error('plain'))).toBe(false);
    expect(isRetinaError('not an error')).toBe(false);
    expect(isRetinaError(null)).toBe(false);
  });
});
