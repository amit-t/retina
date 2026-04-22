import { Hono } from 'hono';
import { errorHandler } from './http/middleware/error.js';
import { requestId } from './http/middleware/request-id.js';
import { sizeLimit } from './http/middleware/size-limit.js';
import { registerHealthRoute } from './http/routes/health.js';
import type { HonoEnv } from './http/types.js';
import type { Logger } from './logger.js';

export interface BuildAppDeps {
  logger: Logger;
  /** Maximum body size in bytes. Mirrors `Config.MAX_IMAGE_BYTES`. */
  maxImageBytes: number;
}

/**
 * Compose the HTTP application.
 *
 * Middleware order (R02 skeleton):
 *   request-id → size-limit → routes → error
 *
 * Later tasks mount additional routes before the error handler:
 *   R08 /v1/describe, R09 /v1/ocr, R11 /v1/extract, R12 /v1/analyze + templates,
 *   R17 /v1/jobs*, R18 /v1/jobs/:id/stream.
 */
export function buildApp(deps: BuildAppDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.use('*', requestId({ logger: deps.logger }));
  app.use('*', sizeLimit({ maxBytes: deps.maxImageBytes }));

  registerHealthRoute(app);

  app.onError(errorHandler({ logger: deps.logger }));

  return app;
}
