import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requestId } from '../../src/http/middleware/request-id.js';
import type { HonoEnv } from '../../src/http/types.js';
import { buildLogger } from '../../src/logger.js';

function makeApp() {
  const app = new Hono<HonoEnv>();
  const logger = buildLogger('silent');
  app.use('*', requestId({ logger }));
  app.get('/probe', (c) => c.json({ requestId: c.get('requestId') }));
  return app;
}

describe('requestId middleware', () => {
  it('generates a uuid when the x-request-id header is absent', async () => {
    const app = makeApp();
    const res = await app.request('/probe');
    expect(res.status).toBe(200);
    const echoed = res.headers.get('x-request-id');
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(echoed);
  });

  it('echoes the caller-supplied x-request-id header verbatim', async () => {
    const app = makeApp();
    const res = await app.request('/probe', { headers: { 'x-request-id': 'caller-trace-123' } });
    expect(res.headers.get('x-request-id')).toBe('caller-trace-123');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe('caller-trace-123');
  });

  it('falls back to a generated id when caller supplies an empty header', async () => {
    const app = makeApp();
    const res = await app.request('/probe', { headers: { 'x-request-id': '   ' } });
    const echoed = res.headers.get('x-request-id');
    expect(echoed).not.toBe('   ');
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
