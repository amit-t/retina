// `GET /healthz` — liveness + rudimentary dependency reporting.
//
// MVP: redis defaults to "down" and `providers` is empty; the real
// probe + configured provider map are wired in R13/R14.

import type { Hono } from 'hono';
import type { AppEnv } from '../context.js';

export interface HealthDeps {
  redisStatus?: () => 'up' | 'down';
  providers?: () => Record<string, 'configured'>;
}

export function registerHealthRoute(app: Hono<AppEnv>, deps: HealthDeps = {}): void {
  app.get('/healthz', (c) => {
    const redis = deps.redisStatus ? deps.redisStatus() : ('down' as const);
    const providers = deps.providers ? deps.providers() : {};
    return c.json({ ok: true, redis, providers });
  });
}
