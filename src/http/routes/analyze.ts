/**
 * `POST /v1/analyze` — unified endpoint for the three sync tasks.
 *
 * Body is a Zod discriminated union on `task`:
 *
 *   | task      | shape
 *   | --------- | -------------------------------------------------------
 *   | describe  | { image, prompt?, maxTokens?, ...ProviderOptions }
 *   | ocr       | { image, languages?, ...ProviderOptions }
 *   | extract   | { image, schema? XOR templateId?, ...ProviderOptions }
 *
 * Pipeline (spec §Data flow):
 *
 *   Zod-validate body (R04) → normalize image (R05) → dispatch to the
 *   matching task runner (`runDescribe` / `runOcr` / `runExtract`, R08/R09/
 *   R11) → wrap in `{task, result}` envelope.
 *
 * The handler is wrapped in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
 * (constitution invariant #10). On timeout any provider abort is remapped
 * to `ProviderTimeoutError` (504 `provider_timeout`). All other errors
 * throw `RetinaError` subclasses — the shared error middleware (R02e)
 * turns them into the stable JSON envelope (constitution invariant #7).
 */

import { Hono } from 'hono';
import { ProviderTimeoutError, ValidationError } from '../../core/errors.js';
import { type NormalizeInput, normalize } from '../../core/image.js';
import { type DescribeTaskInput, runDescribe, type TaskRouter } from '../../core/tasks/describe.js';
import {
  type ExtractTaskInput,
  runExtract,
  type TaskProviderOptions,
  type TemplateRegistry,
} from '../../core/tasks/extract.js';
import { type RunOcrOptions, runOcr } from '../../core/tasks/ocr.js';
import {
  AnalyzeRequest,
  type AnalyzeResponse,
  type DescribeResponse,
  type ExtractResponse,
  type OcrResponse,
} from '../schemas.js';

/** Structural config slice the analyze route reads at request time. */
export interface AnalyzeRouteConfig {
  MAX_IMAGE_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
}

export interface AnalyzeRouteDeps {
  router: TaskRouter;
  config: AnalyzeRouteConfig;
  /**
   * Template registry — only required to resolve `extract` branches that
   * pass `templateId`. Passing the registry always is the simple default;
   * ad-hoc `schema` requests don't touch it. If omitted AND the request
   * reaches the extract branch, the handler throws `ValidationError` so
   * misconfig surfaces as a 400 rather than a crash.
   */
  templates?: TemplateRegistry;
}

/**
 * Build the analyze route. Exposed as a factory so `buildApp()` can mount
 * it only when the required deps (router) are supplied.
 */
export function createAnalyzeRoute(deps: AnalyzeRouteDeps): Hono {
  const app = new Hono();

  app.post('/v1/analyze', async (c) => {
    const body = await parseBody(c.req.raw);

    const normalized = await normalize(body.image as NormalizeInput, {
      maxBytes: deps.config.MAX_IMAGE_BYTES,
    });

    const signal = AbortSignal.timeout(deps.config.REQUEST_TIMEOUT_MS);

    try {
      const response = await dispatch(deps, body, normalized, signal);
      return c.json(response);
    } catch (err) {
      if (signal.aborted && isAbortLike(err)) {
        throw new ProviderTimeoutError('Request exceeded REQUEST_TIMEOUT_MS', {
          cause: err,
          details: { timeoutMs: deps.config.REQUEST_TIMEOUT_MS },
        });
      }
      throw err;
    }
  });

  return app;
}

async function dispatch(
  deps: AnalyzeRouteDeps,
  body: AnalyzeRequestBody,
  normalized: { bytes: Uint8Array; mime: string },
  signal: AbortSignal,
): Promise<AnalyzeResponse> {
  switch (body.task) {
    case 'describe': {
      const input: DescribeTaskInput = {
        bytes: normalized.bytes,
        mime: normalized.mime,
        signal,
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      };
      const providerOptions = pickProviderOptions(body);
      if (providerOptions !== undefined) input.providerOptions = providerOptions;

      const result = await runDescribe(deps.router, input);
      const response: DescribeResponse = {
        description: result.description,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      };
      return { task: 'describe', result: response };
    }

    case 'ocr': {
      const input: RunOcrOptions = {
        bytes: normalized.bytes,
        mime: normalized.mime,
        signal,
      };
      if (body.languages !== undefined) input.languages = body.languages;
      if (body.provider !== undefined) input.provider = body.provider;
      if (body.model !== undefined) input.model = body.model;
      if (body.fallback !== undefined) input.fallback = body.fallback;
      if (body.retries !== undefined) input.retries = body.retries;

      const result = await runOcr(deps.router, input);
      const response: OcrResponse = {
        text: result.text,
        blocks: result.blocks,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      };
      return { task: 'ocr', result: response };
    }

    case 'extract': {
      if (deps.templates === undefined) {
        throw new ValidationError(
          'Template registry is not configured; analyze extract requests require it.',
        );
      }
      const input: ExtractTaskInput = {
        bytes: normalized.bytes,
        mime: normalized.mime,
        signal,
      };
      if (body.schema !== undefined) input.schema = body.schema;
      if (body.templateId !== undefined) input.templateId = body.templateId;
      const providerOptions: TaskProviderOptions = {};
      if (body.provider !== undefined) providerOptions.provider = body.provider;
      if (body.model !== undefined) providerOptions.model = body.model;
      if (body.fallback !== undefined) providerOptions.fallback = body.fallback;
      if (body.retries !== undefined) providerOptions.retries = body.retries;
      if (Object.keys(providerOptions).length > 0) input.providerOptions = providerOptions;

      const result = await runExtract(deps.router, deps.templates, input);
      const response: ExtractResponse = {
        data: result.data,
        templateId: result.templateId,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      };
      return { task: 'extract', result: response };
    }
  }
}

type AnalyzeRequestBody = ReturnType<typeof AnalyzeRequest.parse>;

async function parseBody(raw: Request): Promise<AnalyzeRequestBody> {
  let json: unknown;
  try {
    json = await raw.json();
  } catch (cause) {
    throw new ValidationError('Request body must be valid JSON', { cause });
  }

  const parsed = AnalyzeRequest.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('Invalid analyze request body', {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)).join('.'),
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data;
}

interface ProviderOptionsInput {
  provider?: string | undefined;
  model?: string | undefined;
  fallback?: string[] | undefined;
  retries?: number | undefined;
}

interface ProviderOptionsResolved {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
}

function pickProviderOptions(body: ProviderOptionsInput): ProviderOptionsResolved | undefined {
  const out: ProviderOptionsResolved = {};
  if (body.provider !== undefined) out.provider = body.provider;
  if (body.model !== undefined) out.model = body.model;
  if (body.fallback !== undefined) out.fallback = body.fallback;
  if (body.retries !== undefined) out.retries = body.retries;
  return Object.keys(out).length === 0 ? undefined : out;
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}
