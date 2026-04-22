// Typed error hierarchy for Retina.
//
// All user-facing failures flow through this file: route handlers / services
// throw a `RetinaError` subclass; the HTTP error middleware (see
// `src/http/middleware/error.ts`, task R02) maps them to a stable JSON
// envelope `{ error: { code, message, requestId, details } }` with the
// subclass's `status`.
//
// Shape comes from spec §Error handling
// (docs/superpowers/specs/2026-04-21-retina-image-api-design.md):
//
//   class RetinaError extends Error {
//     code: string
//     status: number
//     cause?: unknown
//     details?: Record<string, unknown>
//   }

export type RetinaErrorDetails = Record<string, unknown>;

export interface RetinaErrorOptions {
  cause?: unknown;
  details?: RetinaErrorDetails;
}

/**
 * Base class for every typed error in Retina. Concrete subclasses fix
 * `code` (stable string surfaced to API clients) and `status` (HTTP status
 * the error middleware emits).
 */
export class RetinaError extends Error {
  readonly code: string;
  readonly status: number;
  override readonly cause?: unknown;
  readonly details?: RetinaErrorDetails;

  constructor(code: string, status: number, message: string, options: RetinaErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.details !== undefined) this.details = options.details;
    // Preserve prototype across transpilation / `extends Error` quirks so
    // `instanceof` works reliably in downstream middleware.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — Zod parse failure on a request body / query / params. */
export class ValidationError extends RetinaError {
  constructor(message = 'Invalid request', options: RetinaErrorOptions = {}) {
    super('invalid_request', 400, message, options);
  }
}

/** 413 — image body exceeds `MAX_IMAGE_BYTES`. */
export class ImageTooLargeError extends RetinaError {
  constructor(message = 'Image too large', options: RetinaErrorOptions = {}) {
    super('image_too_large', 413, message, options);
  }
}

/** 415 — declared or sniffed mime is not an image/* type we accept. */
export class UnsupportedMediaTypeError extends RetinaError {
  constructor(message = 'Unsupported media type', options: RetinaErrorOptions = {}) {
    super('unsupported_media_type', 415, message, options);
  }
}

/** 400 — URL fetch failed (4xx/5xx upstream or client timeout). */
export class ImageFetchError extends RetinaError {
  constructor(message = 'Image fetch failed', options: RetinaErrorOptions = {}) {
    super('image_fetch_failed', 400, message, options);
  }
}

/** 404 — `templateId` did not resolve to a known template. */
export class TemplateNotFoundError extends RetinaError {
  constructor(message = 'Template not found', options: RetinaErrorOptions = {}) {
    super('template_not_found', 404, message, options);
  }
}

/** 404 — requested job id does not exist (or its result TTL has expired). */
export class JobNotFoundError extends RetinaError {
  constructor(message = 'Job not found', options: RetinaErrorOptions = {}) {
    super('job_not_found', 404, message, options);
  }
}

/**
 * 502 — the primary provider and every link in the fallback chain failed
 * after their retry budgets. `details.attempts` carries one entry per
 * attempted `{ provider, model, code, message }` so callers can diagnose.
 */
export class ProviderFailedError extends RetinaError {
  constructor(message = 'Provider failed', options: RetinaErrorOptions = {}) {
    super('provider_failed', 502, message, options);
  }
}

/** 504 — sync request exceeded `REQUEST_TIMEOUT_MS` waiting on a provider. */
export class ProviderTimeoutError extends RetinaError {
  constructor(message = 'Provider timeout', options: RetinaErrorOptions = {}) {
    super('provider_timeout', 504, message, options);
  }
}

/** 429 — provider upstream rate-limited us; `Retry-After` echoed when known. */
export class ProviderRateLimitError extends RetinaError {
  constructor(message = 'Provider rate limited', options: RetinaErrorOptions = {}) {
    super('provider_rate_limited', 429, message, options);
  }
}

/** 503 — Redis connection is unavailable on the async / jobs path. */
export class RedisUnavailableError extends RetinaError {
  constructor(message = 'Redis unavailable', options: RetinaErrorOptions = {}) {
    super('redis_unavailable', 503, message, options);
  }
}

/** 500 — unexpected failure; logged with stack by the error middleware. */
export class InternalError extends RetinaError {
  constructor(message = 'Internal error', options: RetinaErrorOptions = {}) {
    super('internal_error', 500, message, options);
  }
}
