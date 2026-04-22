import type { Hono } from 'hono';
import type { HonoEnv } from '../types.js';

/**
 * Shape of the `/healthz` response. Kept as a named type so R14 can extend
 * it when a real Redis probe is wired in.
 */
export interface HealthResponse {
  ok: boolean;
  redis: 'up' | 'down';
  providers: Record<string, 'up' | 'down'>;
}

/**
 * Registrar for the `/healthz` endpoint. R02 ships a stub (`redis: "down"`,
 * empty providers); R14 replaces the body with real probes.
 */
export function registerHealthRoute(app: Hono<HonoEnv>): void {
  app.get('/healthz', (c) => {
    const body: HealthResponse = {
      ok: true,
      redis: 'down',
      providers: {},
    };
    return c.json(body);
  });
}
