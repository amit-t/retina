import { describe, expect, it } from 'vitest';
import { createHealthRoute, type HealthResponse } from '../../../../src/http/routes/health.ts';

describe('GET /healthz (stub)', () => {
  it('returns 200 with the stubbed health envelope', async () => {
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
});
