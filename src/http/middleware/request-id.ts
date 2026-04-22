// Attach and echo `x-request-id`. Generates a uuid v4 when the client did not
// supply one and always mirrors the value back on the response header so the
// client can correlate logs/traces.

import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context.js';

const HEADER = 'x-request-id';

export function requestIdMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header(HEADER);
    const id = incoming && incoming.length > 0 ? incoming : randomUUID();
    c.set('requestId', id);
    c.header(HEADER, id);
    await next();
    // Re-assert after the handler runs in case a downstream middleware
    // replaced response headers (e.g. on an error response built via
    // `c.json(...)`).
    c.header(HEADER, id);
  });
}
