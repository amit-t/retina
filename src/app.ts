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
 *   - src/http/routes/describe.ts        (POST /v1/describe — mounted
 *                                          only when `deps.router` is supplied)
 *   - src/http/routes/ocr.ts             (POST /v1/ocr — mounted only when
 *                                          `deps.router` is supplied)
 *   - src/http/routes/extract.ts         (POST /v1/extract — mounted only when
 *                                          both `deps.router` AND
 *                                          `deps.templates` are supplied)
 *   - src/http/routes/analyze.ts         (POST /v1/analyze — unified task
 *                                          endpoint; mounted only when
 *                                          `deps.router` is supplied)
 */

import { Hono } from 'hono';
import type { TaskRouter } from './core/tasks/describe';
import type { TemplateRegistry } from './core/tasks/extract';
import { createErrorHandler, type ErrorMiddlewareLogger } from './http/middleware/error';
import { type RequestIdVariables, requestId } from './http/middleware/request-id';
import { sizeLimit } from './http/middleware/size-limit';
import { createAnalyzeRoute } from './http/routes/analyze';
import { createDescribeRoute } from './http/routes/describe';
import { createExtractRoute } from './http/routes/extract';
import { createHealthRoute } from './http/routes/health';
import { createOcrRoute } from './http/routes/ocr';
import { buildLogger, type Logger } from './logger';

/** Default body cap (10 MiB) until R03 wires `config.MAX_IMAGE_BYTES`. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Default sync request deadline (30 s) until R13 wires `config.REQUEST_TIMEOUT_MS`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  config?: { MAX_IMAGE_BYTES?: number; REQUEST_TIMEOUT_MS?: number };
  logger?: Logger | ErrorMiddlewareLogger;
  /** R06c `ProviderRouter` (or any structural `TaskRouter`). When omitted the
   *  routes that need a router (e.g. `/v1/describe`, `/v1/ocr`, `/v1/analyze`)
   *  are not mounted, keeping /healthz-only test harnesses self-contained. */
  router?: TaskRouter;
  /** R10 `TemplateRegistry`. Only the dedicated `/v1/extract` route (R11)
   *  and the `extract` branch of `/v1/analyze` (R12b) read it; optional here
   *  so test harnesses that never exercise those paths don't need one. When
   *  supplied alongside `router`, `/v1/extract` is also mounted. */
  templates?: TemplateRegistry;
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
  const requestTimeoutMs = deps.config?.REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logger = deps.logger ?? buildLogger('info');

  // 1. request-id — runs first so every downstream log/response carries it.
  app.use(requestId());

  // 2. size-limit — rejects oversized bodies before any route buffers them.
  app.use(sizeLimit(maxBytes));

  // 3. routes — /healthz always on; task routes mount only when their
  //    dependencies are supplied so unit tests that build a bare app
  //    without a router stay zero-wiring.
  app.route('/', createHealthRoute());
  if (deps.router !== undefined) {
    app.route(
      '/',
      createDescribeRoute({
        router: deps.router,
        config: { MAX_IMAGE_BYTES: maxBytes, REQUEST_TIMEOUT_MS: requestTimeoutMs },
      }),
    );
    app.route('/', createOcrRoute({ router: deps.router, maxBytes }));
    if (deps.templates !== undefined) {
      app.route(
        '/',
        createExtractRoute({
          router: deps.router,
          templates: deps.templates,
          config: { MAX_IMAGE_BYTES: maxBytes, REQUEST_TIMEOUT_MS: requestTimeoutMs },
        }),
      );
    }
    app.route(
      '/',
      createAnalyzeRoute({
        router: deps.router,
        config: { MAX_IMAGE_BYTES: maxBytes, REQUEST_TIMEOUT_MS: requestTimeoutMs },
        ...(deps.templates !== undefined ? { templates: deps.templates } : {}),
      }),
    );
  }

  // 4. error — terminal catch that converts thrown errors to JSON envelopes.
  app.onError(createErrorHandler({ logger }));

  return app;
}
