/**
 * Minimal RetinaError hierarchy required by the error middleware.
 *
 * The full hierarchy (all 10 spec subclasses — ValidationError,
 * ImageTooLargeError, UnsupportedMediaTypeError, ImageFetchError,
 * TemplateNotFoundError, JobNotFoundError, ProviderFailedError,
 * ProviderTimeoutError, ProviderRateLimitError, RedisUnavailableError) is
 * produced by its dedicated ralph task (R02 sub-item 1). That task extends
 * this base; it does not replace it.
 *
 * See docs/superpowers/specs/2026-04-21-retina-image-api-design.md
 * §Error handling.
 */

export interface RetinaErrorOptions {
  code: string;
  status: number;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class RetinaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: RetinaErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
  }
}

export interface InternalErrorOptions {
  message?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class InternalError extends RetinaError {
  constructor(opts: InternalErrorOptions = {}) {
    const base: RetinaErrorOptions = {
      code: 'internal_error',
      status: 500,
      message: opts.message ?? 'Internal server error',
    };
    if (opts.cause !== undefined) base.cause = opts.cause;
    if (opts.details !== undefined) base.details = opts.details;
    super(base);
  }
}
