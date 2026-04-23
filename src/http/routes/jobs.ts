/**
 * `POST /v1/jobs` + `GET /v1/jobs/:id` — async job endpoints.
 *
 * Pipeline (spec §Data flow › Async job):
 *
 *   POST: Zod-validate `JobsRequest` (R04) → normalize image (R05)
 *       → JobStore.enqueue (R14) → respond 202 {jobId, status:"queued"}
 *   GET : JobStore.get(id) → 200 JobRecord JSON
 *                         → miss → throw JobNotFoundError → 404 envelope
 *
 * SSE streaming (`GET /v1/jobs/:id/stream`) is a separate route mounted
 * by R18 on top of the same `src/jobs/sse.ts` module; it is intentionally
 * NOT part of this file so R17 can land before R14/R15 are merged.
 *
 * Error handling: only `RetinaError` subclasses are thrown. The shared
 * error middleware (R02e) shapes the JSON envelope and attaches the
 * request id (constitution invariants #6, #7).
 */

import { Hono } from 'hono';
import { JobNotFoundError, ValidationError } from '../../core/errors.js';
import { type NormalizeInput, normalize } from '../../core/image.js';
import type { JobEnqueueInput, JobStore } from '../../jobs/store.js';
import { type JobRecordResponse, type JobsEnqueueResponse, JobsRequest } from '../schemas.js';

export interface JobsRouteDeps {
  store: JobStore;
  /** Byte cap forwarded into `normalize()` — always `config.MAX_IMAGE_BYTES`
   *  in production; tests may pass a smaller cap to exercise the 413 path. */
  maxBytes: number;
  /** Optional fetch timeout for the URL image variant (defaults to the
   *  10_000 ms `normalize` default). Exposed for e2e tests. */
  urlTimeoutMs?: number;
}

/**
 * Build the jobs route. Returned Hono app is mountable at the root by
 * the composition root (`src/app.ts`). `buildApp()` only mounts it when
 * `deps.jobStore` is supplied so unit tests that don't exercise the
 * async path stay wiring-free.
 */
export function createJobsRoute(deps: JobsRouteDeps): Hono {
  const app = new Hono();

  app.post('/v1/jobs', async (c) => {
    const raw = await readJson(c.req.raw);
    const parsed = JobsRequest.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('Invalid jobs request body', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      });
    }

    const body = parsed.data;

    // Image normalization happens identically to the sync path (spec
    // §Data flow › Async step 1) so the worker receives a ready-to-use
    // {bytes, mime} pair and never needs to refetch on retries.
    const normalizeOpts: Parameters<typeof normalize>[1] = { maxBytes: deps.maxBytes };
    if (deps.urlTimeoutMs !== undefined) normalizeOpts.urlTimeoutMs = deps.urlTimeoutMs;
    const normalized = await normalize(body.image as NormalizeInput, normalizeOpts);

    const enqueueInput = buildEnqueueInput(body, normalized.bytes, normalized.mime);
    const result = await deps.store.enqueue(enqueueInput);

    const response: JobsEnqueueResponse = {
      jobId: result.jobId,
      status: result.status,
    };
    return c.json(response, 202);
  });

  app.get('/v1/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const record = await deps.store.get(id);
    if (record === null) {
      throw new JobNotFoundError('Job not found', { details: { jobId: id } });
    }

    const response: JobRecordResponse = {
      jobId: record.jobId,
      status: record.status,
      attempts: record.attempts,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      result: record.result,
      error: record.error,
    };
    return c.json(response);
  });

  return app;
}

/**
 * Translate the validated `JobsRequest` into the worker-ready
 * `JobEnqueueInput`. Task-specific fields are only set when present so
 * the payload round-trips cleanly through Redis (no `undefined` → `null`
 * drift). Provider / callback fields follow the same rule.
 */
function buildEnqueueInput(
  body: ReturnType<typeof JobsRequest.parse>,
  bytes: Uint8Array,
  mime: string,
): JobEnqueueInput {
  const input: JobEnqueueInput = {
    task: body.task,
    image: { bytes, mime },
  };

  // Task-specific fields by discriminator.
  if (body.task === 'describe') {
    if (body.prompt !== undefined) input.prompt = body.prompt;
    if (body.maxTokens !== undefined) input.maxTokens = body.maxTokens;
  } else if (body.task === 'ocr') {
    if (body.languages !== undefined) input.languages = body.languages;
  } else {
    // extract — XOR already enforced by the schema; forward whichever
    // side the caller supplied so the worker resolves the JsonSchema.
    if (body.schema !== undefined) input.schema = body.schema;
    if (body.templateId !== undefined) input.templateId = body.templateId;
  }

  // Shared: provider options (replace-semantics) + optional callback.
  if (body.provider !== undefined) input.provider = body.provider;
  if (body.model !== undefined) input.model = body.model;
  if (body.fallback !== undefined) input.fallback = body.fallback;
  if (body.retries !== undefined) input.retries = body.retries;
  if (body.callbackUrl !== undefined) input.callbackUrl = body.callbackUrl;

  return input;
}

/**
 * Parse the request body as JSON, converting syntax errors and empty
 * bodies into `ValidationError` so the error envelope carries the
 * canonical `invalid_request` code.
 */
async function readJson(req: Request): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch (cause) {
    throw new ValidationError('Failed to read request body', { cause });
  }
  if (text.length === 0) {
    throw new ValidationError('Request body is empty; expected JSON');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ValidationError('Request body is not valid JSON', { cause });
  }
}
