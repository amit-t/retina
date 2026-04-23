// Jobs HTTP surface.
//
// This file will accumulate the async-jobs routes across several tasks:
//   - R17: POST /v1/jobs, GET /v1/jobs/:id
//   - R18: GET /v1/jobs/:id/stream     ← landed here
// Each task adds its own factory; `buildApp` composes them into the app.

import { Hono } from 'hono';
import { JobNotFoundError } from '../../core/errors.js';
import { type StreamJobStore, streamJob } from '../../jobs/sse.js';

export interface CreateJobsStreamRouteDeps {
  store: StreamJobStore;
  /** Wired from `config.SSE_HEARTBEAT_MS`. */
  heartbeatMs: number;
}

/**
 * `GET /v1/jobs/:id/stream` — Server-Sent Events stream for a single job.
 *
 * Contract (spec §API contracts, fix_plan.md R18):
 *   - Pre-flight: `store.get(id)`. Missing → `JobNotFoundError` (404 JSON
 *     envelope via the global error middleware). The stream body is only
 *     established once we've confirmed the job exists, so the 404 path
 *     still returns a normal JSON response rather than an empty SSE stream.
 *   - Success: 200 + `Content-Type: text/event-stream` with the body
 *     produced by `streamJob()`. The first event is the current state;
 *     subsequent events are forwarded from the `retina:job:<id>` pub/sub
 *     channel. Terminal events (`completed`, `failed`) or client
 *     disconnect close the stream.
 */
export function createJobsStreamRoute(deps: CreateJobsStreamRouteDeps): Hono {
  const app = new Hono();

  app.get('/v1/jobs/:id/stream', async (c) => {
    const jobId = c.req.param('id');
    const record = await deps.store.get(jobId);
    if (record === null) {
      throw new JobNotFoundError(`Job "${jobId}" not found`);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    // Disable buffering for reverse proxies (nginx) that would otherwise
    // withhold chunks until the buffer fills — defeating SSE.
    c.header('X-Accel-Buffering', 'no');

    const streamOpts: Parameters<typeof streamJob>[2] = { heartbeatMs: deps.heartbeatMs };
    if (c.req.raw.signal !== undefined) streamOpts.signal = c.req.raw.signal;

    const body = streamJob(jobId, deps.store, streamOpts);
    return c.body(body);
  });

  return app;
}
