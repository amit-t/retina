// Reject requests whose `Content-Length` exceeds `MAX_IMAGE_BYTES` *before*
// we buffer the body. The streaming cap inside the image normalizer (R05) is
// the final enforcement; this middleware is a cheap early reject for clients
// that honestly declare the payload size.

import { createMiddleware } from 'hono/factory';
import { ImageTooLargeError } from '../../core/errors.js';
import type { AppEnv } from '../context.js';

export interface SizeLimitOptions {
  maxBytes: number;
}

export function sizeLimitMiddleware(opts: SizeLimitOptions) {
  const { maxBytes } = opts;
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('content-length');
    if (header !== undefined) {
      const declared = Number.parseInt(header, 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ImageTooLargeError(`content-length ${declared} exceeds limit ${maxBytes}`, {
          details: { declared, maxBytes },
        });
      }
    }
    await next();
  });
}
