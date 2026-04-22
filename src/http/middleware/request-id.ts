import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../../logger.js';
import { type HonoEnv, REQUEST_ID_HEADER } from '../types.js';

export interface RequestIdOptions {
  /** Base logger that every request will be derived from via `.child({requestId})`. */
  logger: Logger;
}

/**
 * Attach or echo the `x-request-id` header.
 *
 * - Incoming header is trusted when present (caller-supplied trace id).
 * - Missing header → generate a uuid v4.
 * - The id is bound into the Hono context as `requestId` and also exposed on
 *   a child logger as `logger` so downstream code can log with request scope.
 * - The response always echoes the final id in `x-request-id`.
 */
export function requestId(opts: RequestIdOptions): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
    c.set('requestId', id);
    c.set('logger', opts.logger.child({ requestId: id }));
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}
