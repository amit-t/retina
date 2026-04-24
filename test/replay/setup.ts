/**
 * Replay test setup — wires `undici` MockAgent as the global dispatcher so
 * every ai-sdk HTTP call in the replay layer is served from a recorded
 * fixture instead of the real provider.
 *
 * Fixture layout (see `test/replay/README.md`):
 *
 *   test/replay/fixtures/<provider>/<name>.json
 *     {
 *       "provider": "openai",
 *       "task": "describe",
 *       "model": "gpt-4o",
 *       "request":  { origin, method, path },
 *       "response": { status, headers, body }
 *     }
 *
 * Usage from a spec:
 *
 *   const ctx = beginReplay();          // swap in MockAgent
 *   const fixture = loadFixture('openai', 'describe-basic');
 *   ctx.intercept(fixture);
 *   ...
 *   await ctx.dispose();                // restore original dispatcher
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici';

export const PROVIDER_NAMES = ['bedrock', 'openai', 'anthropic', 'google'] as const;
export type ReplayProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * HTTP exchange captured for a replay fixture. `request.path` is matched
 * against the final fetched URL's pathname (already percent-encoded), so
 * entries can pin the exact route each provider SDK dials.
 */
export interface ReplayFixture {
  provider: ReplayProviderName;
  task: 'describe' | 'ocr' | 'extract';
  model: string;
  request: {
    origin: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
}

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Resolve a `<provider>/<name>.json` fixture under `test/replay/fixtures/`.
 * Fails loudly when the file is missing so `RECORD=1 test/replay/record.ts`
 * is the obvious fix.
 */
export function loadFixture(provider: ReplayProviderName, name: string): ReplayFixture {
  const path = resolve(FIXTURES_DIR, provider, `${name}.json`);
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as ReplayFixture;
  if (parsed.provider !== provider) {
    throw new Error(
      `Fixture provider mismatch: ${path} declared "${parsed.provider}" but was loaded as "${provider}".`,
    );
  }
  return parsed;
}

/** Active replay context bound to a spec's lifecycle. */
export interface ReplayContext {
  /** The backing MockAgent — exposed for advanced assertions in a spec. */
  readonly agent: MockAgent;
  /**
   * Wire a fixture into the MockAgent so the next matching request from the
   * provider SDK is served from the fixture's recorded response.
   */
  intercept(fixture: ReplayFixture): void;
  /** Restore the original dispatcher and close the MockAgent. */
  dispose(): Promise<void>;
}

/**
 * Start a replay context: swap `MockAgent` onto the global dispatcher and
 * disable real net-connect so an unintercepted request fails fast instead
 * of hitting the live provider.
 *
 * Because Node's built-in `globalThis.fetch` ships with its own copy of
 * undici (distinct from the `undici` package whose MockAgent we use),
 * `setGlobalDispatcher` alone does not redirect `fetch` traffic. The
 * ai-sdk providers call `globalThis.fetch`, so we also replace it with
 * `undici.fetch` for the replay lifecycle — that fetch honours our
 * MockAgent. Both are restored on `dispose()`.
 */
export function beginReplay(): ReplayContext {
  const original: Dispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  // biome-ignore lint/suspicious/noExplicitAny: undici's fetch is structurally compatible with globalThis.fetch; TS's DOM Request vs undici Request signatures differ nominally only.
  globalThis.fetch = undiciFetch as any;

  return {
    agent,
    intercept(fixture: ReplayFixture): void {
      const pool = agent.get(fixture.request.origin);
      pool
        .intercept({
          path: fixture.request.path,
          method: fixture.request.method,
        })
        .reply(fixture.response.status, fixture.response.body, {
          headers: fixture.response.headers ?? { 'content-type': 'application/json' },
        });
    },
    async dispose(): Promise<void> {
      await agent.close();
      setGlobalDispatcher(original);
      globalThis.fetch = originalFetch;
    },
  };
}
