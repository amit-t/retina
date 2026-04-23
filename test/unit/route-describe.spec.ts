// R08 — POST /v1/describe route composition test.
//
// Exercises the describe route end-to-end through `buildApp()`:
//
//   request-id → size-limit → describe route (Zod → normalize → router)
//                                                 ↓
//                                          error middleware
//
// The router is a hand-rolled test double (simpler and more precise than
// mocking the R06c class which doesn't exist yet); URL image fetches go
// through `undici`'s MockAgent so the normalizer runs unchanged.

import { Buffer } from 'node:buffer';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { ProviderFailedError } from '../../src/core/errors.ts';
import type { ProviderCallInput, ProviderUsage } from '../../src/core/providers/index.ts';
import type {
  TaskName,
  TaskRouter,
  TaskRouterCallOptions,
  TaskRouterResult,
} from '../../src/core/tasks/describe.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Minimal PNG — magic header + a few filler bytes. Valid enough for the
 *  normalizer's mime sniff yet deliberately tiny so we can keep the URL
 *  mock-response small. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('retina-test'),
]);

const IMAGE_ORIGIN = 'https://img.test';
const IMAGE_PATH = '/describe.png';
const IMAGE_URL = `${IMAGE_ORIGIN}${IMAGE_PATH}`;

interface RouterInvocation {
  task: TaskName;
  input: ProviderCallInput;
  opts: TaskRouterCallOptions | undefined;
}

/**
 * Test-double router that captures every invocation. Call sites set
 * `impl` to the behavior under test; the double records the `(task, input,
 * opts)` tuple so assertions can inspect the prompt / maxTokens / image
 * bytes the runner assembled.
 */
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

const OK_USAGE: ProviderUsage = { inputTokens: 42, outputTokens: 7 };

describe('POST /v1/describe (R08)', () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  // -------------------------------------------------------------------------
  // 200 happy path
  // -------------------------------------------------------------------------
  it('200 — forwards normalized image + prompt + maxTokens to router, returns DescribeResponse shape', async () => {
    mockAgent
      .get(IMAGE_ORIGIN)
      .intercept({ path: IMAGE_PATH, method: 'GET' })
      .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } });

    const { router, invocations } = makeRouter(async () => ({
      output: 'a red ball on grass',
      usage: OK_USAGE,
      provider: 'openai',
      model: 'gpt-x-vision',
    }));

    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'describe-happy',
      },
      body: JSON.stringify({
        image: { url: IMAGE_URL },
        prompt: 'what is in this image?',
        maxTokens: 128,
        provider: 'openai',
        retries: 0,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('describe-happy');
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as {
      description: string;
      provider: string;
      model: string;
      usage: ProviderUsage;
    };
    expect(body).toEqual({
      description: 'a red ball on grass',
      provider: 'openai',
      model: 'gpt-x-vision',
      usage: OK_USAGE,
    });

    // Router saw the normalized image + task hints + request-level overrides.
    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.task).toBe('describe');
    expect(call.input.mime).toBe('image/png');
    expect(Buffer.from(call.input.bytes).equals(PNG_BYTES)).toBe(true);
    expect(call.input.prompt).toBe('what is in this image?');
    expect(call.input.maxTokens).toBe(128);
    expect(call.input.signal).toBeInstanceOf(AbortSignal);
    expect(call.opts).toBeDefined();
    expect(call.opts?.provider).toBe('openai');
    expect(call.opts?.retries).toBe(0);
    expect(call.opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('200 — base64 image path returns description without hitting the network', async () => {
    // Net-connect is disabled; if normalize accidentally tried HTTP this
    // would throw. The base64 path must not touch undici at all.
    const { router, invocations } = makeRouter(async () => ({
      output: 'inline png',
      usage: OK_USAGE,
      provider: 'anthropic',
      model: 'claude-vision-x',
    }));

    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BYTES.toString('base64'), mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { description: string; provider: string };
    expect(body.description).toBe('inline png');
    expect(body.provider).toBe('anthropic');
    expect(invocations[0]?.input.mime).toBe('image/png');
    // No provider overrides sent → router opts are undefined modulo signal.
    expect(invocations[0]?.opts).toBeDefined();
    expect(invocations[0]?.opts?.provider).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 400 malformed body
  // -------------------------------------------------------------------------
  it('400 — malformed JSON body maps to invalid_request envelope', async () => {
    const routerCalls = vi.fn();
    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      logger: silentLogger(),
    });

    const res = await app.request('/v1/describe', {
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

  it('400 — missing `image` field maps to invalid_request with Zod issues in details', async () => {
    const routerCalls = vi.fn();
    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      logger: silentLogger(),
    });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'no image here' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues: { path: string; message: string }[] } };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    expect(body.error.details?.issues?.some((i) => i.path.startsWith('image'))).toBe(true);
    expect(routerCalls).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 413 oversized
  // -------------------------------------------------------------------------
  it('413 — base64 image exceeding MAX_IMAGE_BYTES maps to image_too_large envelope', async () => {
    // Cap MAX_IMAGE_BYTES below the image size. The size-limit middleware
    // uses Content-Length for a cheap early reject, but Hono's test harness
    // does not always supply that; the streaming cap inside `normalize`
    // enforces the same invariant and produces the identical envelope.
    const routerCalls = vi.fn();
    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      logger: silentLogger(),
      config: { MAX_IMAGE_BYTES: 4 },
    });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BYTES.toString('base64'), mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('image_too_large');
    expect(body.error.details).toMatchObject({ maxBytes: 4 });
    expect(routerCalls).not.toHaveBeenCalled();
  });

  it('413 — URL body over Content-Length cap rejects before reaching the handler', async () => {
    // size-limit middleware checks Content-Length BEFORE the handler runs;
    // this proves the composed pipeline short-circuits on the pre-buffered
    // guard too (not just the streaming cap inside normalize).
    const routerCalls = vi.fn();
    const app = buildApp({
      router: { call: routerCalls as unknown as TaskRouter['call'] },
      logger: silentLogger(),
      config: { MAX_IMAGE_BYTES: 16 },
    });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '9999',
      },
      body: JSON.stringify({ image: { url: IMAGE_URL } }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('image_too_large');
    expect(routerCalls).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 502 ProviderFailedError (with attempts in envelope)
  // -------------------------------------------------------------------------
  it('502 — ProviderFailedError from the router surfaces as provider_failed with details.attempts', async () => {
    mockAgent
      .get(IMAGE_ORIGIN)
      .intercept({ path: IMAGE_PATH, method: 'GET' })
      .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } });

    const attempts = [
      { provider: 'openai', model: 'gpt-x-vision', code: 'rate_limited', message: '429' },
      { provider: 'anthropic', model: 'claude-vision-x', code: 'upstream_5xx', message: '500' },
    ];
    const { router } = makeRouter(async () => {
      throw new ProviderFailedError('All providers failed', {
        details: { attempts },
      });
    });

    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: { url: IMAGE_URL } }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; details?: { attempts?: unknown } };
    };
    expect(body.error.code).toBe('provider_failed');
    expect(body.error.details?.attempts).toEqual(attempts);
  });
});
