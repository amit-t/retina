import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../src/http/context.ts';
import { registerHealthRoute } from '../../../src/http/routes/health.ts';

function buildApp(deps?: Parameters<typeof registerHealthRoute>[1]) {
  const app = new Hono<AppEnv>();
  registerHealthRoute(app, deps);
  return app;
}

describe('GET /healthz', () => {
  it('returns the MVP stub shape by default', async () => {
    const app = buildApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redis: 'down', providers: {} });
  });

  it('reports provided redis status and providers', async () => {
    const app = buildApp({
      redisStatus: () => 'up',
      providers: () => ({ openai: 'configured' }),
    });
    const res = await app.request('/healthz');
    expect(await res.json()).toEqual({
      ok: true,
      redis: 'up',
      providers: { openai: 'configured' },
    });
  });
});
