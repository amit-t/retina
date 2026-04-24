// R12b — route-level tests for `POST /v1/analyze`.
//
// Exercises the full composed app (`buildApp`) so middleware + routes +
// error envelope behave as a unit, but stubs the provider layer via an
// in-process `TaskRouter` mock so the test is hermetic.
//
// Scope per `.ralph/fix_plan.md` R12b acceptance: one happy-path case per
// discriminated-union branch (`describe`, `ocr`, `extract`) asserting the
// `{task, result}` envelope is shaped correctly and the right task runner
// was dispatched.

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import type { ProviderCallInput, ProviderUsage } from '../../src/core/providers/index.ts';
import type {
  TaskName,
  TaskRouter,
  TaskRouterCallOptions,
  TaskRouterResult,
} from '../../src/core/tasks/describe.ts';
import type { JsonSchemaObject, Template, TemplateRegistry } from '../../src/core/tasks/extract.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';
import type {
  AnalyzeResponse,
  DescribeResponse,
  ExtractResponse,
  OcrResponse,
} from '../../src/http/schemas.ts';

// Valid 8-byte PNG signature + a couple bytes so `sniffMime` agrees with
// the declared `image/png` in each test body.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('retina'),
]);
const PNG_BASE64 = PNG_BYTES.toString('base64');

const USAGE: ProviderUsage = { inputTokens: 21, outputTokens: 5 };

interface RouterInvocation {
  task: TaskName;
  input: ProviderCallInput;
  opts: TaskRouterCallOptions | undefined;
}

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
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

/** Build a structural `TemplateRegistry` stub returning a single template. */
function makeRegistry(template: Template): TemplateRegistry {
  return {
    get: vi.fn((id: string) => {
      if (id !== template.id) throw new Error(`unexpected template id: ${id}`);
      return template;
    }),
    list: () => [{ id: template.id, version: template.version, description: template.description }],
  };
}

describe('POST /v1/analyze (R12b)', () => {
  // ---------------------------------------------------------------------------
  // describe branch
  // ---------------------------------------------------------------------------
  it('describe — dispatches to runDescribe and wraps result in {task, result}', async () => {
    const { router, invocations } = makeRouter(async () => ({
      output: 'a dog on a skateboard',
      usage: USAGE,
      provider: 'openai',
      model: 'gpt-vision-stub',
    }));

    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'describe',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        prompt: 'what is in this image?',
        maxTokens: 64,
        provider: 'openai',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Extract<AnalyzeResponse, { task: 'describe' }>;
    expect(body.task).toBe('describe');

    const expected: DescribeResponse = {
      description: 'a dog on a skateboard',
      provider: 'openai',
      model: 'gpt-vision-stub',
      usage: USAGE,
    };
    expect(body.result).toEqual(expected);

    // Router saw a `describe` dispatch with the decoded image + prompt +
    // maxTokens and an AbortSignal (REQUEST_TIMEOUT_MS wrapper).
    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.task).toBe('describe');
    expect(call.input.mime).toBe('image/png');
    expect(Buffer.from(call.input.bytes).equals(PNG_BYTES)).toBe(true);
    expect(call.input.prompt).toBe('what is in this image?');
    expect(call.input.maxTokens).toBe(64);
    expect(call.input.signal).toBeInstanceOf(AbortSignal);
    expect(call.opts?.provider).toBe('openai');
  });

  // ---------------------------------------------------------------------------
  // ocr branch
  // ---------------------------------------------------------------------------
  it('ocr — dispatches to runOcr and wraps {text, blocks, ...} in {task, result}', async () => {
    const { router, invocations } = makeRouter(async () => ({
      output: 'Hello, analyze.',
      usage: USAGE,
      provider: 'anthropic',
      model: 'claude-vision-stub',
    }));

    const app = buildApp({ router, logger: silentLogger() });

    const res = await app.request('/v1/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'ocr',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        languages: ['en'],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Extract<AnalyzeResponse, { task: 'ocr' }>;
    expect(body.task).toBe('ocr');

    const expected: OcrResponse = {
      text: 'Hello, analyze.',
      blocks: [{ text: 'Hello, analyze.', bbox: null }],
      provider: 'anthropic',
      model: 'claude-vision-stub',
      usage: USAGE,
    };
    expect(body.result).toEqual(expected);

    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.task).toBe('ocr');
    expect(call.input.languages).toEqual(['en']);
    expect(call.input.prompt).toMatch(/en/);
    expect(call.opts?.signal).toBeInstanceOf(AbortSignal);
  });

  // ---------------------------------------------------------------------------
  // extract branch — ad-hoc schema path (no registry lookup)
  // ---------------------------------------------------------------------------
  it('extract — ad-hoc schema: dispatches to runExtract; templateId is null in response', async () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      properties: { color: { type: 'string' } },
      required: ['color'],
    };
    const { router, invocations } = makeRouter(async () => ({
      output: { color: 'red' },
      usage: USAGE,
      provider: 'google',
      model: 'gemini-vision-stub',
    }));

    // Registry provided but never touched on the ad-hoc path; we still
    // pass it so analyze is wired identically in production + test.
    const registry = makeRegistry({
      id: 'unused',
      version: '1',
      description: 'not referenced on the schema path',
      schema: {},
    });

    const app = buildApp({ router, templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'extract',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        schema,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Extract<AnalyzeResponse, { task: 'extract' }>;
    expect(body.task).toBe('extract');

    const expected: ExtractResponse = {
      data: { color: 'red' },
      templateId: null,
      provider: 'google',
      model: 'gemini-vision-stub',
      usage: USAGE,
    };
    expect(body.result).toEqual(expected);

    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.task).toBe('extract');
    expect(call.input.schema).toEqual(schema);
    expect(call.input.signal).toBeInstanceOf(AbortSignal);
    // Registry.get must not have been consulted — ad-hoc path only.
    expect(registry.get).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // extract branch — template path (registry lookup)
  // ---------------------------------------------------------------------------
  it('extract — template path: resolves schema via registry and echoes templateId', async () => {
    const templateSchema: JsonSchemaObject = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const template: Template = {
      id: 'invoice-v1',
      version: '1.0.0',
      description: 'invoice fields',
      schema: templateSchema,
    };

    const { router, invocations } = makeRouter(async () => ({
      output: { title: 'ACME Invoice' },
      usage: USAGE,
      provider: 'openai',
      model: 'gpt-vision-stub',
    }));

    const registry = makeRegistry(template);

    const app = buildApp({ router, templates: registry, logger: silentLogger() });

    const res = await app.request('/v1/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'extract',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        templateId: template.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Extract<AnalyzeResponse, { task: 'extract' }>;
    expect(body.task).toBe('extract');

    const expected: ExtractResponse = {
      data: { title: 'ACME Invoice' },
      templateId: template.id,
      provider: 'openai',
      model: 'gpt-vision-stub',
      usage: USAGE,
    };
    expect(body.result).toEqual(expected);

    // Registry was consulted exactly once with the requested id; the
    // resolved schema was forwarded to the provider call input.
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(registry.get).toHaveBeenCalledWith(template.id);

    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    if (!call) throw new Error('expected one router invocation');
    expect(call.input.schema).toEqual(templateSchema);
  });
});
