// Pre-flight size cap.
//
// Reject requests whose declared `Content-Length` exceeds `maxBytes` before
// any body parsing. This protects the image normalizer (R05) from having to
// stream through oversized bodies just to reject them. The normalizer still
// enforces its own cap when URLs / base64 inputs are used.
//
// Requests without a `Content-Length` (e.g. chunked transfer) are passed
// through — the body parser downstream is responsible for streaming caps
// in that case.

import type { MiddlewareHandler } from 'hono';
import { ImageTooLargeError } from '../../core/errors.js';
import type { AppEnv } from '../types.js';

export interface SizeLimitOptions {
  maxBytes: number;
}

export function sizeLimit(options: SizeLimitOptions): MiddlewareHandler<AppEnv> {
  const { maxBytes } = options;
  return async (c, next) => {
    const raw = c.req.header('content-length');
    if (raw !== undefined) {
      const declared = Number(raw);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ImageTooLargeError(
          `request body of ${declared} bytes exceeds limit of ${maxBytes} bytes`,
          { details: { maxBytes, declared } },
        );
      }
    }
    await next();
  };
}
