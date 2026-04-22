/**
 * Typed error hierarchy for Retina.
 *
 * The full set of subclasses described in the spec §Error handling is added in
 * sibling R02 sub-tasks. This module only needs to export `RetinaError` and
 * `ImageTooLargeError` for the size-limit middleware to consume; new
 * subclasses extend `RetinaError` in the same shape.
 */

export interface RetinaErrorOptions {
  code: string;
  status: number;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class RetinaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: RetinaErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export class ImageTooLargeError extends RetinaError {
  constructor(message = 'Image too large', details?: Record<string, unknown>) {
    super(message, {
      code: 'image_too_large',
      status: 413,
      ...(details !== undefined ? { details } : {}),
    });
  }
}
