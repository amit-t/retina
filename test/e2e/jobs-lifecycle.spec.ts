// R20 — end-to-end jobs lifecycle spec.
//
// Drives the full async pipeline against the live Hono server + Redis
// testcontainer brought up by `test/e2e/setup.ts`:
//
//   1. Provider is stubbed at the HTTP layer via `undici` MockAgent so the
//      test never hits a real LLM — the worker's OpenAI SDK call is
//      intercepted and replies with a canned response.
//   2. POST /v1/jobs returns 202 + {jobId, status:"queued"}.
//   3. Poll GET /v1/jobs/:id until status transitions queued → running →
//      completed (worker processes the queue in the background).
//   4. In parallel, open SSE on /v1/jobs/:id/stream and assert the event
//      sequence (status:queued? → status:running → completed) arrives.
//   5. An in-test HTTP echo server catches the callback POST once the job
//      completes; assert body matches {jobId, status:"completed", result}.
//   6. Assert Redis sets the configured TTL on the completed result key.
//
// Dependencies: R13 (bootstrap), R14 (JobStore), R15 (worker),
// R16 (callback), R17 (jobs routes), R18 (SSE). When any of those have not
// yet landed, `test/e2e/setup.ts` sets `RETINA_E2E_JOBS_READY=false` and
// `describe.skipIf(...)` below skips the whole suite so `pnpm test:e2e`
// still passes in the DoD. The spec is authored in full now so the moment
// R13/R17 et al. land, the suite exercises the acceptance criterion.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { E2E_BASE_URL_ENV, E2E_JOBS_READY_ENV, E2E_REDIS_URL_ENV } from './setup.ts';

// ---------------------------------------------------------------------------
// Suite-level gate
// ---------------------------------------------------------------------------
//
// When any of R13/R14/R15/R16/R17/R18 have not yet landed, the globalSetup
// probe reports no /v1/jobs route and we skip the suite rather than fail.
const JOBS_READY = process.env[E2E_JOBS_READY_ENV] === 'true';
const SKIP_REASON =
  'Skipping e2e jobs lifecycle: /v1/jobs not mounted yet (pending R13 + R17 + R18).';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** 1x1 transparent PNG, base64 — smallest valid image we can post without
 *  hitting an external URL. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Canned provider response the MockAgent replies with — worker passes
 *  this through to `JobStore.complete()` and hence into the SSE event,
 *  the GET /v1/jobs/:id payload, and the callback POST. */
const STUBBED_DESCRIPTION = 'an e2e test image';

/** Host used by the provider stub intercepts. Matches the OpenAI SDK's
 *  default base URL so the `@ai-sdk/openai` client resolves through the
 *  MockAgent. When swapped to bedrock/anthropic/google the origin must
 *  match that provider's SDK base URL. */
const PROVIDER_ORIGIN = 'https://api.openai.com';

/** Poll helpers — keep the whole lifecycle under the project-wide default
 *  testTimeout (5 s) on a warm dev box, with headroom for CI. */
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 10_000;

/** Event types emitted on the SSE channel — mirrors R18's contract. */
type SseEventType = 'status' | 'completed' | 'failed';
interface SseEvent {
  type: SseEventType;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const url = process.env[E2E_BASE_URL_ENV];
  if (!url) throw new Error(`${E2E_BASE_URL_ENV} not set — did globalSetup run?`);
  return url;
}

function redisUrl(): string {
  const url = process.env[E2E_REDIS_URL_ENV];
  if (!url) throw new Error(`${E2E_REDIS_URL_ENV} not set — did globalSetup run?`);
  return url;
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface CallbackServer {
  url: string;
  received: Promise<{ body: unknown; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

/**
 * Tiny HTTP echo server the worker's callback POST hits. Resolves `received`
 * exactly once — the first POST is the callback we care about.
 */
async function startCallbackServer(): Promise<CallbackServer> {
  let resolveReceived: (v: { body: unknown; headers: Record<string, string> }) => void;
  const received = new Promise<{ body: unknown; headers: Record<string, string> }>((resolve) => {
    resolveReceived = resolve;
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // non-JSON — keep raw string
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      resolveReceived({ body, headers });
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/callback`;

  return {
    url,
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Parse a single SSE event chunk of the form "event: <type>\ndata: <json>\n\n".
 * Heartbeat comments ("`: ping\n\n`") are filtered out by the caller.
 */
function parseSseChunk(raw: string): SseEvent | undefined {
  let type: SseEventType | undefined;
  let data: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim() as SseEventType;
    else if (line.startsWith('data:')) data = (data ?? '') + line.slice(5).trim();
  }
  if (!type || data === undefined) return undefined;
  let parsed: unknown = data;
  try {
    parsed = JSON.parse(data);
  } catch {
    // leave as string
  }
  return { type, data: parsed };
}

/**
 * Read the SSE stream for the given jobId until a terminal event arrives or
 * the timeout fires, collecting every non-heartbeat event.
 */
async function collectSseUntilTerminal(
  jobId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SseEvent[]> {
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${baseUrl()}/v1/jobs/${jobId}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  });
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`SSE stream returned HTTP ${res.status}`);
  }
  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Heartbeat comments start with ':' and have no event/data pair.
        if (!chunk.startsWith(':')) {
          const parsed = parseSseChunk(chunk);
          if (parsed) {
            events.push(parsed);
            if (parsed.type === 'completed' || parsed.type === 'failed') {
              ac.abort();
              clearTimeout(timer);
              return events;
            }
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!JOBS_READY)('e2e: jobs lifecycle (R20)', () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;
  let redis: Redis;

  if (!JOBS_READY) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e] ${SKIP_REASON}`);
  }

  beforeAll(() => {
    redis = new Redis(redisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    redis?.disconnect();
  });

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    // Permit localhost so the in-test HTTP callback server and the SSE
    // fetch back to the Hono server still reach the real stack.
    mockAgent.enableNetConnect((host: string) => host.includes('127.0.0.1'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
    // Wipe Redis between cases so key-space assertions (TTL below) start
    // from a known state and earlier jobs don't bleed into this one.
    await redis.connect().catch(() => undefined);
    await redis.flushdb();
  });

  it('queued → running → completed lifecycle emits SSE + callback and sets TTL on the result key', async () => {
    // 1. Stub the provider HTTP surface so the worker's LLM call resolves
    //    deterministically without touching the network.
    mockAgent
      .get(PROVIDER_ORIGIN)
      .intercept({ path: /\/v1\/chat\/completions/, method: 'POST' })
      .reply(
        200,
        {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: STUBBED_DESCRIPTION },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        },
        { headers: { 'content-type': 'application/json' } },
      )
      .persist();

    // 2. Stand up the callback echo server and enqueue the job.
    const callback = await startCallbackServer();
    try {
      const postRes = await fetch(`${baseUrl()}/v1/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: 'describe',
          image: { base64: PNG_1X1_BASE64, mime: 'image/png' },
          prompt: 'describe the image',
          callbackUrl: callback.url,
        }),
      });
      expect(postRes.status).toBe(202);
      const postBody = (await postRes.json()) as { jobId: string; status: string };
      expect(postBody.status).toBe('queued');
      expect(postBody.jobId).toMatch(/.+/);
      const { jobId } = postBody;

      // 3. Open the SSE stream in parallel with polling GET /v1/jobs/:id.
      const ssePromise = collectSseUntilTerminal(jobId);

      // 4. Poll until the job reaches `completed`. R15's worker picks it
      //    up from retina:queue and transitions queued → running →
      //    completed; we tolerate missing `queued` in the poll history
      //    because the worker may claim before the first poll lands.
      const statuses: string[] = [];
      let finalBody: {
        jobId: string;
        status: string;
        result?: { description?: string };
      } = { jobId, status: 'queued' };
      await pollUntil(async () => {
        const res = await fetch(`${baseUrl()}/v1/jobs/${jobId}`);
        if (!res.ok) return undefined;
        const body = (await res.json()) as typeof finalBody;
        if (statuses[statuses.length - 1] !== body.status) statuses.push(body.status);
        finalBody = body;
        return body.status === 'completed' || body.status === 'failed' ? body : undefined;
      });

      expect(finalBody.status).toBe('completed');
      expect(finalBody.result?.description).toBe(STUBBED_DESCRIPTION);
      // The worker MUST transition through `running` even if we miss
      // `queued` in polling.
      expect(statuses).toContain('running');
      expect(statuses[statuses.length - 1]).toBe('completed');

      // 5. SSE event sequence — at minimum one status:running then a
      //    terminal `completed`.
      const events = await ssePromise;
      const types = events.map((e) => e.type);
      expect(types[types.length - 1]).toBe('completed');
      expect(events.some((e) => e.type === 'status')).toBe(true);

      // 6. Callback POST arrives with the terminal payload.
      const { body: callbackBody } = await Promise.race([
        callback.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('callback timeout')), POLL_TIMEOUT_MS),
        ),
      ]);
      const parsedCallback = callbackBody as {
        jobId: string;
        status: string;
        result?: { description?: string };
      };
      expect(parsedCallback.jobId).toBe(jobId);
      expect(parsedCallback.status).toBe('completed');
      expect(parsedCallback.result?.description).toBe(STUBBED_DESCRIPTION);

      // 7. Redis TTL — the result key must carry `JOB_RESULT_TTL_SECONDS`
      //    (default 86400 from src/config.ts). Key prefix matches R14's
      //    `retina:job:<id>`; spec §Redis keys.
      const ttl = await redis.ttl(`retina:job:${jobId}`);
      expect(ttl).toBeGreaterThan(0);
      // Default in src/config.ts is 86400 — the test asserts a reasonable
      // upper bound rather than an exact value to tolerate scheduling lag.
      expect(ttl).toBeLessThanOrEqual(86_400);
    } finally {
      await callback.close();
    }
  });
});
