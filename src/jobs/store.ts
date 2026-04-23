/**
 * Job storage contract.
 *
 * This file currently holds only the structural {@link JobStore} interface
 * and its value types. R14 (see `.ralph/fix_plan.md`) will add the
 * concrete `JobStore(redis)` class implementing this interface on top of
 * ioredis. R17 (this file lands as part of it) consumes the interface
 * from `src/http/routes/jobs.ts` so the async route can be unit-tested
 * with a lightweight mock before the Redis-backed class exists.
 *
 * Contract notes:
 *
 *   - Keys (R14): `retina:job:<id>` (hash / JSON), `retina:queue` (list),
 *     `retina:processing` (list), pub/sub channel `retina:job:<id>`.
 *   - `enqueue(input)` persists the payload and LPUSHes `retina:queue`,
 *     returning `{jobId, status: "queued"}`. The route responds 202 with
 *     that shape (spec §API contracts › `POST /v1/jobs`).
 *   - `get(id)` returns `null` when the key does not exist (or its TTL has
 *     expired). The route converts that into `JobNotFoundError` → 404.
 *   - The worker (R15) and SSE (R18) use the remaining surface — `claim`,
 *     `update`, `complete`, `fail`, `remove`, `publish`, `subscribe` —
 *     which R14 adds to the concrete class and may extend this interface
 *     with. R17 only needs `enqueue` + `get`.
 */

import type { AnalyzeResponse, JobStatus } from '../http/schemas.js';

/**
 * Normalized job payload persisted in Redis. The route hands
 * `JobStore.enqueue` the already-validated + image-normalized work
 * (spec §Data flow › Async job step 1–2): the image has been fetched /
 * decoded and reduced to `{bytes, mime}`, and provider / task options
 * have been narrowed to the fields the worker needs.
 *
 * Task-specific fields are optional because a single payload shape covers
 * all three tasks; the `task` discriminator tells the worker which ones
 * to read. Keeping the shape flat (rather than a discriminated union)
 * matches the wire-level `JobsRequest` structure and sidesteps an extra
 * round-trip of narrowing in the worker (R15).
 */
export interface JobEnqueueInput {
  task: 'describe' | 'ocr' | 'extract';
  image: { bytes: Uint8Array; mime: string };
  // describe
  prompt?: string;
  maxTokens?: number;
  // ocr
  languages?: string[];
  // extract (exactly one of schema / templateId per JobsRequest XOR)
  schema?: Record<string, unknown>;
  templateId?: string;
  // provider options (replace-semantics — constitution invariant #8)
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  // callback webhook — success-only (constitution invariant #11)
  callbackUrl?: string;
}

/** Response from {@link JobStore.enqueue} — the POST /v1/jobs 202 body. */
export interface JobEnqueueResult {
  jobId: string;
  status: 'queued';
}

/**
 * Persisted job record returned from {@link JobStore.get}. Matches the
 * wire shape of `GET /v1/jobs/:id` (spec §API contracts):
 *
 *   { jobId, status, attempts, createdAt, completedAt, result, error }
 *
 * `result` carries the same shape as the corresponding sync endpoint's
 * `result` field (`DescribeResponse` / `OcrResponse` / `ExtractResponse`)
 * once the worker completes the task. Until then — and forever on a
 * failed job — it is `null`. `error` is populated when the job reaches
 * the terminal `failed` state (attempts exhausted per R15).
 */
export interface JobRecord {
  jobId: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
  result: AnalyzeResponse['result'] | null;
  error: { code: string; message: string } | null;
}

/**
 * Minimal store surface consumed by `src/http/routes/jobs.ts`. R14 adds
 * the concrete class implementing this interface; R15 / R18 extend it
 * with the worker / pub-sub methods.
 */
export interface JobStore {
  /** Persist the job and push it onto `retina:queue`. Returns the
   *  generated `jobId` and initial `status: "queued"`. */
  enqueue(input: JobEnqueueInput): Promise<JobEnqueueResult>;
  /** Look up the current job record by id. Returns `null` when the id
   *  is unknown (or the record's TTL has expired). */
  get(id: string): Promise<JobRecord | null>;
}
