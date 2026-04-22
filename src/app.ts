// `buildApp(deps)` composes the Hono application. Middleware order matches
// the spec's sync request flow (§Data flow): request-id → size-limit →
// routes → error.
//
// Route registrars for `/v1/describe`, `/v1/ocr`, `/v1/extract`,
// `/v1/analyze`, `/v1/templates`, `/v1/jobs` are added by later tasks
// (R08–R18). This task only wires `/healthz`.

import { Hono } from 'hono';
import type { AppEnv } from './http/context.js';
import { registerErrorHandler } from './http/middleware/error.js';
import { requestIdMiddleware } from './http/middleware/request-id.js';
import { sizeLimitMiddleware } from './http/middleware/size-limit.js';
import { type HealthDeps, registerHealthRoute } from './http/routes/health.js';
import type { Logger } from './logger.js';

export interface BuildAppDeps {
  logger: Logger;
  maxImageBytes: number;
  health?: HealthDeps;
}

export function buildApp(deps: BuildAppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Middleware order per spec §Data flow: request-id → size-limit → routes
  // → error. The error stage is installed via `app.onError()` (not a
  // `app.use()` middleware) because Hono's composer catches thrown errors
  // before they reach user middleware.
  app.use('*', requestIdMiddleware());
  app.use('*', async (c, next) => {
    c.set('logger', deps.logger);
    await next();
  });
  app.use('*', sizeLimitMiddleware({ maxBytes: deps.maxImageBytes }));

  registerHealthRoute(app, deps.health);

  registerErrorHandler(app, { logger: deps.logger });

  return app;
}
