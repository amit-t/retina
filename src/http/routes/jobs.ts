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
import type { EnqueueInput, JobPayload, JobStore } from '../../jobs/store.js';
import type {
  DescribeResponse,
  ExtractResponse,
  JobRecordResponse,
  JobsEnqueueResponse,
  OcrResponse,
} from '../schemas.js';
import { JobsRequest } from '../schemas.js';

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
      // A freshly-enqueued job is always `queued` by the store contract
      // (see `JobStore.enqueue` — sets `status: 'queued'`). The envelope
      // type narrows the wider `JobStatus` to the literal for callers.
      status: 'queued',
    };
    return c.json(response, 202);
  });

  app.get('/v1/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const record = await deps.store.get(id);
    if (record === null) {
      throw new JobNotFoundError('Job not found', { details: { jobId: id } });
    }

    // The store persists `result` as `unknown` (round-tripped JSON) so it
    // can hold any of the task response shapes. Callers of this route see
    // one of `DescribeResponse | OcrResponse | ExtractResponse | null`; we
    // narrow here rather than validating — the worker is the only writer
    // and it always writes one of those shapes (spec §Data flow › Async).
    const response: JobRecordResponse = {
      jobId: record.jobId,
      status: record.status,
      attempts: record.attempts,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      result: record.result as DescribeResponse | OcrResponse | ExtractResponse | null,
      error: record.error,
    };
    return c.json(response);
  });

  return app;
}

/**
 * Translate the validated `JobsRequest` into the store-ready
 * `EnqueueInput`. The canonical `JobStore` (R14) wraps the actual job
 * shape inside `{ payload }` where `payload` carries the `task`
 * discriminator + task-specific fields + shared provider/callback options.
 * Only fields present on the request are copied so the Redis round-trip
 * doesn't drift `undefined` → `null`.
 */
function buildEnqueueInput(
  body: ReturnType<typeof JobsRequest.parse>,
  bytes: Uint8Array,
  mime: string,
): EnqueueInput {
  const payload: JobPayload = {
    task: body.task,
    image: { bytes, mime },
  };

  // Task-specific fields by discriminator.
  if (body.task === 'describe') {
    if (body.prompt !== undefined) payload.prompt = body.prompt;
    if (body.maxTokens !== undefined) payload.maxTokens = body.maxTokens;
  } else if (body.task === 'ocr') {
    if (body.languages !== undefined) payload.languages = body.languages;
  } else {
    // extract — XOR already enforced by the schema; forward whichever
    // side the caller supplied so the worker resolves the JsonSchema.
    if (body.schema !== undefined) payload.schema = body.schema;
    if (body.templateId !== undefined) payload.templateId = body.templateId;
  }

  // Shared: provider options (replace-semantics) + optional callback.
  if (body.provider !== undefined) payload.provider = body.provider;
  if (body.model !== undefined) payload.model = body.model;
  if (body.fallback !== undefined) payload.fallback = body.fallback;
  if (body.retries !== undefined) payload.retries = body.retries;
  if (body.callbackUrl !== undefined) payload.callbackUrl = body.callbackUrl;

  return { payload };
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
