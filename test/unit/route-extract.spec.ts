// R11 — POST /v1/extract route composition test.
//
// Exercises the extract route end-to-end through `buildApp()`:
//
//   request-id → size-limit → extract route (Zod → normalize → runExtract)
//                                                  ↓
//                                           error middleware
//
// The router and the template registry are hand-rolled test doubles
// (simpler and more precise than mocking R06c / R10 which are landing in
// parallel). Base64 image inputs are used so tests stay network-free.

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { TemplateNotFoundError } from '../../src/core/errors.ts';
import type { ProviderCallInput, ProviderUsage } from '../../src/core/providers/index.ts';
import type {
  TaskName,
  TaskRouter,
  TaskRouterCallOptions,
  TaskRouterResult,
  Template,
  TemplateRegistry,
} from '../../src/core/tasks/extract.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Minimal PNG — magic header + filler. Valid enough for the normalizer's
 *  mime sniff; keeps the base64 payload small. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('retina-extract'),
]);

const PNG_BASE64 = PNG_BYTES.toString('base64');

const OK_USAGE: ProviderUsage = { inputTokens: 123, outputTokens: 45 };

interface RouterInvocation {
  task: TaskName;
  input: ProviderCallInput;
  opts: TaskRouterCallOptions | undefined;
}

function makeRouter(impl: (inv: RouterInvocation) => Promise<TaskRouterResult>): {
  router: TaskRouter;
  invocations: RouterInvocation[];
} {
  const invocations: RouterInvocation[] = [];
  const router: TaskRouter = {
    call: async (task, input, opts) => {
      const invocation: RouterInvocation = { task, input, opts };
      invocations.push(invocation);
      return impl(invocation);
    },
  };
  return { router, invocations };
}

/** Registry test double. Tracks lookups so we can assert resolution order.
 *  Misses throw `TemplateNotFoundError` (the R10 contract). */
function makeRegistry(templates: Template[]): {
  registry: TemplateRegistry;
  lookups: string[];
} {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const lookups: string[] = [];
  const registry: TemplateRegistry = {
    get(id) {
      lookups.push(id);
      const template = byId.get(id);
      if (!template) {
        throw new TemplateNotFoundError(`Template "${id}" not found`, {
          details: { templateId: id },
        });
      }
      return template;
    },
  };
  return { registry, lookups };
}

describe('POST /v1/extract (R11)', () => {
  let warnings: unknown[][];
  let errors: unknown[][];
  let logger: ErrorMiddlewareLogger;

  beforeEach(() => {
    warnings = [];
    errors = [];
    logger = {
      warn: (...args: unknown[]) => warnings.push(args),
      error: (...args: unknown[]) => errors.push(args),
    };
  });

  afterEach(() => {
    warnings = [];
    errors = [];
  });

  // -------------------------------------------------------------------------
  // 200 — ad-hoc schema path (templateId → null in response)
  // -------------------------------------------------------------------------
  it('200 — ad-hoc `schema` forwards the schema to the router and returns templateId:null', async () => {
    const adHocSchema = {
      type: 'object',
      properties: { total: { type: 'number' }, currency: { type: 'string' } },
      required: ['total', 'currency'],
    };
    const providerData = { total: 42.5, currency: 'USD' };

    const { router, invocations } = makeRouter(async () => ({
      output: providerData,
      usage: OK_USAGE,
      provider: 'openai',
      model: 'gpt-x-vision',
    }));
    const { registry, lookups } = makeRegistry([]);

    const app = buildApp({ router, templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'extract-schema' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
        schema: adHocSchema,
        provider: 'openai',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('extract-schema');

    const body = (await res.json()) as {
      data: Record<string, unknown>;
      templateId: string | null;
      provider: string;
      model: string;
      usage: ProviderUsage;
    };
    expect(body).toEqual({
      data: providerData,
      templateId: null,
      provider: 'openai',
      model: 'gpt-x-vision',
      usage: OK_USAGE,
    });

    // Ad-hoc path MUST NOT hit the registry.
    expect(lookups).toEqual([]);

    // Router saw the ad-hoc schema + normalized image.
    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.task).toBe('extract');
    expect(call.input.mime).toBe('image/png');
    expect(Buffer.from(call.input.bytes).equals(PNG_BYTES)).toBe(true);
    expect(call.input.schema).toEqual(adHocSchema);
    expect(call.opts?.provider).toBe('openai');
  });

  // -------------------------------------------------------------------------
  // 200 — templateId path (templateId echoed in response)
  // -------------------------------------------------------------------------
  it('200 — `templateId` resolves the schema via the registry and echoes the id', async () => {
    const templateSchema = {
      type: 'object',
      properties: { vendor: { type: 'string' }, total: { type: 'number' } },
    };
    const template: Template = { id: 'invoice-v1', schema: templateSchema };
    const providerData = { vendor: 'Acme', total: 100 };

    const { router, invocations } = makeRouter(async () => ({
      output: providerData,
      usage: OK_USAGE,
      provider: 'anthropic',
      model: 'claude-vision-x',
    }));
    const { registry, lookups } = makeRegistry([template]);

    const app = buildApp({ router, templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
        templateId: 'invoice-v1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
      templateId: string | null;
      provider: string;
    };
    expect(body.data).toEqual(providerData);
    expect(body.templateId).toBe('invoice-v1');
    expect(body.provider).toBe('anthropic');

    // Registry was consulted exactly once with the requested id.
    expect(lookups).toEqual(['invoice-v1']);

    // Router saw the template's resolved schema, not the raw id.
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.input.schema).toEqual(templateSchema);
  });

  // -------------------------------------------------------------------------
  // 404 — unknown templateId surfaces template_not_found
  // -------------------------------------------------------------------------
  it('404 — unknown `templateId` maps to template_not_found envelope', async () => {
    const routerCalls = vi.fn();
    const { registry, lookups } = makeRegistry([]);

    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      templates: registry,
      logger,
    });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
        templateId: 'does-not-exist',
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('template_not_found');
    expect(body.error.details?.templateId).toBe('does-not-exist');

    // Registry was queried; router was never reached.
    expect(lookups).toEqual(['does-not-exist']);
    expect(routerCalls).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 400 — neither schema nor templateId (XOR floor)
  // -------------------------------------------------------------------------
  it('400 — body with NEITHER `schema` nor `templateId` maps to invalid_request', async () => {
    const routerCalls = vi.fn();
    const { registry, lookups } = makeRegistry([]);

    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      templates: registry,
      logger: silentLogger(),
    });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues: { path: string; message: string }[] } };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    // XOR superRefine reports on the `schema` path for the missing-both case.
    expect(
      body.error.details?.issues?.some(
        (i) => /schema|templateId/i.test(i.path) || /schema.*templateId/i.test(i.message),
      ),
    ).toBe(true);

    expect(lookups).toEqual([]);
    expect(routerCalls).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 400 — both schema and templateId set (XOR ceiling)
  // -------------------------------------------------------------------------
  it('400 — body with BOTH `schema` and `templateId` maps to invalid_request', async () => {
    const routerCalls = vi.fn();
    const { registry, lookups } = makeRegistry([{ id: 'invoice-v1', schema: { type: 'object' } }]);

    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      templates: registry,
      logger: silentLogger(),
    });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
        schema: { type: 'object' },
        templateId: 'invoice-v1',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues: { path: string; message: string }[] } };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details?.issues?.some((i) => /not both/i.test(i.message))).toBe(true);

    // Zod short-circuits before we touch the registry or router.
    expect(lookups).toEqual([]);
    expect(routerCalls).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Extra coverage — malformed JSON
  // -------------------------------------------------------------------------
  it('400 — malformed JSON body maps to invalid_request envelope', async () => {
    const routerCalls = vi.fn();
    const { registry } = makeRegistry([]);

    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      templates: registry,
      logger: silentLogger(),
    });

    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/valid JSON/i);
    expect(routerCalls).not.toHaveBeenCalled();
  });
});
