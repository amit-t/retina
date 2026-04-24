/**
 * Async-job worker loop.
 *
 * `startWorkers({config, store, router, tasks, logger})` spawns
 * `WORKER_CONCURRENCY` coroutines that each:
 *
 *   1. `claim(blockSec)` — blocking BRPOPLPUSH retina:queue → retina:processing
 *      (implemented by the R14 `JobStore`). A `null` return means the block
 *      timed out; the coroutine then rechecks the shutdown signal and re-claims.
 *   2. `update(id, {status: 'running', attempts: attempts+1})` + publish
 *      `status:running` on the `retina:job:<id>` channel.
 *   3. Dispatch to `tasks.describe | ocr | extract` keyed by the stored job
 *      payload's `task` field.
 *   4. On success → `complete(id, result, JOB_RESULT_TTL_SECONDS)` → publish
 *      `completed` → `remove(id)` (LREM retina:processing).
 *   5. On failure:
 *        - if `attempts < JOB_MAX_ATTEMPTS` → `remove(id)`, sleep
 *          `RETRY_BACKOFF_MS * 2^(attempts-1)`, `requeue(id)` (LPUSH back onto
 *          retina:queue). The next claim bumps `attempts` again.
 *        - else → `fail(id, error)` → publish `failed` → `remove(id)`.
 *
 * Spec: docs/superpowers/specs/2026-04-21-retina-image-api-design.md §Async job.
 * Invariant 11 (constitution): callback webhooks are success-only; R16 handles
 * the POST — this module only emits the terminal `completed`/`failed` events.
 * Invariant 10: async jobs are NOT time-capped per-job; the worker stays on
 * one job until the task returns.
 *
 * `JobStore` / task runners are declared as structural interfaces so R15 can
 * land ahead of R14 and compose with R08/R09/R11 adapters injected by the
 * R13 bootstrap.
 */

import type { Logger } from 'pino';

/** Task verb stored in a job payload. Mirrors `TaskName` in R08/R09/R11. */
export type JobTaskName = 'describe' | 'ocr' | 'extract';

/**
 * Terminal job lifecycle states. `queued` and `running` are intermediate;
 * `completed` and `failed` are terminal. Mirrors the `JobStatus` in
 * `src/http/schemas.ts` and spec §`GET /v1/jobs/:id`.
 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

/**
 * What `POST /v1/jobs` wrote into Redis via `JobStore.enqueue`. The worker
 * treats the payload as opaque beyond the `task` discriminator — task
 * runners know the full shape of their own inputs.
 */
export interface JobPayload {
  task: JobTaskName;
  readonly [key: string]: unknown;
}

/** Error shape stored on the job record + published on the `failed` event. */
export interface JobErrorPayload {
  code: string;
  message: string;
}

/** Durable job record returned by `JobStore.get`. */
export interface JobRecord {
  id: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  completedAt?: string | null;
  payload: JobPayload;
  result?: unknown;
  error?: JobErrorPayload | null;
}

/**
 * Events published to the `retina:job:<id>` pub/sub channel. Mirrored by the
 * R18 SSE stream. Only three event types in MVP; `progress` is reserved for
 * Phase 2 (see constitution Non-goals and spec §`GET /v1/jobs/:id/stream`).
 */
export type JobEvent =
  | { event: 'status'; status: 'running' }
  | { event: 'completed'; result: unknown }
  | { event: 'failed'; error: JobErrorPayload };

/**
 * Structural contract the worker requires from R14's `JobStore`. Listed here
 * so the worker can be unit-tested with a lightweight mock, and so R14 can
 * land independently (any class satisfying this shape will slot in).
 */
export interface WorkerJobStore {
  /** BRPOPLPUSH retina:queue retina:processing; returns the id or `null` on
   *  block timeout. */
  claim(blockSeconds: number): Promise<string | null>;
  /** Load the durable record; `null` if the id expired or never existed. */
  get(id: string): Promise<JobRecord | null>;
  /** Patch a subset of mutable fields (typically `status`, `attempts`). */
  update(
    id: string,
    patch: Partial<Pick<JobRecord, 'status' | 'attempts' | 'completedAt'>>,
  ): Promise<void>;
  /** Terminal success: write result + status=completed + completedAt with TTL. */
  complete(id: string, result: unknown, ttlSeconds: number): Promise<void>;
  /** Terminal failure: write error + status=failed. */
  fail(id: string, error: JobErrorPayload): Promise<void>;
  /** Put the id back onto retina:queue (LPUSH) without resetting attempts. */
  requeue(id: string): Promise<void>;
  /** LREM retina:processing 1 <id>. Idempotent: no-op if the id isn't there. */
  remove(id: string): Promise<void>;
  /** PUBLISH `retina:job:<id>` <JSON event>. */
  publish(id: string, event: JobEvent): Promise<void>;
}

/**
 * Task-runner dispatch table. Each entry adapts the opaque `JobPayload` into
 * the task's concrete input (see R08 `runDescribe` / R09 `runOcr` / R11
 * `runExtract`) and invokes the router. The adapter layer lives in the
 * bootstrap (R13) so this module stays agnostic of wire shapes.
 */
export interface WorkerTaskRunners<Router> {
  describe(router: Router, payload: JobPayload): Promise<unknown>;
  ocr(router: Router, payload: JobPayload): Promise<unknown>;
  extract(router: Router, payload: JobPayload): Promise<unknown>;
}

/**
 * Structural slice of R03 `Config`. Full `Config` satisfies this — listed as
 * its own interface so test doubles and the R20 e2e harness can supply only
 * the fields the worker actually reads.
 */
export interface WorkerConfig {
  readonly WORKER_CONCURRENCY: number;
  readonly JOB_MAX_ATTEMPTS: number;
  readonly JOB_RESULT_TTL_SECONDS: number;
  readonly RETRY_BACKOFF_MS: number;
  /** Seconds passed to `store.claim`. Tunable at the worker boundary so
   *  tests don't block on a 1+ s BRPOPLPUSH timeout; defaults to 1 s. */
  readonly CLAIM_BLOCK_SECONDS?: number;
}

/** Sleep abstraction — overridable in tests to skip/assert backoff waits. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface StartWorkersDeps<Router> {
  config: WorkerConfig;
  store: WorkerJobStore;
  router: Router;
  tasks: WorkerTaskRunners<Router>;
  logger: Logger;
  /** Optional injected sleep. Defaults to an abortable setTimeout wrapper. */
  sleep?: SleepFn;
}

/** Handle returned by `startWorkers` — used by R28 graceful-shutdown hook. */
export interface WorkerHandle {
  /** Stops claiming new work and awaits in-flight job processing to drain. */
  shutdown(): Promise<void>;
}

const DEFAULT_CLAIM_BLOCK_SECONDS = 1;

export function startWorkers<Router>(deps: StartWorkersDeps<Router>): WorkerHandle {
  const { config, store, router, tasks, logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  const concurrency = Math.max(1, config.WORKER_CONCURRENCY);
  const blockSeconds = config.CLAIM_BLOCK_SECONDS ?? DEFAULT_CLAIM_BLOCK_SECONDS;

  const shutdownSignal = new AbortController();
  const coroutines: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    coroutines.push(runWorker(i));
  }

  async function runWorker(workerIndex: number): Promise<void> {
    const workerLog = logger.child({ workerIndex });
    while (!shutdownSignal.signal.aborted) {
      let id: string | null;
      try {
        id = await store.claim(blockSeconds);
      } catch (err) {
        if (shutdownSignal.signal.aborted) return;
        workerLog.error({ err }, 'job_claim_failed');
        // Back off briefly before retrying claim — avoids a hot loop when
        // Redis is down. Aborts immediately on shutdown.
        await sleep(blockSeconds * 1000, shutdownSignal.signal).catch(() => {});
        continue;
      }
      if (id === null) continue;
      await processJob(id, workerLog);
    }
  }

  async function processJob(id: string, log: Logger): Promise<void> {
    const jobLog = log.child({ jobId: id });
    let attempts = 0;
    try {
      const record = await store.get(id);
      if (record === null) {
        // Id claimed from the queue but the record TTL'd out underneath us —
        // clear from processing list so we don't leak it.
        jobLog.warn('job_missing_on_claim');
        await store.remove(id);
        return;
      }

      attempts = record.attempts + 1;
      await store.update(id, { status: 'running', attempts });
      await store.publish(id, { event: 'status', status: 'running' });

      const result = await runTask(record.payload, jobLog);
      await store.complete(id, result, config.JOB_RESULT_TTL_SECONDS);
      await store.publish(id, { event: 'completed', result });
      await store.remove(id);
      jobLog.info({ attempts }, 'job_completed');
    } catch (err) {
      await handleFailure(id, attempts, err, jobLog);
    }
  }

  async function handleFailure(
    id: string,
    attempts: number,
    err: unknown,
    jobLog: Logger,
  ): Promise<void> {
    const errorPayload = toErrorPayload(err);

    // `attempts` is 0 when the failure occurred before the running-state
    // update landed (e.g. store.get or store.update itself threw). Treat as
    // unrecoverable — if we can't even read the job, we can't retry it
    // safely. Attempt the remove so the id doesn't leak in processing.
    if (attempts === 0) {
      jobLog.error({ err: errorPayload }, 'job_process_unexpected');
      try {
        await store.remove(id);
      } catch (removeErr) {
        jobLog.error({ err: removeErr }, 'job_remove_failed');
      }
      return;
    }

    if (attempts < config.JOB_MAX_ATTEMPTS) {
      const delayMs = config.RETRY_BACKOFF_MS * 2 ** (attempts - 1);
      jobLog.warn({ err: errorPayload, attempts, delayMs }, 'job_retry_requeue');
      try {
        await store.remove(id);
        // Shutdown during backoff: abort the wait and requeue immediately so
        // the job survives the shutdown window (replacement container picks
        // it up on next claim).
        await sleep(delayMs, shutdownSignal.signal).catch(() => {});
        await store.requeue(id);
      } catch (requeueErr) {
        jobLog.error({ err: requeueErr, attempts }, 'job_requeue_failed');
      }
      return;
    }

    jobLog.error({ err: errorPayload, attempts }, 'job_failed');
    try {
      await store.fail(id, errorPayload);
      await store.publish(id, { event: 'failed', error: errorPayload });
      await store.remove(id);
    } catch (failErr) {
      jobLog.error({ err: failErr }, 'job_fail_persist_failed');
    }
  }

  async function runTask(payload: JobPayload, jobLog: Logger): Promise<unknown> {
    const runner = tasks[payload.task];
    if (runner === undefined) {
      // Unknown discriminator — an enqueued payload with a task string the
      // worker doesn't know how to run. Surfacing this as an error lets the
      // retry/fail machinery record it just like a provider failure.
      jobLog.error({ task: payload.task }, 'job_unknown_task');
      throw new UnknownTaskError(payload.task);
    }
    return runner(router, payload);
  }

  return {
    async shutdown(): Promise<void> {
      shutdownSignal.abort();
      await Promise.allSettled(coroutines);
    },
  };
}

/** Internal marker error for an unsupported `payload.task` value. */
class UnknownTaskError extends Error {
  readonly code = 'invalid_request';
  constructor(task: string) {
    super(`Unknown job task "${task}"`);
    this.name = 'UnknownTaskError';
  }
}

function toErrorPayload(err: unknown): JobErrorPayload {
  if (err !== null && typeof err === 'object') {
    const candidate = err as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : 'internal_error';
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'Unknown error';
    return { code, message };
  }
  return { code: 'internal_error', message: String(err) };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
