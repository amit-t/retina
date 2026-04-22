// Hono app composition.
//
// Middleware order (kept stable; routes and tests depend on it):
//   1. request-id  — stamp + echo `x-request-id` before anything else so
//                    every log line and every error envelope has a correlator.
//   2. size-limit  — pre-flight `Content-Length` cap against `MAX_IMAGE_BYTES`.
//   3. routes      — healthz (R02), then per-task + jobs routes (R08+).
//   4. onError     — uniform envelope mapper.
//
// R02 only wires healthz. Later tasks extend the registrar surface; the
// composition order here is the contract.

import { Hono } from 'hono';
import { errorHandler } from './http/middleware/error.js';
import { requestId } from './http/middleware/request-id.js';
import { sizeLimit } from './http/middleware/size-limit.js';
import { registerHealthRoutes } from './http/routes/health.js';
import type { AppEnv } from './http/types.js';
import type { Logger } from './logger.js';

export interface BuildAppDeps {
  logger: Logger;
  maxImageBytes: number;
}

export function buildApp(deps: BuildAppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.use('*', sizeLimit({ maxBytes: deps.maxImageBytes }));

  registerHealthRoutes(app);

  app.onError(errorHandler({ logger: deps.logger }));

  return app;
}
