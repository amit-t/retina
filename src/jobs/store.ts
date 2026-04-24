/**
 * Redis-backed job store for Retina's async pipeline.
 *
 * `JobStore` wraps a single `ioredis` client and encapsulates the three
 * pieces of state the async flow needs (spec §Data flow Async job):
 *
 *   - `retina:job:<id>`     — per-job record (JSON blob, typed below).
 *   - `retina:queue`        — FIFO list of jobIds awaiting a worker.
 *   - `retina:processing`   — work-in-progress list populated by
 *                              `BRPOPLPUSH retina:queue retina:processing`.
 *   - `retina:job:<id>`     — pub/sub channel carrying status events for
 *                              SSE subscribers (same string as the record
 *                              key; Redis key-space and channel-space are
 *                              disjoint so this is safe and matches the
 *                              spec's wording).
 *
 * Methods mirror the R14 task description:
 *
 *   - `enqueue(job)`        — SET the record + LPUSH onto the queue.
 *   - `claim(blockSec)`     — BRPOPLPUSH queue → processing, then load the
 *                              record. Returns `null` when the block window
 *                              elapses without work (matches ioredis's
 *                              blocking-command convention).
 *   - `get(id)`             — read the record (`null` on miss / TTL-expired).
 *   - `update(id, patch)`   — merge fields and re-SET (no TTL change).
 *   - `complete(id, r, ttl)`— write `result` + terminal status with the
 *                              `JOB_RESULT_TTL_SECONDS` TTL applied atomically
 *                              via `SET ... EX`.
 *   - `fail(id, error)`     — mark `failed`, attach the error envelope.
 *   - `remove(id)`          — LREM the id from `retina:processing`
 *                              (workers call this on terminal state).
 *   - `publish(id, event)`  — PUBLISH a JSON-encoded `JobEvent` to
 *                              `retina:job:<id>`.
 *   - `subscribe(id, cb)`   — SUBSCRIBE on a duplicated client (ioredis
 *                              best practice: a connection in subscriber
 *                              mode can't issue normal commands). Returns
 *                              an `unsubscribe()` handle that tears the
 *                              subscriber down.
 *
 * The record shape here is the union of the `GET /v1/jobs/:id` response
 * (spec §API contracts) plus a `payload` field that carries the normalized
 * request so the worker (R15) can rehydrate the task input on claim. The
 * wire response type lives in `src/http/schemas.ts` (R04); R17 reshapes
 * this record into that envelope when handling GETs.
 */

import { randomUUID } from 'node:crypto';
import type { Redis as IORedis } from 'ioredis';
import type { JobStatus } from '../http/schemas.js';

/** Redis key of a per-job record. Exported for worker / e2e tests that
 *  want to assert on raw Redis state. */
export const jobKey = (id: string): string => `retina:job:${id}`;

/** List of jobIds awaiting a worker. */
export const QUEUE_KEY = 'retina:queue';

/** Work-in-progress list — a jobId is atomically moved here by `claim`
 *  and removed by `remove` on terminal state. */
export const PROCESSING_KEY = 'retina:processing';

/** Pub/sub channel for a job's lifecycle events. */
export const jobChannel = (id: string): string => `retina:job:${id}`;

export type { JobStatus };

/** Error envelope carried by failed jobs (matches `JobRecordResponse.error`). */
export interface JobError {
  code: string;
  message: string;
}

/**
 * Opaque per-task payload. Shape is finalized by R17 when the HTTP route
 * normalizes the request; the store only round-trips JSON. The `task`
 * discriminator is required so the worker can dispatch to
 * `runDescribe` / `runOcr` / `runExtract` without a second lookup.
 */
export interface JobPayload {
  task: 'describe' | 'ocr' | 'extract';
  [key: string]: unknown;
}

/** Full persisted record. `jobId` is redundant with the Redis key suffix
 *  but stored in the value too so callers don't need the key to identify it. */
export interface JobRecord {
  jobId: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
  payload: JobPayload;
  result: unknown | null;
  error: JobError | null;
}

export interface EnqueueInput {
  /** Override the generated UUID. Primarily for deterministic tests. */
  jobId?: string;
  payload: JobPayload;
}

/** Patch accepted by {@link JobStore.update}. `null` is a legal value to
 *  clear `completedAt`, `result`, or `error`. */
export interface JobUpdate {
  status?: JobStatus;
  attempts?: number;
  completedAt?: string | null;
  result?: unknown | null;
  error?: JobError | null;
  payload?: JobPayload;
}

/** Event published to `retina:job:<id>`. `status` carries running/queued
 *  transitions so SSE subscribers don't need a separate GET to hydrate.
 *  Terminal events (`completed`, `failed`) close the SSE stream in R18. */
export type JobEvent =
  | { type: 'status'; status: JobStatus; attempts?: number }
  | { type: 'completed'; result: unknown; completedAt: string }
  | { type: 'failed'; error: JobError; completedAt: string };

/** Handle returned by {@link JobStore.subscribe}. Call `unsubscribe()` to
 *  tear down the duplicated subscriber connection. */
export interface JobSubscription {
  unsubscribe: () => Promise<void>;
}

/** Small structural slice of ioredis used by this module. Using a narrow
 *  interface keeps `JobStore` easy to fake in unit tests while still
 *  matching the real `Redis` class. */
type JobStoreRedis = Pick<
  IORedis,
  | 'set'
  | 'get'
  | 'lpush'
  | 'lrem'
  | 'brpoplpush'
  | 'publish'
  | 'subscribe'
  | 'unsubscribe'
  | 'on'
  | 'disconnect'
  | 'duplicate'
>;

/**
 * Redis-backed implementation of the job lifecycle. Construct with an
 * already-connected ioredis client; do not share the same client with the
 * HTTP layer if you also intend to use blocking `claim()` calls from it —
 * blocking commands tie up the connection for the whole block window.
 */
export class JobStore {
  private readonly redis: JobStoreRedis;

  constructor(redis: IORedis) {
    this.redis = redis;
  }

  /**
   * Persist a new job and push its id onto the queue.
   *
   * Uses two individual commands (SET + LPUSH) rather than a MULTI
   * transaction because the intermediate inconsistency window is
   * harmless: if LPUSH fails, the record is orphaned (no worker will
   * ever pick it up) and expires by the record TTL once it is applied
   * via `complete`. Avoiding MULTI keeps the implementation trivial
   * to port to a different backend later.
   */
  async enqueue(input: EnqueueInput): Promise<JobRecord> {
    const jobId = input.jobId ?? randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      completedAt: null,
      payload: input.payload,
      result: null,
      error: null,
    };
    await this.redis.set(jobKey(jobId), JSON.stringify(record));
    await this.redis.lpush(QUEUE_KEY, jobId);
    return record;
  }

  /**
   * Blocking atomic claim. Moves the right-most jobId from `retina:queue`
   * into `retina:processing` and returns the corresponding record.
   *
   * `blockSec` is the BRPOPLPUSH timeout (0 = block forever). Returns
   * `null` when the window elapses with an empty queue. If the jobId is
   * popped but the backing record is missing (TTL'd between enqueue and
   * claim) this returns `null` after silently reconciling the list.
   *
   * Note: BRPOPLPUSH was deprecated in Redis 6.2 in favor of BLMOVE.
   * ioredis still exposes `brpoplpush` and Redis continues to support it;
   * the task description pins this API shape. Swap to `blmove` in a
   * future cleanup task if we ever raise the minimum Redis version.
   */
  async claim(blockSec: number): Promise<JobRecord | null> {
    const id = await this.redis.brpoplpush(QUEUE_KEY, PROCESSING_KEY, blockSec);
    if (id === null || id === undefined) return null;
    const record = await this.get(id);
    if (record === null) {
      // Record vanished (TTL expired or manual delete) — reconcile the
      // processing list so we don't leak a phantom entry.
      await this.remove(id);
      return null;
    }
    return record;
  }

  /** Load a job record. Returns `null` when the record is missing or
   *  its TTL has expired. */
  async get(jobId: string): Promise<JobRecord | null> {
    const raw = await this.redis.get(jobKey(jobId));
    if (raw === null) return null;
    return JSON.parse(raw) as JobRecord;
  }

  /**
   * Apply a shallow patch. The store reads the current record, merges
   * the patch, and writes the result back. Read-modify-write is safe for
   * the single-writer-per-job model (only the worker that claimed the
   * id mutates it); there is no compare-and-swap here on purpose.
   *
   * @throws Error when the job no longer exists.
   */
  async update(jobId: string, patch: JobUpdate): Promise<JobRecord> {
    const current = await this.get(jobId);
    if (current === null) {
      throw new Error(`Cannot update unknown job ${jobId}`);
    }
    const next: JobRecord = { ...current, ...patch };
    await this.redis.set(jobKey(jobId), JSON.stringify(next));
    return next;
  }

  /**
   * Terminal success path. Writes `result` + `status: 'completed'` +
   * `completedAt` and applies the record-level TTL atomically via
   * `SET ... EX`. Callers pass `JOB_RESULT_TTL_SECONDS` from config.
   *
   * @throws Error when the job no longer exists.
   */
  async complete(jobId: string, result: unknown, ttlSeconds: number): Promise<JobRecord> {
    const current = await this.get(jobId);
    if (current === null) {
      throw new Error(`Cannot complete unknown job ${jobId}`);
    }
    const next: JobRecord = {
      ...current,
      status: 'completed',
      result,
      completedAt: new Date().toISOString(),
      error: null,
    };
    await this.redis.set(jobKey(jobId), JSON.stringify(next), 'EX', ttlSeconds);
    return next;
  }

  /**
   * Terminal failure path. Writes `status: 'failed'`, `error`, and
   * `completedAt`. No TTL is applied here — the spec only mandates a
   * TTL on the result of successful jobs. Operators can tune that
   * separately if needed.
   *
   * @throws Error when the job no longer exists.
   */
  async fail(jobId: string, error: JobError): Promise<JobRecord> {
    const current = await this.get(jobId);
    if (current === null) {
      throw new Error(`Cannot fail unknown job ${jobId}`);
    }
    const next: JobRecord = {
      ...current,
      status: 'failed',
      error,
      completedAt: new Date().toISOString(),
    };
    await this.redis.set(jobKey(jobId), JSON.stringify(next));
    return next;
  }

  /**
   * Remove a jobId from `retina:processing`. Workers call this on
   * terminal state (completed or failed — not on requeue, where the id
   * is moved back to `retina:queue` with a backoff). Returns the number
   * of removed entries (0 or 1).
   */
  async remove(jobId: string): Promise<number> {
    return this.redis.lrem(PROCESSING_KEY, 1, jobId);
  }

  /**
   * Publish an event to `retina:job:<id>`. Returns the number of
   * subscribers that received it (useful for tests; unused by workers).
   */
  async publish(jobId: string, event: JobEvent): Promise<number> {
    return this.redis.publish(jobChannel(jobId), JSON.stringify(event));
  }

  /**
   * Subscribe to a job's event channel. A dedicated subscriber is created
   * via `redis.duplicate()` because a connection in subscriber mode
   * cannot issue normal commands (ioredis best practice — see
   * https://github.com/redis/ioredis#pubsub).
   *
   * Malformed event payloads are ignored rather than surfaced — the
   * channel is internal and a bad payload would only come from a buggy
   * publisher, which we'd rather keep the SSE stream alive through.
   */
  async subscribe(jobId: string, handler: (event: JobEvent) => void): Promise<JobSubscription> {
    const subscriber = this.redis.duplicate();
    const channel = jobChannel(jobId);
    subscriber.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      let parsed: JobEvent;
      try {
        parsed = JSON.parse(message) as JobEvent;
      } catch {
        return;
      }
      handler(parsed);
    });
    await subscriber.subscribe(channel);
    return {
      unsubscribe: async () => {
        try {
          await subscriber.unsubscribe(channel);
        } finally {
          subscriber.disconnect();
        }
      },
    };
  }
}
