// R20 — Vitest globalSetup for the e2e project.
//
// Responsibilities (per .ralph/fix_plan.md R20):
//
//   1. Start a throwaway Redis via `@testcontainers/redis` so every run gets
//      a clean instance with no cross-run state bleed.
//   2. Build the Retina Hono app via `buildApp()` and attach it to a Node
//      HTTP server via `@hono/node-server` bound to a random free port
//      (port=0). The OS assigns the port, we read it from `server.address()`
//      so parallel CI workers never collide.
//   3. Export the chosen base URL and Redis URL via process env so the
//      lifecycle spec (and any future e2e specs) can reach the running
//      server without module-level singletons.
//
// Return value is the teardown function vitest calls after all tests in the
// e2e project finish — it closes the HTTP server and stops the Redis
// container. Vitest also calls it on Ctrl-C, so we never leak containers.
//
// R20's spec file (jobs-lifecycle.spec.ts) can only exercise the full
// asynchronous pipeline once R13 / R14 / R15 / R16 / R17 / R18 have landed.
// Until then, this setup still boots Redis + Hono so the infrastructure is
// verified, and the spec gates itself on the presence of /v1/jobs via
// `RETINA_E2E_JOBS_READY` (set below by probing the live server).

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { buildApp } from '../../src/app.ts';

/** Env vars the spec file reads. Names are namespaced under RETINA_E2E_*
 *  so they don't collide with production env vars a developer may already
 *  have set (REDIS_URL, PORT, etc.). */
export const E2E_BASE_URL_ENV = 'RETINA_E2E_BASE_URL';
export const E2E_REDIS_URL_ENV = 'RETINA_E2E_REDIS_URL';
export const E2E_JOBS_READY_ENV = 'RETINA_E2E_JOBS_READY';

/** Redis image pin: redis:7-alpine keeps parity with docker-compose.test.yml
 *  (R23) and CI's `services: redis` block (R24). Upgrading Redis must be a
 *  deliberate, documented change. */
const REDIS_IMAGE = 'redis:7-alpine';

/** Bind address. 127.0.0.1 (not 0.0.0.0) keeps the ephemeral server off the
 *  LAN even on misconfigured dev boxes. */
const BIND_HOST = '127.0.0.1';

/** Harmless path guaranteed not to match an existing route. Used for the
 *  readiness probe below — if Hono returns 404 we know the jobs router is
 *  absent; any other status means R17/R18 landed and a jobs route is live. */
const JOBS_PROBE_PATH = '/v1/jobs/__e2e_probe__';

/** Vitest's default globalSetup signature: return a teardown function (or
 *  a Promise of one). Vitest awaits it after the whole project finishes. */
export type Teardown = () => Promise<void> | void;

/**
 * Start Redis + Hono once per e2e run.
 *
 * Side effects (documented so the spec file can rely on them):
 *   - process.env[RETINA_E2E_REDIS_URL] — redis://<host>:<port>
 *   - process.env[RETINA_E2E_BASE_URL]  — http://127.0.0.1:<port>
 *   - process.env[RETINA_E2E_JOBS_READY] — "true" | "false"
 */
export default async function setup(): Promise<Teardown> {
  const redisContainer = await startRedis();
  const redisUrl = redisContainer.getConnectionUrl();
  process.env[E2E_REDIS_URL_ENV] = redisUrl;

  const { server, baseUrl } = await startHono();
  process.env[E2E_BASE_URL_ENV] = baseUrl;

  // Deps-ready probe: if /v1/jobs isn't mounted (R17 not landed yet), the
  // lifecycle spec has nothing to test. We still want globalSetup to succeed
  // so the e2e project boots; the spec decides per-suite whether to skip.
  const jobsReady = await probeJobsRoute(baseUrl);
  process.env[E2E_JOBS_READY_ENV] = jobsReady ? 'true' : 'false';

  return async () => {
    await closeServer(server);
    await redisContainer.stop();
    // Leaving env vars set would leak state across `vitest run` invocations
    // inside the same Node process (e.g. --watch). Clear them so reboots
    // start from a known state.
    delete process.env[E2E_BASE_URL_ENV];
    delete process.env[E2E_REDIS_URL_ENV];
    delete process.env[E2E_JOBS_READY_ENV];
  };
}

// ---------------------------------------------------------------------------
// Internals — exported for reuse from test/live/setup.ts (R21) which mirrors
// this file minus the Redis container and MockAgent wiring.
// ---------------------------------------------------------------------------

async function startRedis(): Promise<StartedRedisContainer> {
  // withStartupTimeout is on the underlying GenericContainer; 60 s is well
  // above the image-pull + boot time on a cold CI runner (~10-20 s typical).
  return new RedisContainer(REDIS_IMAGE).withStartupTimeout(60_000).start();
}

async function startHono(): Promise<{ server: ServerType; baseUrl: string }> {
  // Pass-through of the current buildApp() output: once R13 assembles the
  // full dep graph (config, logger, router, templates, jobStore) the e2e
  // harness will be swapped to call that assembler instead of buildApp()
  // directly. For now, buildApp() exposes /healthz + /v1/describe + /v1/ocr
  // (when a router is supplied). The lifecycle spec gates itself on the
  // presence of /v1/jobs so skipping stays clean.
  const app = buildApp();

  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: BIND_HOST },
      (info: AddressInfo) => {
        resolve({
          server,
          baseUrl: `http://${BIND_HOST}:${info.port}`,
        });
      },
    );
    server.once('error', reject);
  });
}

async function probeJobsRoute(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${JOBS_PROBE_PATH}`, { method: 'GET' });
    // 404 means the route tree has no /v1/jobs branch; anything else (even
    // 4xx validation errors) means the router is mounted and the spec can
    // try to exercise it.
    return res.status !== 404;
  } catch {
    return false;
  }
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
