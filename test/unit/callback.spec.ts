import { PassThrough } from 'node:stream';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postCallback } from '../../src/jobs/callback.js';
import { buildLogger } from '../../src/logger.js';

const ORIGIN = 'https://hook.test';
const PATH = '/cb';
const URL = `${ORIGIN}${PATH}`;

interface Sink {
  text: () => string;
  lines: () => string[];
  records: () => Array<Record<string, unknown>>;
}

const capture = (stream: PassThrough): Sink => {
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
  return {
    text: () => chunks.join(''),
    lines,
    records: () => lines().map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('postCallback', () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;
  let stream: PassThrough;
  let sink: Sink;
  let logger: ReturnType<typeof buildLogger>;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    stream = new PassThrough();
    sink = capture(stream);
    logger = buildLogger('debug', stream);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it('first-try success → returns true, single request, logs callback_ok at info', async () => {
    let calls = 0;
    mockAgent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(() => {
        calls++;
        return { statusCode: 200, data: '' };
      });

    const ok = await postCallback(
      URL,
      { jobId: 'job-1', status: 'completed' },
      {
        retries: 3,
        timeoutMs: 1_000,
        backoffMs: 1,
        logger,
      },
    );

    await flush();
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('callback_ok');
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.attempt).toBe(1);
    expect(records[0]?.status).toBe(200);
    expect(records[0]?.url).toBe(URL);
    expect(sink.text()).not.toContain('callback_giveup');
  });

  it('forwards payload as JSON with application/json content-type', async () => {
    let bodySeen: string | undefined;
    let contentType: string | undefined;
    mockAgent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply((opts) => {
        bodySeen = typeof opts.body === 'string' ? opts.body : String(opts.body);
        const headers = opts.headers as Record<string, string> | undefined;
        contentType = headers?.['content-type'];
        return { statusCode: 200, data: '' };
      });

    const payload = { jobId: 'j', result: { foo: 'bar' }, n: 42 };
    const ok = await postCallback(URL, payload, {
      retries: 1,
      timeoutMs: 1_000,
      backoffMs: 1,
      logger,
    });

    expect(ok).toBe(true);
    expect(bodySeen).toBe(JSON.stringify(payload));
    expect(contentType).toBe('application/json');
  });

  it('retry-then-success on 500 → returns true after 2 attempts, no give-up log', async () => {
    let calls = 0;
    mockAgent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(() => {
        calls++;
        return { statusCode: calls === 1 ? 500 : 200, data: calls === 1 ? 'boom' : '' };
      })
      .persist();

    const ok = await postCallback(
      URL,
      { ping: true },
      {
        retries: 3,
        timeoutMs: 1_000,
        backoffMs: 1,
        logger,
      },
    );

    await flush();
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('callback_ok');
    expect(records[0]?.attempt).toBe(2);
    expect(records[0]?.status).toBe(200);
    expect(sink.text()).not.toContain('callback_giveup');
  });

  it('timeout → counts as failure; after budget, returns false with reason=timeout', async () => {
    let calls = 0;
    mockAgent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(() => {
        calls++;
        return { statusCode: 200, data: '' };
      })
      .delay(200)
      .persist();

    const ok = await postCallback(
      URL,
      { ping: true },
      {
        retries: 1,
        timeoutMs: 20,
        backoffMs: 1,
        logger,
      },
    );

    await flush();
    expect(ok).toBe(false);
    expect(calls).toBe(1);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('callback_giveup');
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.attempts).toBe(1);
    expect(records[0]?.reason).toBe('timeout');
    expect(records[0]?.url).toBe(URL);
  });

  it('give-up after 3 retries of 500 → returns false, warn(callback_giveup) with status=500', async () => {
    let calls = 0;
    mockAgent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(() => {
        calls++;
        return { statusCode: 500, data: 'nope' };
      })
      .persist();

    const ok = await postCallback(
      URL,
      { jobId: 'doomed' },
      {
        retries: 3,
        timeoutMs: 1_000,
        backoffMs: 1,
        logger,
      },
    );

    await flush();
    expect(ok).toBe(false);
    expect(calls).toBe(3);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('callback_giveup');
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.attempts).toBe(3);
    expect(records[0]?.reason).toBe('status');
    expect(records[0]?.status).toBe(500);
  });

  it('is silent when no logger is provided (no throw, no unhandled rejection)', async () => {
    mockAgent.get(ORIGIN).intercept({ path: PATH, method: 'POST' }).reply(500, 'nope').persist();

    const ok = await postCallback(
      URL,
      { n: 1 },
      {
        retries: 2,
        timeoutMs: 1_000,
        backoffMs: 1,
      },
    );

    expect(ok).toBe(false);
  });

  it('applies defaults when options object is omitted', async () => {
    mockAgent.get(ORIGIN).intercept({ path: PATH, method: 'POST' }).reply(200, '');

    const ok = await postCallback(URL, { any: 'thing' });
    expect(ok).toBe(true);
  });
});
