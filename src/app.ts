/**
 * Retina HTTP application composition root.
 *
 * `buildApp(deps)` returns a Hono app with middleware composed in order:
 *
 *     request-id → size-limit → routes → error
 *
 * This file owns the composition only. The dedicated modules land in later
 * R02 sub-tasks and will be imported here once they exist:
 *
 *   - src/http/middleware/request-id.ts  (attach/echo x-request-id)
 *   - src/http/middleware/size-limit.ts  (reject over MAX_IMAGE_BYTES)
 *   - src/http/middleware/error.ts       (RetinaError → JSON envelope)
 *   - src/http/routes/health.ts          (GET /healthz)
 *
 * Until those are created, minimal inline placeholders keep the app
 * self-contained so the repo stays typecheck- and lint-clean.
 */

import { type Handler, Hono, type MiddlewareHandler } from 'hono';

/**
 * Dependencies wired into the app at bootstrap (R13).
 *
 * All fields are optional today because this task only defines the
 * composition surface; the concrete types are introduced by later tasks:
 *   - `config`    — R03 (`loadConfig()` → `Config`)
 *   - `logger`    — R02 sub-task `src/logger.ts` (pino instance)
 *   - `router`    — R06 (`ProviderRouter`)
 *   - `templates` — R10 (`TemplateRegistry`)
 *   - `jobStore`  — R14 (`JobStore`, used by /v1/jobs routes in R17+)
 */
export interface BuildAppDeps {
  config?: unknown;
  logger?: unknown;
  router?: unknown;
  templates?: unknown;
  jobStore?: unknown;
}

/** Hono context variables set by this app's middleware. */
export interface AppVariables {
  requestId: string;
}

/** Hono generics tag for the Retina app. Exported so middleware/route
 * modules added in later sub-tasks can match the same context shape. */
export type AppEnv = { Variables: AppVariables };

/**
 * Placeholder request-id middleware.
 *
 * TODO(R02 sub-task): replace with `import { requestId } from
 * './http/middleware/request-id'` once `src/http/middleware/request-id.ts`
 * lands. The dedicated module will generate a uuid v4 when absent; this
 * stub uses the platform `crypto.randomUUID()` so the contract
 * (`c.get('requestId')` is always set, `x-request-id` header always
 * echoed) holds in the interim.
 */
const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  await next();
};

/**
 * Placeholder size-limit middleware.
 *
 * TODO(R02 sub-task): replace with `import { sizeLimit } from
 * './http/middleware/size-limit'`. The dedicated module will reject with
 * `ImageTooLargeError` when `Content-Length > config.MAX_IMAGE_BYTES`
 * before any route buffers the body.
 */
const sizeLimitMiddleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

/**
 * Placeholder error handler.
 *
 * TODO(R02 sub-task): replace with the dedicated handler from
 * `./http/middleware/error`, which shapes `RetinaError` subclasses into
 * `{ error: { code, message, requestId, details } }` with the proper
 * `status`, and maps unknown errors to `InternalError` 500 with the
 * stack logged via the injected pino logger.
 */
const errorHandler = (err: Error, c: Parameters<Parameters<Hono<AppEnv>['onError']>[0]>[1]) => {
  const requestId = c.get('requestId');
  return c.json(
    {
      error: {
        code: 'internal_error',
        message: err.message,
        requestId: requestId ?? null,
      },
    },
    500,
  );
};

/**
 * Placeholder /healthz handler.
 *
 * TODO(R02 sub-task): replace with `import { healthRoute } from
 * './http/routes/health'`. The dedicated route will return the real
 * shape `{ ok, redis, providers }`; R14 upgrades `redis` to reflect the
 * live ioredis client status.
 */
const healthzHandler: Handler<AppEnv> = (c) => c.json({ ok: true, redis: 'down', providers: {} });

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
export function buildApp(_deps: BuildAppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 1. request-id — runs first so every downstream log/response carries it.
  app.use(requestIdMiddleware);

  // 2. size-limit — rejects oversized bodies before any route buffers them.
  app.use(sizeLimitMiddleware);

  // 3. routes — /healthz is the only route at R02; R08–R18 mount the rest.
  app.get('/healthz', healthzHandler);

  // 4. error — terminal catch that converts thrown errors to JSON envelopes.
  app.onError(errorHandler);

  return app;
}
