import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../src/http/context.ts';
import { requestIdMiddleware } from '../../../src/http/middleware/request-id.ts';

function buildProbeApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requestIdMiddleware());
  app.get('/probe', (c) => c.json({ requestId: c.var.requestId }));
  return app;
}

describe('requestIdMiddleware', () => {
  it('echoes an incoming x-request-id header', async () => {
    const app = buildProbeApp();
    const res = await app.request('/probe', {
      headers: { 'x-request-id': 'client-123' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('client-123');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe('client-123');
  });

  it('generates a uuid when no header is supplied', async () => {
    const app = buildProbeApp();
    const res = await app.request('/probe');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(id);
  });

  it('treats an empty x-request-id header as missing', async () => {
    const app = buildProbeApp();
    const res = await app.request('/probe', { headers: { 'x-request-id': '' } });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
