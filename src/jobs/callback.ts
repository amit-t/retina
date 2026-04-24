/**
 * Async-job completion webhook.
 *
 * `postCallback(url, payload, opts)` performs a fire-and-forget POST to the
 * caller-supplied `callbackUrl` from a `POST /v1/jobs` request when the
 * worker (R15) transitions a job to `completed`. Spec §Data flow Async step 4
 * (docs/superpowers/specs/2026-04-21-retina-image-api-design.md) requires:
 *
 *   - POST with JSON body
 *   - 3 retries, 5 s per-attempt timeout (defaults)
 *   - Exponential backoff between attempts
 *   - Final give-up logs at `warn` and does NOT mutate job state — the
 *     constitution invariant "Callback webhooks are success-only" means the
 *     job is already `completed` in Redis; webhook failure is an observability
 *     concern only, never a job-state concern.
 *
 * The function never throws: all network / timeout / non-2xx outcomes are
 * absorbed into the `boolean` return value so the worker can `void`-fire
 * this without an unhandled-rejection leak.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { fetch } from 'undici';

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 250;

export interface PostCallbackOptions {
  /** Total attempts (not additional retries). Defaults to 3. */
  retries?: number;
  /** Per-attempt `AbortSignal.timeout` budget in ms. Defaults to 5_000. */
  timeoutMs?: number;
  /** Base for exponential backoff: delay = backoffMs * 2^(attempt-1). Defaults to 250. */
  backoffMs?: number;
  /** Optional pino logger. When omitted, outcomes are silent. */
  logger?: Logger;
}

/**
 * POST `payload` to `url` with retry + timeout + exponential backoff.
 *
 * @returns `true` once any attempt returns 2xx; `false` after the retry
 *   budget is exhausted. The function does not throw.
 */
export async function postCallback(
  url: string,
  payload: unknown,
  opts: PostCallbackOptions = {},
): Promise<boolean> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const logger = opts.logger;
  const body = JSON.stringify(payload);

  let lastReason: AttemptFailure['reason'] = 'network';
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const outcome = await attemptOnce(url, body, timeoutMs);
    if (outcome.ok) {
      logger?.info({ url, attempt, status: outcome.status }, 'callback_ok');
      return true;
    }
    lastReason = outcome.reason;
    lastStatus = outcome.status;
    if (attempt < retries) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }

  logger?.warn(
    { url, attempts: retries, reason: lastReason, status: lastStatus },
    'callback_giveup',
  );
  return false;
}

type AttemptOutcome = AttemptSuccess | AttemptFailure;
interface AttemptSuccess {
  ok: true;
  status: number;
}
interface AttemptFailure {
  ok: false;
  reason: 'status' | 'timeout' | 'network';
  status?: number;
}

async function attemptOnce(url: string, body: string, timeoutMs: number): Promise<AttemptOutcome> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: isTimeoutError(err) ? 'timeout' : 'network' };
  }
  await drain(response);
  if (response.ok) return { ok: true, status: response.status };
  return { ok: false, reason: 'status', status: response.status };
}

async function drain(response: Awaited<ReturnType<typeof fetch>>): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Discarding the body — cancel outcome doesn't matter.
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}
