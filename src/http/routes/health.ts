// GET /healthz — liveness/readiness probe.
//
// Stub implementation (task R02). R14 replaces the hard-coded `redis: "down"`
// with a real `PING` against the configured Redis connection and populates
// `providers` from the loaded config. The response shape must stay:
//
//   { ok: boolean; redis: "up" | "down"; providers: Record<string, "configured"> }
//
// See spec §`GET /healthz` in docs/superpowers/specs/2026-04-21-retina-image-api-design.md.
import { Hono } from 'hono';

export type RedisStatus = 'up' | 'down';
export type ProviderStatus = 'configured';

export interface HealthResponse {
  ok: boolean;
  redis: RedisStatus;
  providers: Record<string, ProviderStatus>;
}

/**
 * Build the health route. Exposed as a factory so R14 can pass in a Redis
 * client (and a provider list) without changing call sites.
 */
export function createHealthRoute(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => {
    const body: HealthResponse = {
      ok: true,
      redis: 'down',
      providers: {},
    };
    return c.json(body);
  });

  return app;
}
