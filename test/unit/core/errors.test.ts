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
} from '../../../src/core/errors.js';

describe('RetinaError', () => {
  it('is an Error subclass that carries code, status, message, cause, and details', () => {
    const cause = new Error('boom');
    const err = new RetinaError('test_code', 418, 'teapot', {
      cause,
      details: { hint: 'short and stout' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RetinaError);
    expect(err.name).toBe('RetinaError');
    expect(err.code).toBe('test_code');
    expect(err.status).toBe(418);
    expect(err.message).toBe('teapot');
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ hint: 'short and stout' });
  });

  it('leaves cause and details undefined when not supplied', () => {
    const err = new RetinaError('x', 500, 'x');
    expect(err.cause).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe('RetinaError subclasses', () => {
  const cases: Array<{
    Ctor: new (msg?: string) => RetinaError;
    name: string;
    code: string;
    status: number;
  }> = [
    { Ctor: ValidationError, name: 'ValidationError', code: 'invalid_request', status: 400 },
    { Ctor: ImageTooLargeError, name: 'ImageTooLargeError', code: 'image_too_large', status: 413 },
    {
      Ctor: UnsupportedMediaTypeError,
      name: 'UnsupportedMediaTypeError',
      code: 'unsupported_media_type',
      status: 415,
    },
    { Ctor: ImageFetchError, name: 'ImageFetchError', code: 'image_fetch_failed', status: 400 },
    {
      Ctor: TemplateNotFoundError,
      name: 'TemplateNotFoundError',
      code: 'template_not_found',
      status: 404,
    },
    { Ctor: JobNotFoundError, name: 'JobNotFoundError', code: 'job_not_found', status: 404 },
    {
      Ctor: ProviderFailedError,
      name: 'ProviderFailedError',
      code: 'provider_failed',
      status: 502,
    },
    {
      Ctor: ProviderTimeoutError,
      name: 'ProviderTimeoutError',
      code: 'provider_timeout',
      status: 504,
    },
    {
      Ctor: ProviderRateLimitError,
      name: 'ProviderRateLimitError',
      code: 'provider_rate_limited',
      status: 429,
    },
    {
      Ctor: RedisUnavailableError,
      name: 'RedisUnavailableError',
      code: 'redis_unavailable',
      status: 503,
    },
    { Ctor: InternalError, name: 'InternalError', code: 'internal_error', status: 500 },
  ];

  for (const { Ctor, name, code, status } of cases) {
    it(`${name} has code=${code} status=${status} and inherits RetinaError`, () => {
      const err = new Ctor();
      expect(err).toBeInstanceOf(RetinaError);
      expect(err).toBeInstanceOf(Ctor);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    });
  }

  it('ProviderFailedError.details.attempts survives the options pass-through', () => {
    const attempts = [
      { provider: 'openai', model: 'gpt-x', code: 'upstream_5xx', message: 'bad gateway' },
      { provider: 'anthropic', model: 'claude-y', code: 'timeout', message: 'slow' },
    ];
    const err = new ProviderFailedError('all providers failed', { details: { attempts } });
    expect(err.details).toEqual({ attempts });
  });
});
