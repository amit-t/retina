// R18 — tests for the SSE body stream produced by `streamJob`.
//
// Covers the acceptance list in `.ralph/fix_plan.md` R18:
//   - first event is the current state
//   - events from the subscribe handler are forwarded as `data:` frames
//   - terminal state / terminal forwarded event closes the stream
//   - heartbeat comment `: ping\n\n` fires every `heartbeatMs`
//   - abort signal triggers unsubscribe + heartbeat teardown
//
// The store dependency is satisfied by a hand-rolled mock that captures
// every registered subscriber so tests can drive event forwarding
// deterministically. Heartbeat timing uses vitest fake timers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobStatus } from '../../src/http/schemas.ts';
import {
  type JobEvent,
  type JobRecord,
  type StreamJobStore,
  streamJob,
  type Unsubscribe,
} from '../../src/jobs/sse.ts';

type SubHandler = (event: JobEvent) => void;

interface StoreState {
  getCalls: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
}

function makeRecord(status: JobStatus, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job-1',
    status,
    attempts: 1,
    createdAt: '2026-04-23T00:00:00.000Z',
    completedAt: null,
    result: null,
    error: null,
    ...overrides,
  };
}

function makeStore(record: JobRecord | null): {
  store: StreamJobStore;
  subscribers: SubHandler[];
  state: StoreState;
} {
  const subscribers: SubHandler[] = [];
  const state: StoreState = { getCalls: 0, subscribeCalls: 0, unsubscribeCalls: 0 };
  const store: StreamJobStore = {
    get: async () => {
      state.getCalls += 1;
      return record;
    },
    subscribe: async (_id, handler): Promise<Unsubscribe> => {
      state.subscribeCalls += 1;
      subscribers.push(handler);
      return async () => {
        state.unsubscribeCalls += 1;
      };
    },
  };
  return { store, subscribers, state };
}

const decoder = new TextDecoder();

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done || value === undefined) return '';
  return decoder.decode(value);
}

afterEach(() => {
  // Defensive: some tests enable fake timers; restore to real timers so a
  // later test does not inherit them.
  vi.useRealTimers();
});

describe('streamJob — first event', () => {
  it('emits the current status as a `data:` event for a queued job', async () => {
    const { store } = makeStore(makeRecord('queued'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    expect(await readFrame(reader)).toBe('data: {"type":"status","status":"queued"}\n\n');

    await reader.cancel();
  });

  it('emits the current status for a running job and opens exactly one subscription', async () => {
    const { store, state } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    expect(await readFrame(reader)).toBe('data: {"type":"status","status":"running"}\n\n');
    // Give start() a microtask to finish awaiting subscribe().
    await Promise.resolve();
    await Promise.resolve();
    expect(state.getCalls).toBe(1);
    expect(state.subscribeCalls).toBe(1);

    await reader.cancel();
  });

  it('emits a `completed` event and closes immediately for a terminal-completed job', async () => {
    const result = { description: 'done' };
    const { store, state } = makeStore(
      makeRecord('completed', { result, completedAt: '2026-04-23T00:01:00.000Z' }),
    );
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    expect(await readFrame(reader)).toBe(
      `data: ${JSON.stringify({ type: 'completed', result })}\n\n`,
    );
    const { done } = await reader.read();
    expect(done).toBe(true);
    // No subscription opened because the job was already terminal.
    expect(state.subscribeCalls).toBe(0);
  });

  it('emits a `failed` event and closes immediately for a terminal-failed job', async () => {
    const error = { code: 'provider_failed', message: 'upstream boom' };
    const { store, state } = makeStore(
      makeRecord('failed', { error, completedAt: '2026-04-23T00:01:00.000Z' }),
    );
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    expect(await readFrame(reader)).toBe(`data: ${JSON.stringify({ type: 'failed', error })}\n\n`);
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(state.subscribeCalls).toBe(0);
  });

  it('falls back to a canonical error payload when a failed record has no error detail', async () => {
    const { store } = makeStore(makeRecord('failed', { error: null }));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    const frame = await readFrame(reader);
    expect(frame).toContain('"type":"failed"');
    expect(frame).toContain('"code":"internal_error"');
    expect(frame).toContain('"message":"Job failed"');
  });

  it('closes silently when the record disappears between pre-flight and streamJob', async () => {
    const { store, state } = makeStore(null);
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    const { done, value } = await reader.read();
    expect(done).toBe(true);
    expect(value).toBeUndefined();
    expect(state.subscribeCalls).toBe(0);
  });
});

describe('streamJob — forwarded events', () => {
  it('forwards a status event from the subscriber as a `data:` frame', async () => {
    const { store, subscribers } = makeStore(makeRecord('queued'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    // Drain the initial current-state frame.
    await readFrame(reader);
    // Wait for subscribe to register.
    await vi.waitFor(() => {
      expect(subscribers.length).toBe(1);
    });

    const handler = subscribers[0];
    if (handler === undefined) throw new Error('subscriber not registered');
    handler({ type: 'status', status: 'running' });

    expect(await readFrame(reader)).toBe('data: {"type":"status","status":"running"}\n\n');

    await reader.cancel();
  });

  it('closes the stream after forwarding a terminal `completed` event and unsubscribes', async () => {
    const { store, subscribers, state } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    await readFrame(reader); // state event
    await vi.waitFor(() => {
      expect(subscribers.length).toBe(1);
    });

    const handler = subscribers[0];
    if (handler === undefined) throw new Error('subscriber not registered');
    const completed: JobEvent = { type: 'completed', result: { text: 'hello' } };
    handler(completed);

    expect(await readFrame(reader)).toBe(`data: ${JSON.stringify(completed)}\n\n`);
    const tail = await reader.read();
    expect(tail.done).toBe(true);
    // Subscriber teardown runs exactly once even though multiple close
    // paths converge (terminal event + cancel-on-close).
    await vi.waitFor(() => {
      expect(state.unsubscribeCalls).toBe(1);
    });
  });

  it('closes the stream after forwarding a terminal `failed` event', async () => {
    const { store, subscribers, state } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    await readFrame(reader);
    await vi.waitFor(() => {
      expect(subscribers.length).toBe(1);
    });

    const handler = subscribers[0];
    if (handler === undefined) throw new Error('subscriber not registered');
    const failed: JobEvent = {
      type: 'failed',
      error: { code: 'provider_failed', message: 'upstream boom' },
    };
    handler(failed);

    expect(await readFrame(reader)).toBe(`data: ${JSON.stringify(failed)}\n\n`);
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => {
      expect(state.unsubscribeCalls).toBe(1);
    });
  });
});

describe('streamJob — heartbeat cadence', () => {
  it('emits `: ping\\n\\n` every heartbeatMs until the stream closes', async () => {
    vi.useFakeTimers();
    const { store, subscribers } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, { heartbeatMs: 1_000 }).getReader();

    // Initial state event.
    expect(await readFrame(reader)).toBe('data: {"type":"status","status":"running"}\n\n');

    // Let microtasks flush so subscribe resolves and the heartbeat timer
    // is armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribers.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readFrame(reader)).toBe(': ping\n\n');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readFrame(reader)).toBe(': ping\n\n');

    await reader.cancel();
  });

  it('does not arm a heartbeat for a terminal-state job', async () => {
    vi.useFakeTimers();
    const { store } = makeStore(makeRecord('completed', { result: {} }));
    const reader = streamJob('job-1', store, { heartbeatMs: 1_000 }).getReader();

    await readFrame(reader); // completed frame
    expect((await reader.read()).done).toBe(true);

    // Advancing time must not produce any further frames — the stream is
    // already closed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await reader.read()).done).toBe(true);
  });
});

describe('streamJob — client disconnect / cleanup', () => {
  it('calls unsubscribe and clears the heartbeat when the signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { store, state, subscribers } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, {
      heartbeatMs: 1_000,
      signal: controller.signal,
    }).getReader();

    await readFrame(reader); // state event
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribers.length).toBe(1);

    controller.abort();
    await vi.waitFor(() => {
      expect(state.unsubscribeCalls).toBe(1);
    });

    // Stream should now be closed and no further heartbeats fire.
    expect((await reader.read()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await reader.read()).done).toBe(true);
  });

  it('short-circuits when the signal is already aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();
    const { store, state } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, {
      heartbeatMs: 1_000,
      signal: controller.signal,
    }).getReader();

    const { done, value } = await reader.read();
    expect(done).toBe(true);
    expect(value).toBeUndefined();
    expect(state.getCalls).toBe(0);
    expect(state.subscribeCalls).toBe(0);
  });

  it('calls unsubscribe when the consumer cancels the reader', async () => {
    const { store, state, subscribers } = makeStore(makeRecord('running'));
    const reader = streamJob('job-1', store, { heartbeatMs: 60_000 }).getReader();

    await readFrame(reader); // state event
    await vi.waitFor(() => {
      expect(subscribers.length).toBe(1);
    });

    await reader.cancel();
    expect(state.unsubscribeCalls).toBe(1);
  });
});
