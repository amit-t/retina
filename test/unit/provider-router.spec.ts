import { describe, expect, it, vi } from 'vitest';
import {
  ImageFetchError,
  ProviderFailedError,
  ProviderRateLimitError,
} from '../../src/core/errors';
import {
  type ProviderCallOptions,
  ProviderRouter,
  type ProviderRouterConfig,
  type SleepFn,
} from '../../src/core/provider-router';
import type {
  Provider,
  ProviderCallInput,
  ProviderCallResult,
} from '../../src/core/providers/index';

/** Minimal image input used by every test — R06c does not inspect bytes. */
const INPUT: ProviderCallInput = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mime: 'image/png',
  prompt: 'describe it',
};

function baseConfig(overrides: Partial<ProviderRouterConfig> = {}): ProviderRouterConfig {
  return {
    PROVIDERS: ['openai', 'anthropic', 'google'],
    DEFAULT_PROVIDER: 'openai',
    RETRY_ATTEMPTS: 0,
    RETRY_BACKOFF_MS: 250,
    ...overrides,
  };
}

type BehaviorStep =
  | { kind: 'ok'; model?: string; output?: unknown }
  | { kind: 'throw'; error: unknown };

/**
 * Build a scripted provider whose `describe`/`ocr`/`extract` methods
 * consume successive `BehaviorStep`s. Records every call it receives so
 * tests can assert on model / signal forwarding / call-count.
 */
function scriptedProvider(steps: BehaviorStep[], defaultModel = 'stub-model') {
  const calls: ProviderCallInput[] = [];
  let cursor = 0;

  const next = async (): Promise<ProviderCallResult> => {
    const step = steps[cursor++];
    if (step === undefined) {
      throw new Error(`scriptedProvider exhausted after ${calls.length} calls`);
    }
    if (step.kind === 'throw') throw step.error;
    return {
      output: step.output ?? 'ok',
      usage: { inputTokens: 1, outputTokens: 2 },
      model: step.model ?? defaultModel,
    };
  };

  const method = async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    calls.push(input);
    return next();
  };

  const provider: Provider = { describe: method, ocr: method, extract: method };
  return { provider, calls, callCount: () => calls.length };
}

/**
 * Registry-shaped factory: a map of provider-name → `Provider`. Throws on
 * lookup miss so tests fail loudly if the router ever asks for a name
 * the test didn't register.
 */
function registryFactory(map: Record<string, Provider>) {
  const factory = vi.fn((_config: unknown, name: string): Provider => {
    const p = map[name];
    if (!p) throw new Error(`registryFactory: no provider registered for "${name}"`);
    return p;
  });
  return factory;
}

/** Zero-wait sleep so retry backoff doesn't slow the suite. */
const noSleep: SleepFn = async () => {};

describe('ProviderRouter.call', () => {
  it('returns the first provider success without attempting fallbacks', async () => {
    const primary = scriptedProvider([{ kind: 'ok', model: 'gpt-stub', output: 'hello' }]);
    const fallback = scriptedProvider([{ kind: 'ok', model: 'should-not-run' }]);
    const factory = registryFactory({ openai: primary.provider, anthropic: fallback.provider });

    const router = new ProviderRouter(
      baseConfig({ DEFAULT_PROVIDER: 'openai', FALLBACK_CHAIN: ['anthropic'] }),
      factory,
      { sleep: noSleep },
    );

    const result = await router.call('describe', INPUT);

    expect(result).toEqual({
      output: 'hello',
      usage: { inputTokens: 1, outputTokens: 2 },
      provider: 'openai',
      model: 'gpt-stub',
    });
    expect(primary.callCount()).toBe(1);
    expect(fallback.callCount()).toBe(0);
  });

  it('retries the primary with exponential backoff and succeeds on the retry', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('slow down') },
      { kind: 'ok', model: 'gpt-stub', output: 'hello' },
    ]);
    const factory = registryFactory({ openai: primary.provider });
    const sleep = vi.fn<SleepFn>(async () => {});

    const router = new ProviderRouter(
      baseConfig({ RETRY_ATTEMPTS: 2, RETRY_BACKOFF_MS: 100 }),
      factory,
      { sleep },
    );

    const result = await router.call('describe', INPUT);

    expect(result.provider).toBe('openai');
    expect(result.output).toBe('hello');
    expect(primary.callCount()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenNthCalledWith(1, 100, undefined); // base * 2^0
  });

  it('throws ProviderFailedError with attempts when retries are exhausted and no fallback is configured', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('1') },
      { kind: 'throw', error: new ProviderRateLimitError('2') },
      { kind: 'throw', error: new ProviderRateLimitError('3') },
    ]);
    const factory = registryFactory({ openai: primary.provider });

    const router = new ProviderRouter(baseConfig({ RETRY_ATTEMPTS: 2 }), factory, {
      sleep: noSleep,
    });

    try {
      await router.call('describe', INPUT);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderFailedError);
      const fail = err as ProviderFailedError;
      expect(fail.code).toBe('provider_failed');
      expect(fail.status).toBe(502);
      const attempts = fail.details?.attempts as Array<{
        provider: string;
        model: string;
        code: string;
        message: string;
      }>;
      expect(attempts.map((a) => a.provider)).toEqual(['openai', 'openai', 'openai']);
      expect(attempts.every((a) => a.code === 'provider_rate_limited')).toBe(true);
      expect(attempts.map((a) => a.message)).toEqual(['1', '2', '3']);
    }
    // 1 initial + 2 retries = 3 total invocations.
    expect(primary.callCount()).toBe(3);
  });

  it('walks the fallback chain and succeeds on the second fallback entry', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('primary-1') },
      { kind: 'throw', error: new ProviderRateLimitError('primary-2') },
    ]);
    const fallback1 = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('fallback1-1') },
      { kind: 'throw', error: new ProviderRateLimitError('fallback1-2') },
    ]);
    const fallback2 = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('fallback2-1') },
      { kind: 'ok', model: 'g-stub', output: 'saved' },
    ]);
    const factory = registryFactory({
      openai: primary.provider,
      anthropic: fallback1.provider,
      google: fallback2.provider,
    });

    const router = new ProviderRouter(
      baseConfig({
        DEFAULT_PROVIDER: 'openai',
        FALLBACK_CHAIN: ['anthropic', 'google'],
        RETRY_ATTEMPTS: 1,
      }),
      factory,
      { sleep: noSleep },
    );

    const result = await router.call('describe', INPUT);

    expect(result.provider).toBe('google');
    expect(result.model).toBe('g-stub');
    expect(result.output).toBe('saved');
    expect(primary.callCount()).toBe(2); // 1 + 1 retry
    expect(fallback1.callCount()).toBe(2); // 1 + 1 retry
    expect(fallback2.callCount()).toBe(2); // 1 fail + 1 success
  });

  it('populates details.attempts with every attempt when the whole chain fails', async () => {
    const primary = scriptedProvider([
      {
        kind: 'throw',
        error: new ProviderRateLimitError('openai bad', {
          details: { model: 'gpt-x' },
        }),
      },
      {
        kind: 'throw',
        error: new ProviderRateLimitError('openai still bad', {
          details: { model: 'gpt-x' },
        }),
      },
    ]);
    const fallback1 = scriptedProvider([
      {
        kind: 'throw',
        error: new ImageFetchError('anthropic down', { details: { model: 'claude-x' } }),
      },
      {
        kind: 'throw',
        error: new ImageFetchError('anthropic still down', { details: { model: 'claude-x' } }),
      },
    ]);
    const factory = registryFactory({ openai: primary.provider, anthropic: fallback1.provider });

    const router = new ProviderRouter(
      baseConfig({
        DEFAULT_PROVIDER: 'openai',
        FALLBACK_CHAIN: ['anthropic'],
        RETRY_ATTEMPTS: 1,
      }),
      factory,
      { sleep: noSleep },
    );

    try {
      await router.call('describe', INPUT);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderFailedError);
      const fail = err as ProviderFailedError;
      const attempts = fail.details?.attempts as Array<{
        provider: string;
        model: string;
        code: string;
        message: string;
      }>;
      expect(attempts).toHaveLength(4);
      expect(attempts[0]).toMatchObject({
        provider: 'openai',
        model: 'gpt-x',
        code: 'provider_rate_limited',
      });
      expect(attempts[1]).toMatchObject({ provider: 'openai', model: 'gpt-x' });
      expect(attempts[2]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-x',
        code: 'image_fetch_failed',
      });
      expect(attempts[3]).toMatchObject({ provider: 'anthropic' });
    }
  });

  it('request-level retries:0 replaces env RETRY_ATTEMPTS and does not merge', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('once') },
    ]);
    const fallback = scriptedProvider([{ kind: 'ok', model: 'a-stub' }]);
    const factory = registryFactory({ openai: primary.provider, anthropic: fallback.provider });

    const router = new ProviderRouter(
      baseConfig({
        RETRY_ATTEMPTS: 5, // env says retry a lot
        FALLBACK_CHAIN: ['anthropic'],
      }),
      factory,
      { sleep: noSleep },
    );

    const result = await router.call('describe', INPUT, { retries: 0 }); // request overrides to 0

    expect(result.provider).toBe('anthropic');
    expect(primary.callCount()).toBe(1); // no retries — replaced, not merged
    expect(fallback.callCount()).toBe(1);
  });

  it('request-level fallback replaces env FALLBACK_CHAIN entirely', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('primary') },
    ]);
    const envFallback = scriptedProvider([{ kind: 'ok', model: 'should-not-run' }]);
    const requestFallback = scriptedProvider([{ kind: 'ok', model: 'request-winner' }]);
    const factory = registryFactory({
      openai: primary.provider,
      anthropic: envFallback.provider,
      google: requestFallback.provider,
    });

    const router = new ProviderRouter(
      baseConfig({
        FALLBACK_CHAIN: ['anthropic'], // env fallback
      }),
      factory,
      { sleep: noSleep },
    );

    const result = await router.call('describe', INPUT, { fallback: ['google'] });

    expect(result.provider).toBe('google');
    expect(result.model).toBe('request-winner');
    expect(envFallback.callCount()).toBe(0); // replaced, not merged
    expect(requestFallback.callCount()).toBe(1);
  });

  it('forwards the caller AbortSignal into each provider call', async () => {
    const primary = scriptedProvider([{ kind: 'ok', model: 'gpt-stub' }]);
    const factory = registryFactory({ openai: primary.provider });

    const controller = new AbortController();
    const router = new ProviderRouter(baseConfig(), factory, { sleep: noSleep });

    await router.call('ocr', INPUT, { signal: controller.signal });

    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.signal).toBe(controller.signal);
    // Also verify the router does not strip other input fields while
    // threading the signal through.
    expect(primary.calls[0]?.prompt).toBe('describe it');
    expect(primary.calls[0]?.mime).toBe('image/png');
  });

  it('forwards AbortSignal across retries and fallback calls', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('1') },
      { kind: 'throw', error: new ProviderRateLimitError('2') },
    ]);
    const fallback = scriptedProvider([{ kind: 'ok', model: 'a-stub' }]);
    const factory = registryFactory({ openai: primary.provider, anthropic: fallback.provider });

    const controller = new AbortController();
    const router = new ProviderRouter(
      baseConfig({ RETRY_ATTEMPTS: 1, FALLBACK_CHAIN: ['anthropic'] }),
      factory,
      { sleep: noSleep },
    );

    const opts: ProviderCallOptions = { signal: controller.signal };
    await router.call('describe', INPUT, opts);

    expect(primary.calls.every((c) => c.signal === controller.signal)).toBe(true);
    expect(fallback.calls[0]?.signal).toBe(controller.signal);
  });

  it('uses exponential backoff (base * 2^attempt) between retries of the primary', async () => {
    const primary = scriptedProvider([
      { kind: 'throw', error: new ProviderRateLimitError('1') },
      { kind: 'throw', error: new ProviderRateLimitError('2') },
      { kind: 'ok', model: 'stub' },
    ]);
    const factory = registryFactory({ openai: primary.provider });

    const sleep = vi.fn<SleepFn>(async () => {});
    const router = new ProviderRouter(
      baseConfig({ RETRY_ATTEMPTS: 2, RETRY_BACKOFF_MS: 100 }),
      factory,
      { sleep },
    );

    await router.call('describe', INPUT);

    // Two failures within the primary's retry budget → two sleeps:
    //   attempt 0 → wait 100 * 2^0 = 100ms
    //   attempt 1 → wait 100 * 2^1 = 200ms
    // No sleep after the final (successful) attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 200, undefined);
  });

  it('routes to the task method named in the first argument', async () => {
    const perMethod = {
      describe: vi.fn(
        async (): Promise<ProviderCallResult> => ({
          output: 'd',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'm',
        }),
      ),
      ocr: vi.fn(
        async (): Promise<ProviderCallResult> => ({
          output: 'o',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'm',
        }),
      ),
      extract: vi.fn(
        async (): Promise<ProviderCallResult> => ({
          output: { x: 1 },
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'm',
        }),
      ),
    };
    const provider: Provider = perMethod;
    const factory = registryFactory({ openai: provider });
    const router = new ProviderRouter(baseConfig(), factory, { sleep: noSleep });

    await router.call('ocr', INPUT);

    expect(perMethod.describe).not.toHaveBeenCalled();
    expect(perMethod.ocr).toHaveBeenCalledTimes(1);
    expect(perMethod.extract).not.toHaveBeenCalled();
  });

  it('captures non-RetinaError failures as {code: "provider_error"} in attempts', async () => {
    const primary = scriptedProvider([{ kind: 'throw', error: new Error('raw boom') }]);
    const factory = registryFactory({ openai: primary.provider });

    const router = new ProviderRouter(baseConfig(), factory, { sleep: noSleep });

    try {
      await router.call('describe', INPUT);
      expect.unreachable('should have thrown');
    } catch (err) {
      const fail = err as ProviderFailedError;
      const attempts = fail.details?.attempts as Array<{
        code: string;
        message: string;
        model: string;
      }>;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toEqual({
        provider: 'openai',
        model: '',
        code: 'provider_error',
        message: 'raw boom',
      });
    }
  });
});
