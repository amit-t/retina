import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, requestId } from '../../../../src/http/middleware/request-id.js';
import type { AppEnv } from '../../../../src/http/types.js';

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', requestId());
  a.get('/echo', (c) => c.json({ requestId: c.get('requestId') }));
  return a;
}

describe('requestId middleware', () => {
  it('echoes the caller-supplied x-request-id header', async () => {
    const res = await app().request('/echo', {
      headers: { [REQUEST_ID_HEADER]: 'caller-123' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('caller-123');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe('caller-123');
  });

  it('generates a uuid v4 when the header is missing', async () => {
    const res = await app().request('/echo');
    expect(res.status).toBe(200);
    const header = res.headers.get(REQUEST_ID_HEADER);
    expect(header).not.toBeNull();
    // RFC 4122 v4: 8-4-4-4-12 hex with the `4` version nibble.
    expect(header).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('treats an empty caller-supplied header as missing and generates a new id', async () => {
    const res = await app().request('/echo', {
      headers: { [REQUEST_ID_HEADER]: '   ' },
    });
    expect(res.status).toBe(200);
    const header = res.headers.get(REQUEST_ID_HEADER);
    expect(header).not.toBeNull();
    expect(header).not.toBe('   ');
    expect(header?.trim().length).toBeGreaterThan(0);
  });

  it('issues a distinct id for each request when the caller does not supply one', async () => {
    const server = app();
    const res1 = await server.request('/echo');
    const res2 = await server.request('/echo');
    const id1 = res1.headers.get(REQUEST_ID_HEADER);
    const id2 = res2.headers.get(REQUEST_ID_HEADER);
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
  });
});
