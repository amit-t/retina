// GET /healthz — liveness/readiness probe.
//
// Shape (spec §`GET /healthz`):
//
//   { ok: boolean; redis: "up" | "down"; providers: Record<string, "configured"> }
//
// R02f established the stub (`redis: "down"`, empty providers). R14
// upgrades the route to:
//   - derive `redis` from the injected ioredis client's `status` field
//     (`"ready"` → `"up"`; every other state → `"down"`),
//   - populate `providers` from the configured `PROVIDERS` env list so
//     operators can verify all expected providers loaded.
//
// The redis probe is intentionally passive (no PING) — `/healthz` must
// stay cheap enough for ALB health checks, and ioredis already tracks
// the connection state on the client. Callers that want a stronger
// probe can issue PING themselves upstream.
import { Hono } from 'hono';

export type RedisStatus = 'up' | 'down';
export type ProviderStatus = 'configured';

export interface HealthResponse {
  ok: boolean;
  redis: RedisStatus;
  providers: Record<string, ProviderStatus>;
}

/** Structural slice of ioredis used by the health route. Keeping this a
 *  loose `{ status?: string }` means the route has no hard dependency on
 *  the ioredis package — the real client (R13) and test doubles both
 *  satisfy it. */
export interface RedisStatusProbe {
  status?: string;
}

export interface HealthRouteDeps {
  /** ioredis client (or any `{ status }`-shaped probe). When omitted the
   *  route keeps reporting `redis: "down"` so R02f unit tests still pass. */
  redis?: RedisStatusProbe;
  /** Configured provider names (from `config.PROVIDERS`). Each becomes a
   *  `providers[name] = "configured"` entry in the response. */
  providers?: readonly string[];
}

/**
 * Build the health route. Exposed as a factory so the bootstrap (R13)
 * can pass in a Redis client + provider list without the route handler
 * reaching into module scope.
 */
export function createHealthRoute(deps: HealthRouteDeps = {}): Hono {
  const app = new Hono();
  const providers = buildProvidersMap(deps.providers);

  app.get('/healthz', (c) => {
    const body: HealthResponse = {
      ok: true,
      redis: probeRedis(deps.redis),
      providers,
    };
    return c.json(body);
  });

  return app;
}

/** Map ioredis's `status` field onto the wire `"up" | "down"` shape.
 *  ioredis's status progresses `wait` → `connecting` → `connect` → `ready`
 *  during a normal lifecycle; only `"ready"` means commands will succeed. */
function probeRedis(redis: RedisStatusProbe | undefined): RedisStatus {
  if (redis === undefined) return 'down';
  return redis.status === 'ready' ? 'up' : 'down';
}

function buildProvidersMap(
  providers: readonly string[] | undefined,
): Record<string, ProviderStatus> {
  if (providers === undefined) return {};
  const out: Record<string, ProviderStatus> = {};
  for (const name of providers) {
    out[name] = 'configured';
  }
  return out;
}
