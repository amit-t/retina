import { describe, expect, it } from 'vitest';
import {
  ImageFetchError,
  ImageTooLargeError,
  InternalError,
  JobNotFoundError,
  ProviderFailedError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  RedisUnavailableError,
  RetinaError,
  TemplateNotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../src/core/errors.js';

describe('RetinaError hierarchy', () => {
  const table: Array<{
    name: string;
    factory: () => RetinaError;
    code: string;
    status: number;
  }> = [
    {
      name: 'ValidationError',
      factory: () => new ValidationError(),
      code: 'invalid_request',
      status: 400,
    },
    {
      name: 'ImageTooLargeError',
      factory: () => new ImageTooLargeError(),
      code: 'image_too_large',
      status: 413,
    },
    {
      name: 'UnsupportedMediaTypeError',
      factory: () => new UnsupportedMediaTypeError(),
      code: 'unsupported_media_type',
      status: 415,
    },
    {
      name: 'ImageFetchError',
      factory: () => new ImageFetchError(),
      code: 'image_fetch_failed',
      status: 400,
    },
    {
      name: 'TemplateNotFoundError',
      factory: () => new TemplateNotFoundError(),
      code: 'template_not_found',
      status: 404,
    },
    {
      name: 'JobNotFoundError',
      factory: () => new JobNotFoundError(),
      code: 'job_not_found',
      status: 404,
    },
    {
      name: 'ProviderFailedError',
      factory: () => new ProviderFailedError(),
      code: 'provider_failed',
      status: 502,
    },
    {
      name: 'ProviderTimeoutError',
      factory: () => new ProviderTimeoutError(),
      code: 'provider_timeout',
      status: 504,
    },
    {
      name: 'ProviderRateLimitError',
      factory: () => new ProviderRateLimitError(),
      code: 'provider_rate_limited',
      status: 429,
    },
    {
      name: 'RedisUnavailableError',
      factory: () => new RedisUnavailableError(),
      code: 'redis_unavailable',
      status: 503,
    },
    {
      name: 'InternalError',
      factory: () => new InternalError(),
      code: 'internal_error',
      status: 500,
    },
  ];

  for (const row of table) {
    it(`${row.name} carries code=${row.code} status=${row.status} and extends RetinaError`, () => {
      const err = row.factory();
      expect(err).toBeInstanceOf(RetinaError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(row.code);
      expect(err.status).toBe(row.status);
      expect(err.name).toBe(row.name);
    });
  }

  it('forwards cause and details when supplied', () => {
    const cause = new Error('upstream');
    const err = new ProviderFailedError('all providers exhausted', {
      cause,
      details: { attempts: [{ provider: 'openai', code: '500', message: 'boom' }] },
    });
    expect(err.message).toBe('all providers exhausted');
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({
      attempts: [{ provider: 'openai', code: '500', message: 'boom' }],
    });
  });

  it('has no details when not supplied (exactOptionalPropertyTypes)', () => {
    const err = new ValidationError();
    expect('details' in err ? err.details : undefined).toBeUndefined();
  });
});
