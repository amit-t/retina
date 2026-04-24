// R17 — POST /v1/jobs + GET /v1/jobs/:id route composition test.
//
// Exercises the jobs routes end-to-end through `buildApp()`:
//
//   request-id → size-limit → jobs route (Zod → normalize → JobStore)
//                                               ↓
//                                        error middleware
//
// The `JobStore` is a hand-rolled structural test double. That's both
// simpler and more precise than mocking the real ioredis-backed
// `JobStore` class (which lands in R14); the route only needs the
// `enqueue` + `get` surface for the MVP endpoints R17 covers.
//
// Redis-side assertions (fix_plan acceptance: "`retina:queue` length +1")
// are proven through the mocked store's captured LPUSH-equivalent
// recorder — i.e. we assert the route invoked `enqueue` with the
// normalized + task-specific payload exactly once per POST. R14's
// `job-store.spec.ts` covers the real Redis list semantics with
// ioredis-mock; layering that here would re-test R14 inside an R17 suite.

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';
import type {
  DescribeResponse,
  JobRecordResponse,
  JobsEnqueueResponse,
} from '../../src/http/schemas.ts';
import type { EnqueueInput, JobPayload, JobRecord, JobStore } from '../../src/jobs/store.ts';

// Minimal valid PNG: 8-byte signature + a couple bytes so `normalize`'s
// base64 magic-byte sniff agrees with the declared mime.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('xy'),
]);
const PNG_BASE64 = PNG_BYTES.toString('base64');

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

interface RecordingStore {
  enqueued: EnqueueInput[];
  getCalls: string[];
  enqueue: JobStore['enqueue'];
  get: JobStore['get'];
}

/** Build a structural JobStore double that records every `enqueue`/`get` call.
 *  The route only uses `enqueue` + `get` so we implement just those two. */
function makeStore(opts?: {
  enqueue?: (input: EnqueueInput) => Promise<JobRecord>;
  get?: (id: string) => Promise<JobRecord | null>;
}): RecordingStore {
  const enqueued: EnqueueInput[] = [];
  const getCalls: string[] = [];
  const now = '2026-04-23T00:00:00.000Z';
  const enqueueImpl =
    opts?.enqueue ??
    (async (input: EnqueueInput): Promise<JobRecord> => ({
      jobId: input.jobId ?? 'job-00000000-0000-4000-8000-000000000001',
      status: 'queued',
      attempts: 0,
      createdAt: now,
      completedAt: null,
      payload: input.payload,
      result: null,
      error: null,
    }));
  const getImpl = opts?.get ?? (async () => null);
  return {
    enqueued,
    getCalls,
    async enqueue(input: EnqueueInput): Promise<JobRecord> {
      enqueued.push(input);
      return enqueueImpl(input);
    },
    async get(id: string): Promise<JobRecord | null> {
      getCalls.push(id);
      return getImpl(id);
    },
  } as unknown as RecordingStore;
}

describe('POST /v1/jobs (R17)', () => {
  it('202 — validates, normalizes, enqueues, returns {jobId, status:"queued"}', async () => {
    const store = makeStore({
      enqueue: async (input) => ({
        jobId: 'job-happy-1',
        status: 'queued',
        attempts: 0,
        createdAt: '2026-04-23T00:00:00.000Z',
        completedAt: null,
        payload: input.payload,
        result: null,
        error: null,
      }),
    });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'jobs-happy' },
      body: JSON.stringify({
        task: 'describe',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        prompt: 'describe me',
        maxTokens: 64,
        provider: 'openai',
        callbackUrl: 'https://example.com/cb',
      }),
    });

    expect(res.status).toBe(202);
    expect(res.headers.get('x-request-id')).toBe('jobs-happy');
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as JobsEnqueueResponse;
    expect(body).toEqual({ jobId: 'job-happy-1', status: 'queued' });

    // enqueue() saw the normalized image + task-specific fields + options
    // wrapped in the canonical `{ payload }` envelope. This is the R17
    // acceptance surrogate for "retina:queue length +1": exactly one
    // enqueue call per POST. The real LPUSH lives in R14's JobStore class
    // and is covered by its own spec.
    expect(store.enqueued).toHaveLength(1);
    const input = store.enqueued[0];
    if (!input) throw new Error('expected one enqueue call');
    const payload = input.payload as JobPayload & {
      image: { bytes: Uint8Array; mime: string };
      prompt?: string;
      maxTokens?: number;
      provider?: string;
      callbackUrl?: string;
    };
    expect(payload.task).toBe('describe');
    expect(payload.image.mime).toBe('image/png');
    expect(Buffer.from(payload.image.bytes).equals(PNG_BYTES)).toBe(true);
    expect(payload.prompt).toBe('describe me');
    expect(payload.maxTokens).toBe(64);
    expect(payload.provider).toBe('openai');
    expect(payload.callbackUrl).toBe('https://example.com/cb');
    // Non-set task-specific fields stay absent — no undefined → null drift.
    expect('languages' in payload).toBe(false);
    expect('schema' in payload).toBe(false);
    expect('templateId' in payload).toBe(false);
  });

  it('202 — ocr task forwards languages only (no describe/extract fields)', async () => {
    const store = makeStore();
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'ocr',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        languages: ['en', 'de'],
      }),
    });

    expect(res.status).toBe(202);
    const input = store.enqueued[0];
    if (!input) throw new Error('expected one enqueue call');
    const payload = input.payload as JobPayload & { languages?: string[] };
    expect(payload.task).toBe('ocr');
    expect(payload.languages).toEqual(['en', 'de']);
    expect('prompt' in payload).toBe(false);
    expect('maxTokens' in payload).toBe(false);
    expect('schema' in payload).toBe(false);
    expect('templateId' in payload).toBe(false);
  });

  it('202 — extract task forwards templateId OR schema (XOR)', async () => {
    const store = makeStore();
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'extract',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        templateId: 'invoice-v1',
      }),
    });

    expect(res.status).toBe(202);
    const input = store.enqueued[0];
    if (!input) throw new Error('expected one enqueue call');
    const payload = input.payload as JobPayload & { templateId?: string; schema?: unknown };
    expect(payload.task).toBe('extract');
    expect(payload.templateId).toBe('invoice-v1');
    expect('schema' in payload).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Validation failures
  // ---------------------------------------------------------------------------
  it('400 — malformed JSON body maps to invalid_request envelope', async () => {
    const store = makeStore();
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/valid JSON/i);
    expect(store.enqueued).toHaveLength(0);
  });

  it('400 — missing `task` discriminator maps to invalid_request with Zod issues', async () => {
    const store = makeStore();
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: { path: string; message: string }[] } };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    expect(store.enqueued).toHaveLength(0);
  });

  it('400 — extract task with BOTH schema and templateId rejected (XOR)', async () => {
    const store = makeStore();
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'extract',
        image: { base64: PNG_BASE64, mime: 'image/png' },
        templateId: 'invoice-v1',
        schema: { type: 'object' },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(store.enqueued).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Oversized body
  // ---------------------------------------------------------------------------
  it('413 — base64 image exceeding MAX_IMAGE_BYTES short-circuits before enqueue', async () => {
    const store = makeStore();
    const app = buildApp({
      jobStore: store,
      logger: silentLogger(),
      config: { MAX_IMAGE_BYTES: 4 },
    });

    const res = await app.request('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'describe',
        image: { base64: PNG_BASE64, mime: 'image/png' },
      }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('image_too_large');
    expect(store.enqueued).toHaveLength(0);
  });
});

describe('GET /v1/jobs/:id (R17)', () => {
  const sampleResult: DescribeResponse = {
    description: 'a red ball',
    provider: 'openai',
    model: 'gpt-vision',
    usage: { inputTokens: 10, outputTokens: 2 },
  };

  const sampleDescribePayload: JobPayload = { task: 'describe' };

  it('200 — queued state returns record with nulls for result / completedAt / error', async () => {
    const record: JobRecord = {
      jobId: 'job-q-1',
      status: 'queued',
      attempts: 0,
      createdAt: '2026-04-23T00:00:00.000Z',
      completedAt: null,
      payload: sampleDescribePayload,
      result: null,
      error: null,
    };
    const store = makeStore({ get: async () => record });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs/job-q-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
    const body = (await res.json()) as JobRecordResponse;
    // JobRecordResponse (wire shape) omits `payload`; compare the public
    // projection rather than the full store record.
    expect(body).toEqual({
      jobId: record.jobId,
      status: record.status,
      attempts: record.attempts,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      result: record.result,
      error: record.error,
    });
    expect(store.getCalls).toEqual(['job-q-1']);
  });

  it('200 — running state returns attempts bumped, result still null', async () => {
    const record: JobRecord = {
      jobId: 'job-r-1',
      status: 'running',
      attempts: 1,
      createdAt: '2026-04-23T00:00:00.000Z',
      completedAt: null,
      payload: sampleDescribePayload,
      result: null,
      error: null,
    };
    const store = makeStore({ get: async () => record });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs/job-r-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as JobRecordResponse;
    expect(body.status).toBe('running');
    expect(body.attempts).toBe(1);
    expect(body.result).toBeNull();
  });

  it('200 — completed state returns result payload + completedAt', async () => {
    const record: JobRecord = {
      jobId: 'job-c-1',
      status: 'completed',
      attempts: 1,
      createdAt: '2026-04-23T00:00:00.000Z',
      completedAt: '2026-04-23T00:00:05.000Z',
      payload: sampleDescribePayload,
      result: sampleResult,
      error: null,
    };
    const store = makeStore({ get: async () => record });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs/job-c-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as JobRecordResponse;
    expect(body.status).toBe('completed');
    expect(body.completedAt).toBe('2026-04-23T00:00:05.000Z');
    expect(body.result).toEqual(sampleResult);
    expect(body.error).toBeNull();
  });

  it('200 — failed state returns error envelope, result stays null', async () => {
    const record: JobRecord = {
      jobId: 'job-f-1',
      status: 'failed',
      attempts: 3,
      createdAt: '2026-04-23T00:00:00.000Z',
      completedAt: '2026-04-23T00:00:10.000Z',
      payload: sampleDescribePayload,
      result: null,
      error: { code: 'provider_failed', message: 'all providers failed' },
    };
    const store = makeStore({ get: async () => record });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs/job-f-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as JobRecordResponse;
    expect(body.status).toBe('failed');
    expect(body.attempts).toBe(3);
    expect(body.error).toEqual({ code: 'provider_failed', message: 'all providers failed' });
    expect(body.result).toBeNull();
  });

  it('404 — unknown job id throws JobNotFoundError → job_not_found envelope', async () => {
    const store = makeStore({ get: async () => null });
    const app = buildApp({ jobStore: store, logger: silentLogger() });

    const res = await app.request('/v1/jobs/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('job_not_found');
    expect(body.error.details).toMatchObject({ jobId: 'does-not-exist' });
    expect(store.getCalls).toEqual(['does-not-exist']);
  });
});
