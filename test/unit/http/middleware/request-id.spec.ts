import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_ID_HEADER,
  type RequestIdVariables,
  requestId,
} from '../../../../src/http/middleware/request-id.js';

// Matches a canonical 8-4-4-4-12 lowercase UUID v4 string.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const buildApp = () => {
  const app = new Hono<{ Variables: RequestIdVariables }>();
  app.use('*', requestId());
  app.get('/', (c) => c.json({ requestId: c.get('requestId') }));
  return app;
};

describe('requestId middleware', () => {
  it('generates a UUID v4 when the incoming request carries no x-request-id', async () => {
    const app = buildApp();

    const res = await app.request('/');
    const body = (await res.json()) as { requestId: string };
    const header = res.headers.get(REQUEST_ID_HEADER);

    expect(header).toBeTruthy();
    expect(header).toMatch(UUID_V4_RE);
    expect(body.requestId).toBe(header);
  });

  it('echoes a non-empty incoming x-request-id verbatim', async () => {
    const app = buildApp();

    const incoming = 'req-abc-123';
    const res = await app.request('/', {
      headers: { [REQUEST_ID_HEADER]: incoming },
    });
    const body = (await res.json()) as { requestId: string };

    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(incoming);
    expect(body.requestId).toBe(incoming);
  });

  it('falls back to a generated id when the incoming header is the empty string', async () => {
    const app = buildApp();

    const res = await app.request('/', {
      headers: { [REQUEST_ID_HEADER]: '' },
    });
    const header = res.headers.get(REQUEST_ID_HEADER);

    expect(header).toMatch(UUID_V4_RE);
  });

  it('binds the request id onto the Hono context for downstream handlers', async () => {
    const app = new Hono<{ Variables: RequestIdVariables }>();
    app.use('*', requestId());
    app.get('/ctx', (c) => {
      const id = c.get('requestId');
      return c.text(id);
    });

    const res = await app.request('/ctx', {
      headers: { [REQUEST_ID_HEADER]: 'ctx-id' },
    });

    expect(await res.text()).toBe('ctx-id');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('ctx-id');
  });

  it('supports a custom generator', async () => {
    const app = new Hono<{ Variables: RequestIdVariables }>();
    app.use('*', requestId({ generator: () => 'deterministic' }));
    app.get('/', (c) => c.text(c.get('requestId')));

    const res = await app.request('/');

    expect(await res.text()).toBe('deterministic');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('deterministic');
  });

  it('generates a distinct id per request by default', async () => {
    const app = buildApp();

    const [a, b] = await Promise.all([app.request('/'), app.request('/')]);
    const idA = a.headers.get(REQUEST_ID_HEADER);
    const idB = b.headers.get(REQUEST_ID_HEADER);

    expect(idA).toMatch(UUID_V4_RE);
    expect(idB).toMatch(UUID_V4_RE);
    expect(idA).not.toBe(idB);
  });
});
