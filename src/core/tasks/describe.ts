/**
 * `describe` task runner.
 *
 * `runDescribe(router, opts)` is the provider-agnostic slice invoked by both
 * `POST /v1/describe` (sync) and `POST /v1/jobs` when `task === 'describe'`
 * (async, R17). It assembles the `ProviderCallInput` from the normalized
 * image + optional prompt/maxTokens, forwards per-request `ProviderOptions`
 * (request-level REPLACES env-level, per constitution invariant #8), and
 * coerces the provider's free-form `output` into the `DescribeResponse`
 * wire shape:
 *
 *   { description, provider, model, usage }
 *
 * The concrete `ProviderRouter` class lands in R06c; this module depends
 * only on the structural `TaskRouter` shape so that R06c's implementation,
 * any test double, and any future sibling router satisfies the contract
 * structurally.
 */

import type { ProviderCallInput, ProviderUsage } from '../providers/index.js';

/** Name of the task dispatched on the router. */
export type TaskName = 'describe' | 'ocr' | 'extract';

/**
 * Per-request router knobs. Each field REPLACES the env-level default
 * inside `ProviderRouter` (constitution invariant #8) — the router
 * enforces replace-semantics; this module only forwards the values.
 */
export interface TaskRouterCallOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  /** Sync request deadline / client disconnect signal. Forwarded through
   *  the router into the ai-sdk call site. */
  signal?: AbortSignal;
}

/** Uniform router result — matches R06c §ProviderRouter.call return. */
export interface TaskRouterResult {
  output: unknown;
  usage: ProviderUsage;
  provider: string;
  model: string;
}

/**
 * Structural slice of R06c's `ProviderRouter`. Task runners depend on this
 * interface rather than the concrete class so unit tests can supply a
 * lightweight mock.
 */
export interface TaskRouter {
  call(
    task: TaskName,
    input: ProviderCallInput,
    opts?: TaskRouterCallOptions,
  ): Promise<TaskRouterResult>;
}

/** Per-request provider controls accepted by task runners. Mirrors
 *  `ProviderOptions` in `src/http/schemas.ts`. */
export interface TaskProviderOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
}

/**
 * Input to {@link runDescribe}. Assembled by the HTTP route after Zod
 * validation and image normalization (R05).
 */
export interface DescribeTaskInput {
  bytes: Uint8Array;
  mime: string;
  prompt?: string;
  maxTokens?: number;
  /** Per-request router overrides. */
  providerOptions?: TaskProviderOptions;
  /** Cancellation signal threaded through to the provider. */
  signal?: AbortSignal;
}

/** Shape returned to the route handler — matches `DescribeResponse` in
 *  `src/http/schemas.ts`. */
export interface DescribeResult {
  description: string;
  provider: string;
  model: string;
  usage: ProviderUsage;
}

/**
 * Run a describe task via the provider router.
 *
 * Translation rules:
 *
 *  - `output` → `description`. Providers typically return a plain string;
 *    ai-sdk objects shaped `{text: string}` are unwrapped as a convenience.
 *    Non-string / non-`{text}` outputs are stringified so the response
 *    contract (`description: string`) is always honoured.
 *  - `provider`, `model`, `usage` are forwarded verbatim from the router
 *    so the response reflects the actual backend that served the request
 *    (including fallback switches).
 */
export async function runDescribe(
  router: TaskRouter,
  opts: DescribeTaskInput,
): Promise<DescribeResult> {
  const input: ProviderCallInput = {
    bytes: opts.bytes,
    mime: opts.mime,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  const callOpts = buildCallOptions(opts.providerOptions, opts.signal);

  const { output, usage, provider, model } =
    callOpts === undefined
      ? await router.call('describe', input)
      : await router.call('describe', input, callOpts);

  return {
    description: coerceDescription(output),
    provider,
    model,
    usage,
  };
}

function buildCallOptions(
  providerOptions: TaskProviderOptions | undefined,
  signal: AbortSignal | undefined,
): TaskRouterCallOptions | undefined {
  const out: TaskRouterCallOptions = {};
  if (providerOptions?.provider !== undefined) out.provider = providerOptions.provider;
  if (providerOptions?.model !== undefined) out.model = providerOptions.model;
  if (providerOptions?.fallback !== undefined) out.fallback = providerOptions.fallback;
  if (providerOptions?.retries !== undefined) out.retries = providerOptions.retries;
  if (signal !== undefined) out.signal = signal;
  return Object.keys(out).length === 0 ? undefined : out;
}

function coerceDescription(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output !== null && typeof output === 'object' && 'text' in output) {
    const text = (output as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return output == null ? '' : String(output);
}
