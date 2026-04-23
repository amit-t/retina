/**
 * `POST /v1/describe` — free-form image description.
 *
 * Pipeline (spec §Data flow):
 *
 *   Zod-validate body (R04) → normalize image (R05) → router.call('describe')
 *                                                  → shape DescribeResponse
 *
 * The handler is wrapped in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
 * (constitution invariant #10). On abort the underlying provider error is
 * remapped to `ProviderTimeoutError` (504 `provider_timeout`).
 *
 * Error handling: route handlers throw `RetinaError` subclasses; the shared
 * error middleware (`src/http/middleware/error.ts`, R02e) turns them into
 * the stable JSON envelope. No envelope construction happens here
 * (constitution invariant #7).
 */

import { Hono } from 'hono';
import { ProviderTimeoutError, ValidationError } from '../../core/errors.js';
import { type NormalizeInput, normalize } from '../../core/image.js';
import {
  type DescribeTaskInput,
  runDescribe,
  type TaskProviderOptions,
  type TaskRouter,
} from '../../core/tasks/describe.js';
import { DescribeRequest, type DescribeResponse } from '../schemas.js';

/** Structural config slice the describe route reads at request time. */
export interface DescribeRouteConfig {
  MAX_IMAGE_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
}

export interface DescribeRouteDeps {
  router: TaskRouter;
  config: DescribeRouteConfig;
}

/**
 * Build the describe route. Exposed as a factory so `buildApp()` can mount
 * it only when a router has been supplied (deferred until R13 wires the
 * concrete `ProviderRouter` from R06c).
 */
export function createDescribeRoute(deps: DescribeRouteDeps): Hono {
  const app = new Hono();

  app.post('/v1/describe', async (c) => {
    const body = await parseBody(c.req.raw);

    const normalized = await normalize(body.image as NormalizeInput, {
      maxBytes: deps.config.MAX_IMAGE_BYTES,
    });

    const signal = AbortSignal.timeout(deps.config.REQUEST_TIMEOUT_MS);

    const taskInput: DescribeTaskInput = {
      bytes: normalized.bytes,
      mime: normalized.mime,
      signal,
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
    };

    const providerOptions = extractProviderOptions(body);
    if (providerOptions !== undefined) taskInput.providerOptions = providerOptions;

    try {
      const result = await runDescribe(deps.router, taskInput);
      const response: DescribeResponse = {
        description: result.description,
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

async function parseBody(raw: Request): Promise<ReturnType<typeof DescribeRequest.parse>> {
  let json: unknown;
  try {
    json = await raw.json();
  } catch (cause) {
    throw new ValidationError('Request body must be valid JSON', { cause });
  }

  const parsed = DescribeRequest.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('Invalid describe request body', {
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
  body: ReturnType<typeof DescribeRequest.parse>,
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
