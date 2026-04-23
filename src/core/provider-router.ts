/**
 * ProviderRouter — primary/fallback/retry orchestration on top of the
 * R06a provider factory.
 *
 * Responsibilities (spec §Data flow step 6 + constitution invariant #8):
 *   1. Resolve per-request overrides: request-level `provider`, `retries`,
 *      `fallback` REPLACE (never merge with) the env-level defaults in
 *      `Config`.
 *   2. Attempt the primary provider with exponential backoff on failure
 *      (`RETRY_BACKOFF_MS * 2^attemptIndex`).
 *   3. On primary exhaustion, walk the fallback chain in order; each link
 *      gets its own independent retry budget.
 *   4. Collect `{provider, model, code, message}` for every attempt so the
 *      caller can diagnose when the whole chain fails.
 *   5. On total failure throw `ProviderFailedError` (502) carrying
 *      `details.attempts`.
 *   6. Forward the caller's `AbortSignal` into every provider call so
 *      sync request timeouts (R08) and client disconnects cancel in-flight
 *      ai-sdk work.
 *
 * This module owns the decision logic only. Concrete provider dispatch,
 * credential handling and ai-sdk wiring live in `src/core/providers/*`
 * (R06a/R06b/R07*).
 */

import { ProviderFailedError, RetinaError } from './errors';
import type {
  Provider,
  ProviderCallInput,
  ProviderCallResult,
  ProviderFactoryConfig,
  ProviderUsage,
} from './providers/index';

/** The three task verbs every provider implements (spec §API contracts). */
export type ProviderTask = 'describe' | 'ocr' | 'extract';

/**
 * Structural slice of R03 `Config` the router needs. Full `Config`
 * structurally satisfies this because every field here is a subset.
 * `FALLBACK_CHAIN` is optional here so the `?? []` default in `call()`
 * is load-bearing even when a caller supplies a narrower object.
 */
export interface ProviderRouterConfig extends ProviderFactoryConfig {
  readonly DEFAULT_PROVIDER: string;
  readonly FALLBACK_CHAIN?: readonly string[];
  readonly RETRY_ATTEMPTS: number;
  readonly RETRY_BACKOFF_MS: number;
}

/**
 * The factory signature R06a exports as `createProvider`. Injected so the
 * router is testable without hitting the real registry side-effects and
 * so R13 can wire in whatever factory it ultimately builds.
 */
export type ProviderFactory = (config: ProviderFactoryConfig, name: string) => Provider;

/**
 * Per-request controls. Mirrors `ProviderOptions` from
 * `src/http/schemas.ts` plus the `signal` threading that handlers layer on
 * top (R08 `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`).
 *
 * Each override REPLACES (does not merge with) the corresponding
 * `ProviderRouterConfig` field — constitution invariant #8.
 */
export interface ProviderCallOptions {
  provider?: string;
  model?: string;
  fallback?: readonly string[];
  retries?: number;
  signal?: AbortSignal;
}

/**
 * One entry of `ProviderFailedError.details.attempts`. `model` is "" when
 * the failing provider threw before its dispatched model could be
 * determined — concrete providers (R06b/R07*) SHOULD attach
 * `details.model` on their thrown errors so the trail is precise.
 */
export interface ProviderAttempt {
  provider: string;
  model: string;
  code: string;
  message: string;
}

/**
 * Successful `call()` result. Matches the handler-facing envelope defined
 * in spec §API contracts: `{ output, usage, provider, model }`.
 */
export interface ProviderCallResultWithProvider {
  output: unknown;
  usage: ProviderUsage;
  provider: string;
  model: string;
}

/** Sleep abstraction — overridable in tests to assert / skip real waits. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ProviderRouterOptions {
  /** Injected sleep (backoff between retries). Defaults to real `setTimeout`. */
  sleep?: SleepFn;
}

export class ProviderRouter {
  private readonly config: ProviderRouterConfig;
  private readonly factory: ProviderFactory;
  private readonly sleep: SleepFn;

  constructor(
    config: ProviderRouterConfig,
    factory: ProviderFactory,
    options: ProviderRouterOptions = {},
  ) {
    this.config = config;
    this.factory = factory;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async call(
    task: ProviderTask,
    input: ProviderCallInput,
    opts: ProviderCallOptions = {},
  ): Promise<ProviderCallResultWithProvider> {
    const primary = opts.provider ?? this.config.DEFAULT_PROVIDER;
    const retries = opts.retries ?? this.config.RETRY_ATTEMPTS;
    const fallback = opts.fallback ?? this.config.FALLBACK_CHAIN ?? [];

    const chain: readonly string[] = [primary, ...fallback];
    const attempts: ProviderAttempt[] = [];
    const callInput: ProviderCallInput = opts.signal ? { ...input, signal: opts.signal } : input;

    for (const name of chain) {
      if (opts.signal?.aborted) break;

      const provider = this.factory(this.config, name);

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (opts.signal?.aborted) break;

        try {
          const result: ProviderCallResult = await provider[task](callInput);
          return {
            output: result.output,
            usage: result.usage,
            provider: name,
            model: result.model,
          };
        } catch (err) {
          attempts.push(toAttempt(name, err));
          // Stop the loop early if the caller has aborted; no point
          // burning the rest of the retry/fallback budget.
          if (opts.signal?.aborted) break;
          // Back off only while more retries remain for THIS provider.
          // Fallback-to-next-provider happens without additional delay.
          if (attempt < retries) {
            const delay = this.config.RETRY_BACKOFF_MS * 2 ** attempt;
            await this.sleep(delay, opts.signal);
          }
        }
      }
    }

    throw new ProviderFailedError('Provider chain exhausted', {
      details: { attempts },
    });
  }
}

function toAttempt(provider: string, err: unknown): ProviderAttempt {
  if (err instanceof RetinaError) {
    const model =
      err.details !== undefined && typeof err.details.model === 'string' ? err.details.model : '';
    return { provider, model, code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { provider, model: '', code: 'provider_error', message };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

  return new Promise<void>((resolve, reject) => {
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
