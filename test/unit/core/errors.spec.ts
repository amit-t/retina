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
} from '../../../src/core/errors.js';

// Every row here is a direct translation of the spec §Error handling table:
//   docs/superpowers/specs/2026-04-21-retina-image-api-design.md
// If the spec's mapping changes, update the spec, this table, AND the source
// together. The table is the single source of truth every other test relies
// on.
const errorTable: ReadonlyArray<{
  name: string;
  ctor: new (message?: string) => RetinaError;
  code: string;
  status: number;
}> = [
  { name: 'ValidationError', ctor: ValidationError, code: 'invalid_request', status: 400 },
  { name: 'ImageTooLargeError', ctor: ImageTooLargeError, code: 'image_too_large', status: 413 },
  {
    name: 'UnsupportedMediaTypeError',
    ctor: UnsupportedMediaTypeError,
    code: 'unsupported_media_type',
    status: 415,
  },
  { name: 'ImageFetchError', ctor: ImageFetchError, code: 'image_fetch_failed', status: 400 },
  {
    name: 'TemplateNotFoundError',
    ctor: TemplateNotFoundError,
    code: 'template_not_found',
    status: 404,
  },
  { name: 'JobNotFoundError', ctor: JobNotFoundError, code: 'job_not_found', status: 404 },
  { name: 'ProviderFailedError', ctor: ProviderFailedError, code: 'provider_failed', status: 502 },
  {
    name: 'ProviderTimeoutError',
    ctor: ProviderTimeoutError,
    code: 'provider_timeout',
    status: 504,
  },
  {
    name: 'ProviderRateLimitError',
    ctor: ProviderRateLimitError,
    code: 'provider_rate_limited',
    status: 429,
  },
  {
    name: 'RedisUnavailableError',
    ctor: RedisUnavailableError,
    code: 'redis_unavailable',
    status: 503,
  },
  { name: 'InternalError', ctor: InternalError, code: 'internal_error', status: 500 },
];

describe('RetinaError hierarchy', () => {
  it.each(errorTable)('$name exposes code=$code and status=$status', ({
    name,
    ctor,
    code,
    status,
  }) => {
    const instance = new ctor('boom');
    expect(instance).toBeInstanceOf(RetinaError);
    expect(instance).toBeInstanceOf(Error);
    expect(instance.code).toBe(code);
    expect(instance.status).toBe(status);
    expect(instance.message).toBe('boom');
    expect(instance.name).toBe(name);
  });

  it('uses a default message when none is provided', () => {
    for (const entry of errorTable) {
      const instance = new entry.ctor();
      expect(instance.message.length).toBeGreaterThan(0);
    }
  });

  it('retains cause and details when passed via options', () => {
    const cause = new Error('downstream');
    const details = { attempts: [{ provider: 'openai', model: 'x', code: 'boom', message: 'no' }] };
    const err = new ProviderFailedError('chain failed', { cause, details });
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual(details);
  });

  it('omits cause and details when not supplied', () => {
    const err = new ValidationError('bad');
    expect(err.cause).toBeUndefined();
    expect(err.details).toBeUndefined();
  });

  it('isRetinaError narrows typed errors and rejects plain errors', () => {
    expect(isRetinaError(new ValidationError('x'))).toBe(true);
    expect(isRetinaError(new Error('x'))).toBe(false);
    expect(isRetinaError('nope')).toBe(false);
    expect(isRetinaError(undefined)).toBe(false);
  });
});
