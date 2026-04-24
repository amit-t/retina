// R12a — GET /v1/templates + GET /v1/templates/:id route composition test.
//
// Exercises the templates catalog routes end-to-end through `buildApp()`:
//
//   request-id → size-limit → templates route (registry.list / registry.get)
//                                            ↓
//                                     error middleware
//
// The `TemplateRegistry` test double is a hand-rolled structural
// implementation of the R10 surface (`get()` + `list()`) — simpler than
// wiring through `loadTemplates()` against a temp directory (that path
// is covered by test/unit/templates.spec.ts). Registry misses throw
// `TemplateNotFoundError`, the same contract R10 ships in production,
// so the 404 envelope is proven end-to-end through the composed stack.
//
// These tests also confirm `buildApp()` mounts the templates catalog
// independently of `deps.router` — GET /v1/templates must be reachable
// even on a router-less bootstrap so operators can inspect the catalog
// before any provider is configured.

import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { TemplateNotFoundError } from '../../src/core/errors.ts';
import type { Template, TemplateRegistry, TemplateSummary } from '../../src/core/templates.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

const invoice: Template = {
  id: 'invoice-v1',
  version: '1.0.0',
  description: 'Invoice extraction schema',
  schema: {
    type: 'object',
    properties: { total: { type: 'number' }, vendor: { type: 'string' } },
    required: ['total', 'vendor'],
  },
};

const receipt: Template = {
  id: 'receipt-v1',
  version: '2.1.3',
  description: 'Retail receipt schema',
  schema: {
    type: 'object',
    properties: { merchant: { type: 'string' } },
  },
};

/**
 * Build a registry double with the full R10 surface (`get` + `list`).
 * Summaries are derived from the same template map so the list shape
 * stays in sync with what `get` returns.
 */
function makeRegistry(templates: Template[]): TemplateRegistry {
  const byId = new Map(templates.map((t) => [t.id, t]));
  return {
    get(id: string): Template {
      const template = byId.get(id);
      if (!template) {
        throw new TemplateNotFoundError(`Template "${id}" not found`, {
          details: { id, available: [...byId.keys()] },
        });
      }
      return template;
    },
    list(): TemplateSummary[] {
      return [...byId.values()].map(({ id, version, description }) => ({
        id,
        version,
        description,
      }));
    },
  };
}

describe('GET /v1/templates (R12a)', () => {
  it('200 — returns every template as {id, version, description} summaries without schema', async () => {
    const registry = makeRegistry([invoice, receipt]);
    const app = buildApp({ templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/templates', {
      headers: { 'x-request-id': 'templates-list' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('templates-list');
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as TemplateSummary[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // Deterministic ordering is the registry's concern (R10 sorts by id);
    // we only assert set membership + summary shape here.
    const byId = new Map(body.map((s) => [s.id, s]));
    expect(byId.get('invoice-v1')).toEqual({
      id: 'invoice-v1',
      version: '1.0.0',
      description: 'Invoice extraction schema',
    });
    expect(byId.get('receipt-v1')).toEqual({
      id: 'receipt-v1',
      version: '2.1.3',
      description: 'Retail receipt schema',
    });

    // Summaries MUST NOT leak the schema — schemas can be large and the
    // list endpoint is for catalog browsing, not extraction wiring.
    for (const summary of body) {
      expect(summary).not.toHaveProperty('schema');
    }
  });

  it('200 — empty registry returns []', async () => {
    const registry = makeRegistry([]);
    const app = buildApp({ templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/templates');

    expect(res.status).toBe(200);
    const body = (await res.json()) as TemplateSummary[];
    expect(body).toEqual([]);
  });
});

describe('GET /v1/templates/:id (R12a)', () => {
  it('200 — returns full {id, version, description, schema} for a known id', async () => {
    const registry = makeRegistry([invoice, receipt]);
    const app = buildApp({ templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/templates/invoice-v1', {
      headers: { 'x-request-id': 'templates-detail' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('templates-detail');
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as Template;
    expect(body).toEqual(invoice);
    // Detail endpoint MUST carry the schema — it's the whole point of
    // the detail route (spec §API contracts).
    expect(body.schema).toEqual(invoice.schema);
  });

  it('404 — unknown id maps to template_not_found envelope with request id echoed', async () => {
    const registry = makeRegistry([invoice]);
    const app = buildApp({ templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/templates/does-not-exist', {
      headers: { 'x-request-id': 'templates-miss' },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('templates-miss');

    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        requestId: string;
        details?: { id?: string; available?: string[] };
      };
    };
    expect(body.error.code).toBe('template_not_found');
    expect(body.error.requestId).toBe('templates-miss');
    expect(body.error.details?.id).toBe('does-not-exist');
    // `available` is the registry's diagnostic hint (R10 includes it on
    // miss); surface it unchanged through the envelope so operators can
    // see which ids the server actually has on disk.
    expect(body.error.details?.available).toEqual(['invoice-v1']);
  });
});
