/**
 * Retina error hierarchy.
 *
 * All thrown errors should inherit from RetinaError so the HTTP error
 * middleware (src/http/middleware/error.ts) can map them to a stable
 * `{code, status}` envelope. The status/code mapping mirrors spec
 * §Error handling of docs/superpowers/specs/2026-04-21-retina-image-api-design.md.
 */

export interface RetinaErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class RetinaError extends Error {
  readonly code: string;
  readonly status: number;
  override readonly cause?: unknown;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, options: RetinaErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.details !== undefined) this.details = options.details;
    // Preserve prototype chain when transpiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends RetinaError {
  constructor(message = 'invalid request', options: RetinaErrorOptions = {}) {
    super('invalid_request', 400, message, options);
  }
}

export class ImageTooLargeError extends RetinaError {
  constructor(message = 'image too large', options: RetinaErrorOptions = {}) {
    super('image_too_large', 413, message, options);
  }
}

export class UnsupportedMediaTypeError extends RetinaError {
  constructor(message = 'unsupported media type', options: RetinaErrorOptions = {}) {
    super('unsupported_media_type', 415, message, options);
  }
}

export class ImageFetchError extends RetinaError {
  constructor(message = 'image fetch failed', options: RetinaErrorOptions = {}) {
    super('image_fetch_failed', 400, message, options);
  }
}

export class TemplateNotFoundError extends RetinaError {
  constructor(message = 'template not found', options: RetinaErrorOptions = {}) {
    super('template_not_found', 404, message, options);
  }
}

export class JobNotFoundError extends RetinaError {
  constructor(message = 'job not found', options: RetinaErrorOptions = {}) {
    super('job_not_found', 404, message, options);
  }
}

export class ProviderFailedError extends RetinaError {
  constructor(message = 'provider failed', options: RetinaErrorOptions = {}) {
    super('provider_failed', 502, message, options);
  }
}

export class ProviderTimeoutError extends RetinaError {
  constructor(message = 'provider timeout', options: RetinaErrorOptions = {}) {
    super('provider_timeout', 504, message, options);
  }
}

export class ProviderRateLimitError extends RetinaError {
  constructor(message = 'provider rate limited', options: RetinaErrorOptions = {}) {
    super('provider_rate_limited', 429, message, options);
  }
}

export class RedisUnavailableError extends RetinaError {
  constructor(message = 'redis unavailable', options: RetinaErrorOptions = {}) {
    super('redis_unavailable', 503, message, options);
  }
}

export class InternalError extends RetinaError {
  constructor(message = 'internal error', options: RetinaErrorOptions = {}) {
    super('internal_error', 500, message, options);
  }
}
