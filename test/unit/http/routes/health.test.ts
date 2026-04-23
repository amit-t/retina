import { describe, expect, it } from 'vitest';
import { createHealthRoute, type HealthResponse } from '../../../../src/http/routes/health.ts';

describe('GET /healthz', () => {
  it('returns 200 with redis=down when no redis client is wired (R02f stub path)', async () => {
    const app = createHealthRoute();

    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({
      ok: true,
      redis: 'down',
      providers: {},
    });
  });

  it('responds with application/json', async () => {
    const app = createHealthRoute();

    const res = await app.request('/healthz');

    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  });

  it('reports redis=up when the injected client.status is "ready" (R14)', async () => {
    const app = createHealthRoute({ redis: { status: 'ready' } });

    const res = await app.request('/healthz');
    const body = (await res.json()) as HealthResponse;

    expect(body.redis).toBe('up');
  });

  it('reports redis=down for every non-ready ioredis status', async () => {
    // ioredis exposes: wait | connecting | connect | ready | close |
    // reconnecting | end. Only `ready` is operational.
    const nonReadyStates = ['wait', 'connecting', 'connect', 'close', 'reconnecting', 'end'];

    for (const status of nonReadyStates) {
      const app = createHealthRoute({ redis: { status } });
      const res = await app.request('/healthz');
      const body = (await res.json()) as HealthResponse;
      expect(body.redis, `status=${status} should map to down`).toBe('down');
    }
  });

  it('reports redis=down when status is undefined (early boot, pre-connect)', async () => {
    const app = createHealthRoute({ redis: {} });

    const res = await app.request('/healthz');
    const body = (await res.json()) as HealthResponse;

    expect(body.redis).toBe('down');
  });

  it('populates providers map from the configured list', async () => {
    const app = createHealthRoute({ providers: ['openai', 'anthropic', 'google', 'bedrock'] });

    const res = await app.request('/healthz');
    const body = (await res.json()) as HealthResponse;

    expect(body.providers).toEqual({
      openai: 'configured',
      anthropic: 'configured',
      google: 'configured',
      bedrock: 'configured',
    });
  });

  it('returns empty providers map when no providers are supplied', async () => {
    const app = createHealthRoute({ redis: { status: 'ready' } });

    const res = await app.request('/healthz');
    const body = (await res.json()) as HealthResponse;

    expect(body.providers).toEqual({});
  });
});
