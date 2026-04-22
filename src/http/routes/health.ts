// GET /healthz
//
// MVP stub per R02: always returns `{ok: true, redis: "down", providers: {}}`.
// R14 replaces this with a real Redis probe + provider readiness. The stable
// fields (`ok`, `redis`, `providers`) are locked now so ALB and docker
// HEALTHCHECKs can rely on the shape throughout the upgrade path.

import type { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export interface HealthResponse {
  ok: boolean;
  redis: 'up' | 'down';
  providers: Record<string, 'up' | 'down'>;
}

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.get('/healthz', (c) => {
    const body: HealthResponse = {
      ok: true,
      redis: 'down',
      providers: {},
    };
    return c.json(body);
  });
}
