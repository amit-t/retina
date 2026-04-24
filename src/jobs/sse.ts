// Server-Sent Events stream for a single job id.
//
// `streamJob` produces the raw `ReadableStream<Uint8Array>` body for
// `GET /v1/jobs/:id/stream`. The Hono route sets the SSE response headers
// (`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
// `Connection: keep-alive`) and returns this stream as the body.
//
// Protocol (MVP per spec §API contracts, fix_plan.md R18):
//   1. First event = the job's current state, encoded as a `JobEvent`:
//        queued/running → `{type: "status", status}`
//        completed      → `{type: "completed", result}`
//        failed         → `{type: "failed", error}`
//      If the current state is terminal the stream closes immediately — no
//      subscription is opened.
//   2. Otherwise, subscribe to Redis pub/sub channel `retina:job:<id>` and
//      forward every received event as a `data:` line. Terminal events
//      (`completed`, `failed`) close the stream after forwarding.
//   3. Every `heartbeatMs` a `: ping\n\n` comment is enqueued so proxies and
//      browsers keep the connection alive.
//   4. On client disconnect (`opts.signal` aborted) or consumer `cancel()`
//      we unsubscribe and clear the heartbeat.
//
// The store dependency is deliberately narrowed to a structural type
// (`StreamJobStore`) so this module can land ahead of R14's concrete
// `JobStore` implementation; R14 satisfies the interface by construction.

import type { JobStatus } from '../http/schemas.js';

export interface JobErrorPayload {
  code: string;
  message: string;
}

/** Event body published on `retina:job:<id>` and forwarded to SSE clients. */
export type JobEvent =
  | { type: 'status'; status: Exclude<JobStatus, 'completed' | 'failed'> }
  | { type: 'completed'; result: unknown }
  | { type: 'failed'; error: JobErrorPayload };

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
  error: JobErrorPayload | null;
}

export type Unsubscribe = () => void | Promise<void>;

/** Minimum shape `streamJob` needs from R14's `JobStore`. */
export interface StreamJobStore {
  get(id: string): Promise<JobRecord | null>;
  subscribe(id: string, handler: (event: JobEvent) => void): Promise<Unsubscribe>;
}

export interface StreamJobOptions {
  /** Heartbeat cadence; wired from `config.SSE_HEARTBEAT_MS`. */
  heartbeatMs: number;
  /** Client-disconnect signal (typically `c.req.raw.signal`). */
  signal?: AbortSignal;
}

const ENCODER = new TextEncoder();
const HEARTBEAT_FRAME = ENCODER.encode(`: ping\n\n`);

function encodeEvent(event: JobEvent): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function toStateEvent(record: JobRecord): JobEvent {
  switch (record.status) {
    case 'completed':
      return { type: 'completed', result: record.result };
    case 'failed':
      return {
        type: 'failed',
        error: record.error ?? { code: 'internal_error', message: 'Job failed' },
      };
    default:
      return { type: 'status', status: record.status };
  }
}

function isTerminal(event: JobEvent): boolean {
  return event.type === 'completed' || event.type === 'failed';
}

/**
 * Build a SSE body stream for job `jobId` backed by `store`.
 *
 * Lifecycle guarantees:
 *   - Exactly one `unsubscribe()` call per opened subscription, regardless
 *     of close path (terminal event, abort signal, consumer cancel, or
 *     controller enqueue failure).
 *   - Heartbeat timer is cleared on every close path.
 *   - A signal that is already aborted at entry short-circuits before any
 *     network/Redis I/O is performed.
 */
export function streamJob(
  jobId: string,
  store: StreamJobStore,
  opts: StreamJobOptions,
): ReadableStream<Uint8Array> {
  const signal = opts.signal;
  let heartbeatHandle: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: Unsubscribe | undefined;
  let abortHandler: (() => void) | undefined;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const detachAbort = (): void => {
        if (abortHandler !== undefined && signal !== undefined) {
          signal.removeEventListener('abort', abortHandler);
          abortHandler = undefined;
        }
      };

      const runUnsubscribe = async (fn: Unsubscribe): Promise<void> => {
        try {
          await fn();
        } catch {
          // Subscriber teardown errors are not client-actionable; the
          // connection is already going away. Swallow to keep close paths
          // exception-free.
        }
      };

      const cleanup = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        if (heartbeatHandle !== undefined) {
          clearTimeout(heartbeatHandle);
          heartbeatHandle = undefined;
        }
        detachAbort();
        if (unsubscribe !== undefined) {
          const fn = unsubscribe;
          unsubscribe = undefined;
          await runUnsubscribe(fn);
        }
        try {
          controller.close();
        } catch {
          // Already closed by a prior path (e.g. controller error).
        }
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          await cleanup();
          return;
        }
        abortHandler = (): void => {
          void cleanup();
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const record = await store.get(jobId);
      if (closed) return;
      if (record === null) {
        // The route-level existence check already resolved to 404 before
        // the stream was established; reaching here means the job was
        // evicted between the check and the subscribe. Close silently.
        await cleanup();
        return;
      }

      const firstEvent = toStateEvent(record);
      try {
        controller.enqueue(encodeEvent(firstEvent));
      } catch {
        await cleanup();
        return;
      }

      if (isTerminal(firstEvent)) {
        await cleanup();
        return;
      }

      const pendingUnsub = await store.subscribe(jobId, (event) => {
        if (closed) return;
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          void cleanup();
          return;
        }
        if (isTerminal(event)) {
          void cleanup();
        }
      });

      if (closed) {
        // Signal aborted (or consumer cancelled) while we were awaiting
        // `subscribe()` — the subscription callback fired late; discard it.
        await runUnsubscribe(pendingUnsub);
        return;
      }
      unsubscribe = pendingUnsub;

      const tick = (): void => {
        if (closed) return;
        try {
          controller.enqueue(HEARTBEAT_FRAME);
        } catch {
          void cleanup();
          return;
        }
        heartbeatHandle = setTimeout(tick, opts.heartbeatMs);
      };
      heartbeatHandle = setTimeout(tick, opts.heartbeatMs);
    },
    async cancel() {
      if (closed) return;
      closed = true;
      if (heartbeatHandle !== undefined) {
        clearTimeout(heartbeatHandle);
        heartbeatHandle = undefined;
      }
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
      if (unsubscribe !== undefined) {
        const fn = unsubscribe;
        unsubscribe = undefined;
        try {
          await fn();
        } catch {
          // swallow; see runUnsubscribe note above.
        }
      }
    },
  });
}
