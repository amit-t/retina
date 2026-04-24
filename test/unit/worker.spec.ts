// Unit tests for `startWorkers` (R15).
//
// All tests use a lightweight in-memory `JobStore` double + scripted task
// runners. Backoff sleep is stubbed so tests don't wait wall-clock seconds.
// Covers the full lifecycle contract from fix_plan R15:
//   1. success
//   2. retry-then-succeed (bumps attempts, requeue, then completes)
//   3. exhaustion-fails (attempts === JOB_MAX_ATTEMPTS → fail + publish failed)
//   4. event order (status:running → completed | failed)
//   5. LREM on terminal (remove(id) called for both success + failed paths)
//   6. shutdown drains (shutdown waits for the in-flight job to finish)
// plus extras: unknown-task surfaces as a job failure; ctor tolerates single
// worker concurrency; requeue skips delay on shutdown-during-backoff.

import { type Logger, pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type JobEvent,
  type JobPayload,
  type JobRecord,
  type SleepFn,
  startWorkers,
  type WorkerJobStore,
  type WorkerTaskRunners,
} from '../../src/jobs/worker.js';

const silentLogger: Logger = pino({ level: 'silent' });

/** Mutable fields exposed on the in-memory store for assertions. */
interface StoreCall {
  method: string;
  args: unknown[];
}

interface FakeStore extends WorkerJobStore {
  records: Map<string, JobRecord>;
  calls: StoreCall[];
  events: JobEvent[];
  queue: string[];
  processing: string[];
  /** Resolvers for coordinating `claim()` with the test body. */
  _claimResolvers: Array<(id: string | null) => void>;
}

/** Build an in-memory JobStore test double that tracks every method call. */
function makeStore(initial: Record<string, JobRecord> = {}): FakeStore {
  const records = new Map<string, JobRecord>(Object.entries(initial));
  const calls: StoreCall[] = [];
  const events: JobEvent[] = [];
  const queue: string[] = [];
  const processing: string[] = [];
  const claimResolvers: Array<(id: string | null) => void> = [];

  const store: FakeStore = {
    records,
    calls,
    events,
    queue,
    processing,
    _claimResolvers: claimResolvers,

    async claim(blockSeconds: number) {
      calls.push({ method: 'claim', args: [blockSeconds] });
      // If the queue already has ids, pop synchronously. Otherwise park a
      // resolver so the test can hand-feed ids or simulate block timeouts.
      if (queue.length > 0) {
        const id = queue.shift();
        if (id !== undefined) {
          processing.push(id);
          return id;
        }
      }
      return new Promise<string | null>((resolve) => {
        claimResolvers.push((id) => {
          if (typeof id === 'string') {
            processing.push(id);
          }
          resolve(id);
        });
      });
    },

    async get(id: string) {
      calls.push({ method: 'get', args: [id] });
      return records.get(id) ?? null;
    },

    async update(id, patch) {
      calls.push({ method: 'update', args: [id, patch] });
      const existing = records.get(id);
      if (existing) records.set(id, { ...existing, ...patch });
    },

    async complete(id, result, ttlSeconds) {
      calls.push({ method: 'complete', args: [id, result, ttlSeconds] });
      const existing = records.get(id);
      if (existing) {
        records.set(id, {
          ...existing,
          status: 'completed',
          result,
          completedAt: new Date(0).toISOString(),
        });
      }
    },

    async fail(id, error) {
      calls.push({ method: 'fail', args: [id, error] });
      const existing = records.get(id);
      if (existing) {
        records.set(id, { ...existing, status: 'failed', error });
      }
    },

    async requeue(id) {
      calls.push({ method: 'requeue', args: [id] });
      queue.push(id);
    },

    async remove(id) {
      calls.push({ method: 'remove', args: [id] });
      const idx = processing.indexOf(id);
      if (idx >= 0) processing.splice(idx, 1);
    },

    async publish(id, event) {
      calls.push({ method: 'publish', args: [id, event] });
      events.push(event);
    },
  };

  return store;
}

/** Push an id onto the queue and wake the next parked `claim()` caller.
 *  The parked resolver inside `claim()` is responsible for updating the
 *  processing list so we DON'T touch it here — doing both would leak a
 *  duplicate id into the processing list. */
function deliver(store: FakeStore, id: string): void {
  const waiter = store._claimResolvers.shift();
  if (waiter) {
    waiter(id);
    return;
  }
  store.queue.push(id);
}

/** Resolve all parked `claim()` callers with `null` to simulate block timeouts. */
function timeoutAllClaims(store: FakeStore): void {
  while (store._claimResolvers.length > 0) {
    const waiter = store._claimResolvers.shift();
    waiter?.(null);
  }
}

function makeRecord(id: string, payload: Partial<JobPayload> = {}): JobRecord {
  return {
    id,
    status: 'queued',
    attempts: 0,
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    payload: { task: 'describe', ...payload } as JobPayload,
  };
}

/** Sleep that resolves immediately — good for tests that don't care about backoff cadence. */
const instantSleep: SleepFn = async () => {};

/** Build task runners object; each runner can be overridden per-case. */
function makeTasks(
  overrides: Partial<WorkerTaskRunners<unknown>> = {},
): WorkerTaskRunners<unknown> {
  const noop = async () => 'default';
  return {
    describe: overrides.describe ?? noop,
    ocr: overrides.ocr ?? noop,
    extract: overrides.extract ?? noop,
  };
}

/** Poll until `predicate` returns true, with a soft wall-clock ceiling. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition timed out');
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

const BASE_CONFIG = {
  WORKER_CONCURRENCY: 1,
  JOB_MAX_ATTEMPTS: 3,
  JOB_RESULT_TTL_SECONDS: 3600,
  RETRY_BACKOFF_MS: 250,
  CLAIM_BLOCK_SECONDS: 1,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('startWorkers — success path', () => {
  it('claims, runs describe, completes, publishes completed, removes from processing', async () => {
    const store = makeStore({ 'job-1': makeRecord('job-1') });
    const describeFn = vi.fn(async () => ({ description: 'ok' }));
    const tasks = makeTasks({ describe: describeFn });

    const handle = startWorkers({
      config: BASE_CONFIG,
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'job-1');

    await waitFor(() => store.records.get('job-1')?.status === 'completed');
    timeoutAllClaims(store); // unblock the next claim call so shutdown returns fast
    await handle.shutdown();

    const record = store.records.get('job-1');
    expect(record?.status).toBe('completed');
    expect(record?.attempts).toBe(1);
    expect(record?.result).toEqual({ description: 'ok' });

    expect(describeFn).toHaveBeenCalledTimes(1);
    expect(describeFn.mock.calls[0]?.[1]).toMatchObject({ task: 'describe' });

    // Processing list drained on terminal state.
    expect(store.processing).not.toContain('job-1');

    // Publish sequence contains status:running → completed.
    expect(store.events).toEqual([
      { event: 'status', status: 'running' },
      { event: 'completed', result: { description: 'ok' } },
    ]);
  });
});

describe('startWorkers — retry then succeed', () => {
  it('first attempt throws → requeue + backoff, second attempt completes; attempts === 2', async () => {
    const store = makeStore({ 'job-retry': makeRecord('job-retry', { task: 'ocr' }) });

    let callCount = 0;
    const ocrFn = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('transient');
      return { text: 'recovered' };
    });
    const tasks = makeTasks({ ocr: ocrFn });

    const sleepFn = vi.fn<SleepFn>(async () => {});

    const handle = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3 },
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: sleepFn,
    });

    // First attempt: claim → fails → requeue pushes back onto queue. The
    // worker's next claim() picks it up synchronously, so we only observe
    // the terminal state; the intermediate "id is on retina:queue" window
    // closes before a test poll could see it.
    deliver(store, 'job-retry');
    await waitFor(() => store.records.get('job-retry')?.status === 'completed');

    timeoutAllClaims(store);
    await handle.shutdown();

    expect(ocrFn).toHaveBeenCalledTimes(2);
    const record = store.records.get('job-retry');
    expect(record?.status).toBe('completed');
    expect(record?.attempts).toBe(2);

    // Backoff sleep was invoked once between attempts with RETRY_BACKOFF_MS * 2^(1-1).
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn.mock.calls[0]?.[0]).toBe(250);

    // Publish sequence: status:running, (requeued), status:running, completed.
    expect(store.events).toEqual([
      { event: 'status', status: 'running' },
      { event: 'status', status: 'running' },
      { event: 'completed', result: { text: 'recovered' } },
    ]);

    // Requeue + remove pattern: on failed attempt we remove + requeue.
    const methodSequence = store.calls.map((c) => c.method);
    expect(methodSequence).toContain('requeue');
    // Processing list empty on terminal.
    expect(store.processing).not.toContain('job-retry');
  });
});

describe('startWorkers — exhaustion fails', () => {
  it('every attempt throws; after JOB_MAX_ATTEMPTS the job is failed + published failed', async () => {
    // attempts starts at 2 so the first failure in THIS run hits
    // attempts === 3 === JOB_MAX_ATTEMPTS → no requeue, immediate fail.
    const seed = { ...makeRecord('job-exhaust'), attempts: 2 };
    const store = makeStore({ 'job-exhaust': seed });

    const describeFn = vi.fn(async () => {
      const e = new Error('still broken') as Error & { code?: string };
      e.code = 'provider_failed';
      throw e;
    });
    const tasks = makeTasks({ describe: describeFn });

    const handle = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3 },
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'job-exhaust');
    await waitFor(() => store.records.get('job-exhaust')?.status === 'failed');
    timeoutAllClaims(store);
    await handle.shutdown();

    expect(describeFn).toHaveBeenCalledTimes(1);
    const record = store.records.get('job-exhaust');
    expect(record?.status).toBe('failed');
    expect(record?.attempts).toBe(3);
    expect(record?.error).toEqual({ code: 'provider_failed', message: 'still broken' });

    // No requeue on the exhaustion path.
    expect(store.calls.find((c) => c.method === 'requeue')).toBeUndefined();

    // Published failed event carries the error payload.
    expect(store.events).toContainEqual({
      event: 'failed',
      error: { code: 'provider_failed', message: 'still broken' },
    });
  });
});

describe('startWorkers — event order', () => {
  it('status:running is published BEFORE the task runs; completed is published AFTER complete()', async () => {
    const store = makeStore({ 'job-order': makeRecord('job-order') });

    const seenAtRuntime: JobEvent[] = [];
    const describeFn = vi.fn(async () => {
      // Snapshot events at the moment the task starts.
      seenAtRuntime.push(...store.events);
      return 'ok';
    });
    const tasks = makeTasks({ describe: describeFn });

    const handle = startWorkers({
      config: BASE_CONFIG,
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'job-order');
    await waitFor(() => store.records.get('job-order')?.status === 'completed');
    timeoutAllClaims(store);
    await handle.shutdown();

    // At task-start time only the running event was published.
    expect(seenAtRuntime).toEqual([{ event: 'status', status: 'running' }]);

    // After completion: running + completed, in that order.
    expect(store.events).toEqual([
      { event: 'status', status: 'running' },
      { event: 'completed', result: 'ok' },
    ]);

    // complete() fired before publish({completed}) at the call-order level.
    const order = store.calls.map((c) => c.method);
    const completeIdx = order.indexOf('complete');
    const publishCompletedIdx = order.findIndex(
      (_m, i) =>
        order[i] === 'publish' &&
        (store.calls[i]?.args[1] as JobEvent | undefined)?.event === 'completed',
    );
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(publishCompletedIdx).toBeGreaterThan(completeIdx);
  });
});

describe('startWorkers — LREM on terminal state', () => {
  it('remove(id) is called on the success path AND on the failed path', async () => {
    // Success case.
    const storeOk = makeStore({ ok: makeRecord('ok') });
    const handleOk = startWorkers({
      config: BASE_CONFIG,
      store: storeOk,
      router: {},
      tasks: makeTasks({ describe: async () => 'x' }),
      logger: silentLogger,
      sleep: instantSleep,
    });
    deliver(storeOk, 'ok');
    await waitFor(() => storeOk.records.get('ok')?.status === 'completed');
    timeoutAllClaims(storeOk);
    await handleOk.shutdown();

    expect(storeOk.calls.filter((c) => c.method === 'remove')).toHaveLength(1);
    expect(storeOk.processing).toEqual([]);

    // Failure case — seed attempts so the single attempt exhausts the budget.
    const storeFail = makeStore({
      fail: { ...makeRecord('fail'), attempts: 2 },
    });
    const handleFail = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3 },
      store: storeFail,
      router: {},
      tasks: makeTasks({
        describe: async () => {
          throw new Error('boom');
        },
      }),
      logger: silentLogger,
      sleep: instantSleep,
    });
    deliver(storeFail, 'fail');
    await waitFor(() => storeFail.records.get('fail')?.status === 'failed');
    timeoutAllClaims(storeFail);
    await handleFail.shutdown();

    expect(storeFail.calls.filter((c) => c.method === 'remove')).toHaveLength(1);
    expect(storeFail.processing).toEqual([]);
  });

  it('remove(id) is called on the retry path so processing list does not leak between attempts', async () => {
    const store = makeStore({ retry: makeRecord('retry') });
    let count = 0;
    const tasks = makeTasks({
      describe: async () => {
        count += 1;
        if (count === 1) throw new Error('first fail');
        return 'second ok';
      },
    });

    const handle = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3 },
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'retry');
    await waitFor(() => store.records.get('retry')?.status === 'completed');
    timeoutAllClaims(store);
    await handle.shutdown();

    // 2 removes: one after the failed first attempt, one after the successful second.
    expect(store.calls.filter((c) => c.method === 'remove')).toHaveLength(2);
    expect(store.processing).toEqual([]);
  });
});

describe('startWorkers — shutdown drains', () => {
  it('shutdown waits for the in-flight job to finish before resolving', async () => {
    const store = makeStore({ 'long-job': makeRecord('long-job') });

    let releaseTask: (() => void) | null = null;
    const describeFn = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          releaseTask = () => resolve('done');
        }),
    );
    const tasks = makeTasks({ describe: describeFn });

    const handle = startWorkers({
      config: BASE_CONFIG,
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: instantSleep,
    });

    // Start processing.
    deliver(store, 'long-job');
    await waitFor(() => describeFn.mock.calls.length === 1);

    // Fire shutdown while the task is mid-flight.
    let shutdownResolved = false;
    const shutdownPromise = handle.shutdown().then(() => {
      shutdownResolved = true;
    });

    // Give the event loop a few microtasks to propagate; shutdown must NOT
    // resolve while the task is still pending.
    await new Promise((r) => setTimeout(r, 30));
    expect(shutdownResolved).toBe(false);
    expect(store.records.get('long-job')?.status).toBe('running');

    // Let the task finish. Shutdown should now drain.
    releaseTask?.();
    await shutdownPromise;

    expect(shutdownResolved).toBe(true);
    const record = store.records.get('long-job');
    expect(record?.status).toBe('completed');
    expect(record?.result).toBe('done');
    expect(store.processing).toEqual([]);
  });

  it('shutdown during backoff aborts the sleep and still requeues the job', async () => {
    const store = makeStore({ 'backoff-job': makeRecord('backoff-job') });

    let sleepAbortSeen: AbortSignal | undefined;
    const sleepFn: SleepFn = (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        sleepAbortSeen = signal;
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

    const tasks = makeTasks({
      describe: async () => {
        throw new Error('transient');
      },
    });

    const handle = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3, RETRY_BACKOFF_MS: 10_000 },
      store,
      router: {},
      tasks,
      logger: silentLogger,
      sleep: sleepFn,
    });

    deliver(store, 'backoff-job');
    // Wait until the task failed and the worker has entered the sleep phase.
    await waitFor(
      () =>
        store.calls.some((c) => c.method === 'remove') &&
        sleepAbortSeen !== undefined &&
        !store.calls.some((c) => c.method === 'requeue'),
    );

    await handle.shutdown();

    // Sleep was given the shutdown signal; requeue happened despite the
    // abort so the job isn't lost during a shutdown window.
    expect(sleepAbortSeen?.aborted).toBe(true);
    expect(store.calls.map((c) => c.method)).toContain('requeue');
    expect(store.queue).toContain('backoff-job');
  });
});

describe('startWorkers — unknown task', () => {
  it('treats an unrecognized payload.task as a failure and follows the retry/fail machinery', async () => {
    const store = makeStore({
      bad: { ...makeRecord('bad', { task: 'describe' }), attempts: 2, payload: { task: 'nope' } },
    });

    const handle = startWorkers({
      config: { ...BASE_CONFIG, JOB_MAX_ATTEMPTS: 3 },
      store,
      router: {},
      tasks: makeTasks(),
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'bad');
    await waitFor(() => store.records.get('bad')?.status === 'failed');
    timeoutAllClaims(store);
    await handle.shutdown();

    const record = store.records.get('bad');
    expect(record?.status).toBe('failed');
    expect(record?.error?.code).toBe('invalid_request');
    expect(record?.error?.message).toMatch(/Unknown job task/);
  });
});

describe('startWorkers — concurrency', () => {
  it('spawns WORKER_CONCURRENCY coroutines and each drains the queue in parallel', async () => {
    const store = makeStore({
      a: makeRecord('a'),
      b: makeRecord('b'),
      c: makeRecord('c'),
    });

    let pending = 0;
    let maxPending = 0;
    const release: Array<() => void> = [];
    const describeFn = vi.fn(async () => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await new Promise<void>((resolve) => release.push(resolve));
      pending -= 1;
      return 'ok';
    });

    const handle = startWorkers({
      config: { ...BASE_CONFIG, WORKER_CONCURRENCY: 3 },
      store,
      router: {},
      tasks: makeTasks({ describe: describeFn }),
      logger: silentLogger,
      sleep: instantSleep,
    });

    deliver(store, 'a');
    deliver(store, 'b');
    deliver(store, 'c');

    await waitFor(() => release.length === 3);
    expect(maxPending).toBe(3);
    release.forEach((fn) => {
      fn();
    });
    await waitFor(() => describeFn.mock.calls.length === 3);

    timeoutAllClaims(store);
    await handle.shutdown();

    for (const id of ['a', 'b', 'c']) {
      expect(store.records.get(id)?.status).toBe('completed');
    }
  });
});
