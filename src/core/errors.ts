// Typed error hierarchy for Retina. Every error that should reach an HTTP
// client flows through a `RetinaError` subclass so the error middleware can map
// it to `{status, code, message, details}` without a big switch.
//
// Codes/statuses here match spec §Error handling (see
// docs/superpowers/specs/2026-04-21-retina-image-api-design.md).

export type RetinaErrorDetails = Record<string, unknown>;

export interface RetinaErrorOptions {
  cause?: unknown;
  details?: RetinaErrorDetails;
}

export class RetinaError extends Error {
  readonly code: string;
  readonly status: number;
  override readonly cause?: unknown;
  readonly details?: RetinaErrorDetails;

  constructor(message: string, opts: { code: string; status: number } & RetinaErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export class ValidationError extends RetinaError {
  constructor(message = 'invalid request', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'invalid_request', status: 400, ...opts });
  }
}

export class ImageTooLargeError extends RetinaError {
  constructor(message = 'image exceeds size limit', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'image_too_large', status: 413, ...opts });
  }
}

export class UnsupportedMediaTypeError extends RetinaError {
  constructor(message = 'unsupported media type', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'unsupported_media_type', status: 415, ...opts });
  }
}

export class ImageFetchError extends RetinaError {
  constructor(message = 'failed to fetch image', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'image_fetch_failed', status: 400, ...opts });
  }
}

export class TemplateNotFoundError extends RetinaError {
  constructor(message = 'template not found', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'template_not_found', status: 404, ...opts });
  }
}

export class JobNotFoundError extends RetinaError {
  constructor(message = 'job not found', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'job_not_found', status: 404, ...opts });
  }
}

export class ProviderFailedError extends RetinaError {
  constructor(message = 'provider failed', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'provider_failed', status: 502, ...opts });
  }
}

export class ProviderTimeoutError extends RetinaError {
  constructor(message = 'provider timeout', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'provider_timeout', status: 504, ...opts });
  }
}

export class ProviderRateLimitError extends RetinaError {
  constructor(message = 'provider rate limited', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'provider_rate_limited', status: 429, ...opts });
  }
}

export class RedisUnavailableError extends RetinaError {
  constructor(message = 'redis unavailable', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'redis_unavailable', status: 503, ...opts });
  }
}

export class InternalError extends RetinaError {
  constructor(message = 'internal error', opts: RetinaErrorOptions = {}) {
    super(message, { code: 'internal_error', status: 500, ...opts });
  }
}

export function isRetinaError(err: unknown): err is RetinaError {
  return err instanceof RetinaError;
}
