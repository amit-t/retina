import type { MiddlewareHandler } from 'hono';
import { ImageTooLargeError } from '../../core/errors.js';
import type { HonoEnv } from '../types.js';

export interface SizeLimitOptions {
  /** Maximum allowed body size in bytes. Mirrors `Config.MAX_IMAGE_BYTES`. */
  maxBytes: number;
}

/**
 * Reject requests whose declared `Content-Length` exceeds `maxBytes` before
 * any body buffering. This is a cheap gate against multi-GB payloads; the
 * streaming normalizer (R05) enforces the same cap during the read.
 *
 * Only applied to methods that carry a body (POST/PUT/PATCH). Non-numeric or
 * missing `Content-Length` is allowed through — streaming uploads must be
 * size-capped during consumption.
 */
export function sizeLimit(opts: SizeLimitOptions): MiddlewareHandler<HonoEnv> {
  const { maxBytes } = opts;
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const raw = c.req.header('content-length');
      if (raw !== undefined) {
        const declared = Number(raw);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new ImageTooLargeError('image too large', {
            details: { maxBytes, declared },
          });
        }
      }
    }
    await next();
  };
}
