// Attach and echo `x-request-id`.
//
// - If the caller supplies `x-request-id`, use it (and echo it back).
// - Otherwise generate a uuid v4 via `crypto.randomUUID` (Node 20+ built-in).
//
// The request id is stored on the Hono context as `requestId` so downstream
// middleware (notably the error envelope) and route handlers can surface it
// without re-parsing headers.

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
    c.set('requestId', id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}
