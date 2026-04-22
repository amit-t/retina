/**
 * Size-limit middleware.
 *
 * Rejects requests whose advertised `Content-Length` exceeds `maxBytes`
 * (wired to `MAX_IMAGE_BYTES` in R13) by throwing `ImageTooLargeError`
 * *before* the body is buffered. This is the cheap, pre-buffering guard;
 * streaming enforcement for clients that omit `Content-Length` or lie about
 * it lives in `src/core/image.ts` (R05).
 */

import type { MiddlewareHandler } from 'hono';
import { ImageTooLargeError } from '../../core/errors';

/**
 * Build a Hono middleware that caps inbound request size using the
 * `Content-Length` header.
 *
 * @param maxBytes - maximum allowed body size in bytes (inclusive).
 */
export function sizeLimit(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('content-length');
    if (header !== undefined && header !== '') {
      const parsed = Number.parseInt(header, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        throw new ImageTooLargeError('Request body exceeds MAX_IMAGE_BYTES', {
          details: {
            contentLength: parsed,
            maxBytes,
          },
        });
      }
    }
    await next();
  };
}
