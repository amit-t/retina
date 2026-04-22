import { describe, expect, it } from 'vitest';
import { buildApp } from '../../../../src/app.js';
import type { HealthResponse } from '../../../../src/http/routes/health.js';
import { silentLogger } from '../../helpers.js';

describe('GET /healthz', () => {
  it('returns the MVP healthz stub shape', async () => {
    const app = buildApp({ logger: silentLogger(), maxImageBytes: 1024 });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({ ok: true, redis: 'down', providers: {} });
  });

  it('echoes the request id through the health endpoint', async () => {
    const app = buildApp({ logger: silentLogger(), maxImageBytes: 1024 });
    const res = await app.request('/healthz', {
      headers: { 'x-request-id': 'health-probe-1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('health-probe-1');
  });
});
