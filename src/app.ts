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
 *   - src/http/routes/templates.ts       (GET /v1/templates, GET /v1/templates/:id
 *                                          — template catalog; mounted only when
 *                                          `deps.templates` exposes `list()`, i.e.
 *                                          the R10 registry; R12a)
 *   - src/http/routes/analyze.ts         (POST /v1/analyze — unified task
 *                                          endpoint; mounted only when
 *                                          `deps.router` is supplied)
 *   - src/http/routes/jobs.ts            (POST /v1/jobs, GET /v1/jobs/:id —
 *                                          mounted only when `deps.jobStore`
 *                                          is supplied; R17)
 */

import { Hono } from 'hono';
import type { TaskRouter } from './core/tasks/describe';
import type { TemplateRegistry } from './core/tasks/extract';
import type { TemplateRegistry as FullTemplateRegistry } from './core/templates';
import { createErrorHandler, type ErrorMiddlewareLogger } from './http/middleware/error';
import { type RequestIdVariables, requestId } from './http/middleware/request-id';
import { sizeLimit } from './http/middleware/size-limit';
import { createAnalyzeRoute } from './http/routes/analyze';
import { createDescribeRoute } from './http/routes/describe';
import { createExtractRoute } from './http/routes/extract';
import { createHealthRoute, type RedisStatusProbe } from './http/routes/health';
import { createJobsRoute, createJobsStreamRoute } from './http/routes/jobs';
import { createOcrRoute } from './http/routes/ocr';
import { createTemplatesRoute } from './http/routes/templates';
import type { StreamJobStore } from './jobs/sse';
import type { JobStore } from './jobs/store';
import { buildLogger, type Logger } from './logger';

/** Default body cap (10 MiB) until R03 wires `config.MAX_IMAGE_BYTES`. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Default sync request deadline (30 s) until R13 wires `config.REQUEST_TIMEOUT_MS`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default SSE heartbeat cadence (15 s) until R13 wires `config.SSE_HEARTBEAT_MS`. */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

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
  config?: {
    MAX_IMAGE_BYTES?: number;
    REQUEST_TIMEOUT_MS?: number;
    SSE_HEARTBEAT_MS?: number;
    /** Configured provider names, surfaced on `GET /healthz`. */
    PROVIDERS?: readonly string[];
  };
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
  /** R14 `JobStore`. When supplied `buildApp()` mounts `/v1/jobs`
   *  (POST + GET /:id, R17) AND `/v1/jobs/:id/stream` (SSE, R18). */
  jobStore?: JobStore;
  /** ioredis client used by `GET /healthz` to report `redis: up|down`
   *  from the connection `status`. R13 wires the real ioredis instance;
   *  omission leaves the health route reporting `redis: "down"`. */
  redis?: RedisStatusProbe;
}

/**
 * Structural predicate: does the supplied registry expose the R10
 * `list()` method? The structural `TemplateRegistry` from `core/tasks/
 * extract.ts` only mandates `get()`; the R10 loader returns a registry
 * with both `list()` and a fuller `get()`. Mount the `/v1/templates`
 * catalog only when that fuller surface is present so narrower test
 * doubles remain zero-wiring.
 */
function hasListMethod(
  registry: TemplateRegistry,
): registry is TemplateRegistry & Pick<FullTemplateRegistry, 'list'> {
  return typeof (registry as { list?: unknown }).list === 'function';
}

/**
 * Adapt the canonical `JobStore` to the narrower `StreamJobStore` that
 * `createJobsStreamRoute` (R18) was authored against. The two differ only
 * in the `subscribe` return shape: the canonical store returns
 * `{ unsubscribe: () => Promise<void> }` while `StreamJobStore` expects
 * the unsubscribe callable directly. Flatten it here so R18's SSE route
 * works against R14's real store without touching either implementation.
 */
function adaptStreamStore(store: JobStore): StreamJobStore {
  return {
    get: (id) => store.get(id),
    subscribe: async (id, handler) => {
      // R18's `JobEvent` narrows `status` events to non-terminal statuses
      // (terminal states are separate `completed`/`failed` variants). R14
      // publishes `completed`/`failed` as those variant types too, so in
      // practice `status` events never carry a terminal status — but TS
      // can't prove this structurally. Cast the handler; runtime is safe
      // per the store contract (spec §Data flow › Async).
      const sub = await store.subscribe(
        id,
        handler as unknown as Parameters<JobStore['subscribe']>[1],
      );
      return () => sub.unsubscribe();
    },
  };
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
  const sseHeartbeatMs = deps.config?.SSE_HEARTBEAT_MS ?? DEFAULT_SSE_HEARTBEAT_MS;
  const logger = deps.logger ?? buildLogger('info');

  // 1. request-id — runs first so every downstream log/response carries it.
  app.use(requestId());

  // 2. size-limit — rejects oversized bodies before any route buffers them.
  app.use(sizeLimit(maxBytes));

  // 3. routes — /healthz always on; task routes mount only when their
  //    dependencies are supplied so unit tests that build a bare app
  //    without a router stay zero-wiring.
  app.route(
    '/',
    createHealthRoute({
      ...(deps.redis !== undefined ? { redis: deps.redis } : {}),
      ...(deps.config?.PROVIDERS !== undefined ? { providers: deps.config.PROVIDERS } : {}),
    }),
  );
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
  // Templates catalog (R12a) — provider-independent: mount as long as the
  // supplied registry exposes the full R10 surface (`list()` + fuller
  // `get()`). Test harnesses that pass a narrower `{get}`-only double
  // (route-extract.spec, analyze spec) silently skip this route so their
  // wiring remains zero-router.
  if (deps.templates !== undefined && hasListMethod(deps.templates)) {
    app.route(
      '/',
      createTemplatesRoute({ templates: deps.templates as unknown as FullTemplateRegistry }),
    );
  }
  if (deps.jobStore !== undefined) {
    app.route('/', createJobsRoute({ store: deps.jobStore, maxBytes }));
    app.route(
      '/',
      createJobsStreamRoute({
        store: adaptStreamStore(deps.jobStore),
        heartbeatMs: sseHeartbeatMs,
      }),
    );
  }

  // 4. error — terminal catch that converts thrown errors to JSON envelopes.
  app.onError(createErrorHandler({ logger }));

  return app;
}
