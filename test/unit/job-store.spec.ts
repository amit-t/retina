// R14 — JobStore unit tests.
//
// Exercises the Redis contract with `ioredis-mock`, which implements the
// ioredis API on top of an in-memory data store (including pub/sub
// channels and the `duplicate()` semantics needed for a separate
// subscriber connection).
//
// Scope (matches the R14 acceptance criteria):
//   - enqueue → claim → update → complete happy path
//   - `complete` applies the TTL on the record key
//   - `remove` clears the processing list
//   - `publish` / `subscribe` delivers the event payload
//
// We cast the `ioredis-mock` instance to the concrete `Redis` type
// because the mock intentionally mirrors the shape 1:1 but ships no
// bundled `.d.ts` — the cast keeps type-safety for `JobStore` without
// pulling in a separate shim.

import type { Redis as IORedis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type JobEvent,
  JobStore,
  jobChannel,
  jobKey,
  PROCESSING_KEY,
  QUEUE_KEY,
} from '../../src/jobs/store.ts';

// Small helper: wait until `predicate` is true or the window elapses.
// Used for asserting on async pub/sub delivery without relying on fake
// timers (ioredis-mock emits synchronously but we still go through a
// microtask boundary via `await`).
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 500, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: predicate never became truthy');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('JobStore (R14)', () => {
  let redis: IORedis;
  let store: JobStore;

  beforeEach(async () => {
    // ioredis-mock's default data store is process-global (see its
    // README note on multi-instance data sharing), so isolate tests by
    // flushing at the top of each case. That matches how a real test
    // harness would behave against a throwaway testcontainer.
    redis = new RedisMock() as unknown as IORedis;
    await redis.flushall();
    store = new JobStore(redis);
  });

  afterEach(async () => {
    await redis.flushall();
    redis.disconnect();
  });

  describe('enqueue', () => {
    it('writes the record under retina:job:<id> and LPUSHes onto retina:queue', async () => {
      const record = await store.enqueue({
        jobId: 'job-1',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' } },
      });

      expect(record).toMatchObject({
        jobId: 'job-1',
        status: 'queued',
        attempts: 0,
        completedAt: null,
        result: null,
        error: null,
      });
      expect(typeof record.createdAt).toBe('string');
      expect(() => new Date(record.createdAt).toISOString()).not.toThrow();

      // Record lives under the spec'd key.
      const raw = await redis.get(jobKey('job-1'));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual(record);

      // Queue carries the jobId.
      expect(await redis.llen(QUEUE_KEY)).toBe(1);
      expect(await redis.lindex(QUEUE_KEY, 0)).toBe('job-1');
    });

    it('auto-generates a UUID-shaped jobId when the caller omits one', async () => {
      const record = await store.enqueue({
        payload: { task: 'ocr', image: { url: 'https://ex/b.png' } },
      });
      expect(record.jobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe('claim', () => {
    it('atomically moves the oldest jobId from queue → processing and returns the record', async () => {
      await store.enqueue({
        jobId: 'job-a',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' } },
      });
      await store.enqueue({
        jobId: 'job-b',
        payload: { task: 'describe', image: { url: 'https://ex/b.png' } },
      });

      // FIFO: LPUSH + BRPOPLPUSH → the first-enqueued id claims first.
      const claimed = await store.claim(1);
      expect(claimed?.jobId).toBe('job-a');

      // Queue shrinks, processing grows.
      expect(await redis.llen(QUEUE_KEY)).toBe(1);
      expect(await redis.llen(PROCESSING_KEY)).toBe(1);
      expect(await redis.lindex(PROCESSING_KEY, 0)).toBe('job-a');
    });

    it('returns null when the queue is empty', async () => {
      // ioredis-mock's brpoplpush is non-blocking (delegates to rpoplpush)
      // — on an empty list it returns null immediately, which matches the
      // production BRPOPLPUSH contract after the timeout elapses.
      const claimed = await store.claim(1);
      expect(claimed).toBeNull();
      expect(await redis.llen(PROCESSING_KEY)).toBe(0);
    });
  });

  describe('enqueue → claim → update → complete happy path', () => {
    it('carries the record through every lifecycle write with the right side effects', async () => {
      // 1. enqueue
      const enq = await store.enqueue({
        jobId: 'job-happy',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' }, prompt: 'hi' },
      });
      expect(enq.status).toBe('queued');
      expect(await redis.llen(QUEUE_KEY)).toBe(1);

      // 2. claim — moves queue → processing, record still reports queued
      //    (the worker patches it to "running" next).
      const claimed = await store.claim(1);
      expect(claimed?.jobId).toBe('job-happy');
      expect(claimed?.status).toBe('queued');
      expect(await redis.llen(QUEUE_KEY)).toBe(0);
      expect(await redis.llen(PROCESSING_KEY)).toBe(1);

      // 3. update — worker bumps to running + attempts=1.
      const running = await store.update('job-happy', { status: 'running', attempts: 1 });
      expect(running.status).toBe('running');
      expect(running.attempts).toBe(1);
      expect(running.payload).toEqual(enq.payload);

      // 4. complete — writes result + terminal status + TTL.
      const result = { description: 'a dog', provider: 'openai', model: 'gpt-test', usage: {} };
      const completed = await store.complete('job-happy', result, 3600);
      expect(completed.status).toBe('completed');
      expect(completed.result).toEqual(result);
      expect(completed.error).toBeNull();
      expect(typeof completed.completedAt).toBe('string');

      // Persisted view matches what `complete` returned.
      const readBack = await store.get('job-happy');
      expect(readBack).toEqual(completed);
    });
  });

  describe('complete', () => {
    it('applies the TTL atomically on the record key', async () => {
      await store.enqueue({
        jobId: 'job-ttl',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' } },
      });

      // Pre-complete: no TTL set — -1 per Redis semantics (`PERSIST`-ish).
      expect(await redis.ttl(jobKey('job-ttl'))).toBe(-1);

      await store.complete('job-ttl', { ok: true }, 120);

      const ttl = await redis.ttl(jobKey('job-ttl'));
      // TTL is applied; allow a small drift in case the mock records it
      // as the ceiling value rather than exactly-120.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it('throws when completing a job that no longer exists', async () => {
      await expect(store.complete('missing', { x: 1 }, 60)).rejects.toThrow(/unknown job/);
    });
  });

  describe('fail', () => {
    it('writes status=failed with the error envelope and a completedAt', async () => {
      await store.enqueue({
        jobId: 'job-fail',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' } },
      });

      const failed = await store.fail('job-fail', {
        code: 'provider_failed',
        message: 'upstream went boom',
      });

      expect(failed.status).toBe('failed');
      expect(failed.error).toEqual({
        code: 'provider_failed',
        message: 'upstream went boom',
      });
      expect(failed.completedAt).not.toBeNull();

      const readBack = await store.get('job-fail');
      expect(readBack).toEqual(failed);
    });
  });

  describe('remove', () => {
    it('deletes the jobId from retina:processing (worker terminal-state cleanup)', async () => {
      await store.enqueue({
        jobId: 'job-rm',
        payload: { task: 'describe', image: { url: 'https://ex/a.png' } },
      });
      await store.claim(1);
      expect(await redis.llen(PROCESSING_KEY)).toBe(1);

      const removed = await store.remove('job-rm');
      expect(removed).toBe(1);
      expect(await redis.llen(PROCESSING_KEY)).toBe(0);
    });

    it('returns 0 when the id is not on the processing list', async () => {
      expect(await store.remove('never-existed')).toBe(0);
    });
  });

  describe('publish / subscribe', () => {
    it('delivers published events on the retina:job:<id> channel to a subscriber', async () => {
      const received: JobEvent[] = [];
      const subscription = await store.subscribe('job-pub', (event) => {
        received.push(event);
      });

      await store.publish('job-pub', { type: 'status', status: 'running', attempts: 1 });
      await store.publish('job-pub', {
        type: 'completed',
        result: { ok: true },
        completedAt: '2026-04-21T00:00:00.000Z',
      });

      await waitFor(() => received.length >= 2);

      expect(received).toEqual([
        { type: 'status', status: 'running', attempts: 1 },
        { type: 'completed', result: { ok: true }, completedAt: '2026-04-21T00:00:00.000Z' },
      ]);

      await subscription.unsubscribe();
    });

    it('does not leak events from other jobs to the subscriber', async () => {
      const received: JobEvent[] = [];
      const subscription = await store.subscribe('job-isolated', (event) => {
        received.push(event);
      });

      await store.publish('other-job', { type: 'status', status: 'running' });
      await store.publish('job-isolated', {
        type: 'failed',
        error: { code: 'provider_failed', message: 'bad' },
        completedAt: '2026-04-21T00:00:00.000Z',
      });

      await waitFor(() => received.length >= 1);

      expect(received).toEqual([
        {
          type: 'failed',
          error: { code: 'provider_failed', message: 'bad' },
          completedAt: '2026-04-21T00:00:00.000Z',
        },
      ]);

      await subscription.unsubscribe();
    });

    it('stops delivering after unsubscribe()', async () => {
      const received: JobEvent[] = [];
      const subscription = await store.subscribe('job-unsub', (event) => {
        received.push(event);
      });

      await store.publish('job-unsub', { type: 'status', status: 'running' });
      await waitFor(() => received.length >= 1);

      await subscription.unsubscribe();

      await store.publish('job-unsub', { type: 'status', status: 'completed' });
      // Give any stray listener a chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 20));

      expect(received).toHaveLength(1);
    });

    it('uses the channel naming convention documented in the spec', () => {
      expect(jobChannel('foo')).toBe('retina:job:foo');
      expect(jobKey('foo')).toBe('retina:job:foo');
      expect(QUEUE_KEY).toBe('retina:queue');
      expect(PROCESSING_KEY).toBe('retina:processing');
    });
  });

  describe('get / update error paths', () => {
    it('returns null for an unknown jobId', async () => {
      expect(await store.get('never')).toBeNull();
    });

    it('throws when updating a job that no longer exists', async () => {
      await expect(store.update('never', { status: 'running' })).rejects.toThrow(/unknown job/);
    });
  });
});
