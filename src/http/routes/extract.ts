/**
 * `POST /v1/extract` — structured data extraction.
 *
 * Pipeline (spec §Data flow):
 *
 *   Zod-validate body (R04) → normalize image (R05) → runExtract(router,
 *   registry, opts) → shape ExtractResponse
 *
 * The `ExtractRequest` schema (R04) enforces the XOR between `schema` and
 * `templateId` via `.superRefine`; either violation surfaces as a 400
 * `invalid_request` here. Unknown `templateId` is thrown by the registry
 * inside `runExtract` as `TemplateNotFoundError` and shaped to 404
 * `template_not_found` by the error middleware.
 *
 * The handler is wrapped in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
 * (constitution invariant #10). On abort the underlying provider error is
 * remapped to `ProviderTimeoutError` (504 `provider_timeout`).
 *
 * Error handling: route handlers throw `RetinaError` subclasses; the
 * shared error middleware (`src/http/middleware/error.ts`, R02e) turns
 * them into the stable JSON envelope. No envelope construction happens
 * here (constitution invariant #7).
 */

import { Hono } from 'hono';
import { ProviderTimeoutError, ValidationError } from '../../core/errors.js';
import { type NormalizeInput, normalize } from '../../core/image.js';
import {
  type ExtractTaskInput,
  runExtract,
  type TaskProviderOptions,
  type TaskRouter,
  type TemplateRegistry,
} from '../../core/tasks/extract.js';
import { ExtractRequest, type ExtractResponse } from '../schemas.js';

/** Structural config slice the extract route reads at request time. */
export interface ExtractRouteConfig {
  MAX_IMAGE_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
}

export interface ExtractRouteDeps {
  router: TaskRouter;
  templates: TemplateRegistry;
  config: ExtractRouteConfig;
}

/**
 * Build the extract route. Exposed as a factory so `buildApp()` can mount
 * it only when BOTH a router AND a template registry have been supplied.
 */
export function createExtractRoute(deps: ExtractRouteDeps): Hono {
  const app = new Hono();

  app.post('/v1/extract', async (c) => {
    const body = await parseBody(c.req.raw);

    const normalized = await normalize(body.image as NormalizeInput, {
      maxBytes: deps.config.MAX_IMAGE_BYTES,
    });

    const signal = AbortSignal.timeout(deps.config.REQUEST_TIMEOUT_MS);

    const taskInput: ExtractTaskInput = {
      bytes: normalized.bytes,
      mime: normalized.mime,
      signal,
      ...(body.schema !== undefined ? { schema: body.schema } : {}),
      ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
    };

    const providerOptions = extractProviderOptions(body);
    if (providerOptions !== undefined) taskInput.providerOptions = providerOptions;

    try {
      const result = await runExtract(deps.router, deps.templates, taskInput);
      const response: ExtractResponse = {
        data: result.data,
        templateId: result.templateId,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      };
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

async function parseBody(raw: Request): Promise<ReturnType<typeof ExtractRequest.parse>> {
  let json: unknown;
  try {
    json = await raw.json();
  } catch (cause) {
    throw new ValidationError('Request body must be valid JSON', { cause });
  }

  const parsed = ExtractRequest.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('Invalid extract request body', {
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

function extractProviderOptions(
  body: ReturnType<typeof ExtractRequest.parse>,
): TaskProviderOptions | undefined {
  const out: TaskProviderOptions = {};
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
