import type { Logger } from '../logger.js';

/**
 * Shared Hono app environment. All middleware and routes should type their
 * Hono context with `Hono<HonoEnv>` so `c.get('requestId')` and
 * `c.get('logger')` are strongly typed end-to-end.
 */
export type HonoEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
  };
};

export const REQUEST_ID_HEADER = 'x-request-id';
