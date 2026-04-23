/**
 * Retina HTTP application composition root.
 *
 * `buildApp(deps)` returns a Hono app with middleware composed in order:
 *
 *     request-id → size-limit → routes → error
 *
 * This file owns the composition only. Individual behaviors live in their
 * dedicated modules and are imported here:
 *
 *   - src/http/middleware/request-id.ts  (attach/echo x-request-id)
 *   - src/http/middleware/size-limit.ts  (reject over MAX_IMAGE_BYTES)
 *   - src/http/middleware/error.ts       (RetinaError → JSON envelope)
 *   - src/http/routes/health.ts          (GET /healthz)
 */

import { Hono } from 'hono';
import type { TaskRouter } from './core/tasks/ocr';
import { createErrorHandler, type ErrorMiddlewareLogger } from './http/middleware/error';
import { type RequestIdVariables, requestId } from './http/middleware/request-id';
import { sizeLimit } from './http/middleware/size-limit';
import { createHealthRoute } from './http/routes/health';
import { createOcrRoute } from './http/routes/ocr';
import { buildLogger, type Logger } from './logger';

/** Default body cap (10 MiB) until R03 wires `config.MAX_IMAGE_BYTES`. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Dependencies wired into the app at bootstrap (R13).
 *
 * Most fields are optional today because only R02 sub-tasks exist; the
 * concrete types are introduced by later tasks:
 *   - `config`    — R03 (`loadConfig()` → `Config`)
 *   - `logger`    — R02 sub-task `src/logger.ts` (pino instance)
 *   - `router`    — R06 (`ProviderRouter`)
 *   - `templates` — R10 (`TemplateRegistry`)
 *   - `jobStore`  — R14 (`JobStore`, used by /v1/jobs routes in R17+)
 */
export interface BuildAppDeps {
  config?: { MAX_IMAGE_BYTES?: number };
  logger?: Logger | ErrorMiddlewareLogger;
  /** R06c `ProviderRouter` (or any structural `TaskRouter`). When omitted the
   *  routes that need a router (e.g. `/v1/ocr`) are not mounted, keeping
   *  /healthz-only test harnesses self-contained. */
  router?: TaskRouter;
  templates?: unknown;
  jobStore?: unknown;
}

/** Hono context variables set by this app's middleware. */
export type AppVariables = RequestIdVariables;

/** Hono generics tag for the Retina app. Exported so middleware/route
 * modules added in later sub-tasks can match the same context shape. */
export type AppEnv = { Variables: AppVariables };

/**
 * Build the Retina Hono application.
 *
 * Middleware is registered in the documented order so request flow is:
 *
 *   request → request-id → size-limit → route handler
 *                                         ↓
 *           (thrown RetinaError or unknown error bubbles up)
 *                                         ↓
 *                                    app.onError → JSON envelope
 *
 * Hono's `app.onError` is the idiomatic terminal catch — it wraps every
 * handler and middleware above, matching the conceptual "error at the
 * end" position in the pipeline.
 */
export function buildApp(deps: BuildAppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const maxBytes = deps.config?.MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES;
  const logger = deps.logger ?? buildLogger('info');

  // 1. request-id — runs first so every downstream log/response carries it.
  app.use(requestId());

  // 2. size-limit — rejects oversized bodies before any route buffers them.
  app.use(sizeLimit(maxBytes));

  // 3. routes — /healthz is unconditional; /v1/ocr (R09) mounts when a
  //    router dep is supplied. R08/R11/R12/R17 mount their routes here too
  //    as they land, each behind the presence of the dep they need.
  app.route('/', createHealthRoute());
  if (deps.router !== undefined) {
    app.route('/', createOcrRoute({ router: deps.router, maxBytes: maxBytes }));
  }

  // 4. error — terminal catch that converts thrown errors to JSON envelopes.
  app.onError(createErrorHandler({ logger }));

  return app;
}
