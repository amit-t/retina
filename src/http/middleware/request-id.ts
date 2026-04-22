// Request-id middleware for Hono.
//
// Contract (spec §API contracts): responses always carry `x-request-id`,
// echoed from the request if provided, generated otherwise. The resolved
// value is also bound onto the Hono context so downstream handlers, the
// logger, and the error envelope can read it via `c.get('requestId')`.

import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

/** Canonical header name for the request id. HTTP headers are case-insensitive
 *  but the spec standardises on lowercase so we do too. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Variables contributed to the Hono context by this middleware. */
export type RequestIdVariables = {
  requestId: string;
};

export type RequestIdOptions = {
  /** Override the header name. Defaults to `x-request-id`. */
  headerName?: string;
  /** Override the generator. Defaults to UUID v4 via `node:crypto.randomUUID`. */
  generator?: (c: Context) => string;
};

/**
 * Create the request-id Hono middleware.
 *
 * - If the incoming request carries a non-empty value for the header, that
 *   value is echoed back on the response and bound onto the context.
 * - Otherwise a fresh UUID v4 is generated and used for both.
 */
export const requestId = (
  options: RequestIdOptions = {},
): MiddlewareHandler<{ Variables: RequestIdVariables }> => {
  const headerName = options.headerName ?? REQUEST_ID_HEADER;
  const generator = options.generator ?? (() => randomUUID());

  return async (c, next) => {
    const incoming = c.req.header(headerName);
    const reqId = incoming && incoming.length > 0 ? incoming : generator(c);

    c.set('requestId', reqId);
    c.header(headerName, reqId);

    await next();
  };
};
