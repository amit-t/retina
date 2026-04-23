// R09 — route-level tests for `POST /v1/ocr`.
//
// Exercises the full composed app (`buildApp`) so middleware + routes +
// error envelope behave as a unit. The provider layer is stubbed via an
// in-process `TaskRouter` mock; `normalize()` runs against the real
// base64 + magic-byte path with tiny in-memory PNGs.
//
// Covers the acceptance list in `.ralph/fix_plan.md` R09:
//   - happy
//   - languages forwarded into prompt
//   - empty-text handled
//   - 413 oversize
//   - result.blocks.every(b => b.bbox === null)

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../../src/app.ts';
import type { ProviderCallInput, ProviderUsage } from '../../../../src/core/providers/index.ts';
import type { TaskRouter, TaskRouterCallOptions } from '../../../../src/core/tasks/ocr.ts';
import type { ErrorMiddlewareLogger } from '../../../../src/http/middleware/error.ts';
import type { OcrResponse } from '../../../../src/http/schemas.ts';

// Valid 8-byte PNG signature + a couple bytes of payload so `sniffMime`
// agrees with the declared `image/png` and `normalize` returns them.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('xy'),
]);
const PNG_BASE64 = PNG_BYTES.toString('base64');

const USAGE: ProviderUsage = { inputTokens: 12, outputTokens: 3 };

type Call = {
  task: 'describe' | 'ocr' | 'extract';
  input: ProviderCallInput;
  opts: TaskRouterCallOptions;
};

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

function makeRouter(
  output: unknown,
  meta: { provider?: string; model?: string; usage?: ProviderUsage } = {},
): { router: TaskRouter; calls: Call[] } {
  const calls: Call[] = [];
  const router: TaskRouter = {
    call: vi.fn(async (task, input, opts) => {
      calls.push({ task, input, opts });
      return {
        output,
        usage: meta.usage ?? USAGE,
        provider: meta.provider ?? 'openai',
        model: meta.model ?? 'gpt-vision-stub',
      };
    }),
  };
  return { router, calls };
}

describe('POST /v1/ocr (R09)', () => {
  it('happy path — returns 200 with {text, blocks, provider, model, usage}', async () => {
    const { router, calls } = makeRouter('Hello, world.', {
      provider: 'bedrock',
      model: 'claude-3-sonnet',
    });
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as OcrResponse;
    expect(body).toEqual({
      text: 'Hello, world.',
      blocks: [{ text: 'Hello, world.', bbox: null }],
      provider: 'bedrock',
      model: 'claude-3-sonnet',
      usage: USAGE,
    });
    // The route must dispatch via the `ocr` task with the decoded bytes +
    // sniffed mime forwarded into the provider input.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe('ocr');
    expect(calls[0]?.input.mime).toBe('image/png');
    expect(Buffer.from(calls[0]?.input.bytes ?? new Uint8Array()).equals(PNG_BYTES)).toBe(true);
  });

  it('forwards `languages` into both the prompt and the provider input', async () => {
    const { router, calls } = makeRouter('bonjour');
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
        languages: ['fr', 'en'],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.input.languages).toEqual(['fr', 'en']);
    expect(calls[0]?.input.prompt).toMatch(/fr, en/);
  });

  it('empty-text handled — provider returns "" → {text: "", blocks: []} with 200', async () => {
    const { router } = makeRouter('');
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as OcrResponse;
    expect(body.text).toBe('');
    expect(body.blocks).toEqual([]);
    // Invariant holds vacuously for the empty list too.
    expect(body.blocks.every((b) => b.bbox === null)).toBe(true);
  });

  it('413 oversize — size-limit middleware rejects before the route runs', async () => {
    const { router, calls } = makeRouter('never reached');
    const app = buildApp({
      config: { MAX_IMAGE_BYTES: 16 },
      router,
      logger: silentLogger(),
    });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '4096',
      },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.details).toEqual({ contentLength: 4096, maxBytes: 16 });
    // Route did not dispatch to the router.
    expect(calls).toHaveLength(0);
  });

  it('result.blocks.every(b => b.bbox === null) — MVP invariant holds on success', async () => {
    const { router } = makeRouter('alpha\nbeta\ngamma');
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as OcrResponse;
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.blocks.every((b) => b.bbox === null)).toBe(true);
  });

  it('400 — malformed JSON body surfaces invalid_request', async () => {
    const { router } = makeRouter('n/a');
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('400 — Zod rejects missing `image` field', async () => {
    const { router } = makeRouter('n/a');
    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ languages: ['en'] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details?.issues).toBeDefined();
  });
});
