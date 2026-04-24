// R21 — Live integration test harness.
//
// Mirrors the e2e harness (R20) one-to-one with a single, intentional
// difference: NO `undici` MockAgent is installed. The global dispatcher is
// left untouched so provider SDK calls travel out over the real network to
// the real backing services (OpenAI, Anthropic, Google, Bedrock).
//
// Because live tests cost money and require operator-supplied creds, they
// MUST be gated at the `describe.skipIf` level in every spec file — see the
// sibling `<provider>-describe.spec.ts` files for the pattern:
//
//   describe.skipIf(!process.env.INTEGRATION || !process.env.<PROVIDER_KEY>)
//
// `INTEGRATION=1` is the master switch; per-provider creds pick which
// providers actually run. Missing creds SKIP, never FAIL — so
// `pnpm test:live` stays green for developers who haven't loaded a key.
//
// Spec files call `startLiveServer(...)` in `beforeAll` to boot a Hono
// server on a random free port with only the credentials that spec needs.
// Each provider gets its own isolated process-level config so one missing
// key does not bleed into another provider's smoke.

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { ProviderRouter } from '../../src/core/provider-router.ts';
import { createProvider, type ProviderFactoryConfig } from '../../src/core/providers/index.ts';

// Side-effect imports populate the R06a provider registry. Importing all
// four keeps `createProvider` capable of building any provider the config
// references — specs that only set OPENAI_API_KEY configure `PROVIDERS=openai`
// in their own env slice, so the other builders stay dormant.
import '../../src/core/providers/anthropic.ts';
import '../../src/core/providers/bedrock.ts';
import '../../src/core/providers/google.ts';
import '../../src/core/providers/openai.ts';

/** Handle returned by {@link startLiveServer}. Spec files keep this around
 *  across `beforeAll`/`afterAll` to tear the server down cleanly. */
export interface LiveServerHandle {
  /** `http://127.0.0.1:<port>` — no trailing slash. */
  baseUrl: string;
  /** Stop the server, resolving once the socket is closed. */
  close(): Promise<void>;
}

/** Inputs to {@link startLiveServer}. `env` defaults to `process.env` but
 *  spec files usually pass a narrowed slice so a missing cred in the
 *  ambient shell doesn't fail `loadConfig` for an unrelated provider. */
export interface StartLiveServerOptions {
  env?: Record<string, string | undefined>;
}

/**
 * Boot the Retina HTTP app backed by a real `ProviderRouter` and real
 * ai-sdk provider builders, listening on a random free port.
 *
 * Unlike the e2e harness (R20), this helper installs no mock HTTP
 * dispatcher — every `/v1/describe` call fans out to the configured
 * provider over the public internet. Callers MUST gate invocations behind
 * `describe.skipIf` (see module header).
 *
 * Redis is not required for live smokes because only the sync `/v1/describe`
 * path is exercised; the async job lifecycle (R14+) and its testcontainer
 * dependency belong to the e2e suite.
 */
export async function startLiveServer(
  options: StartLiveServerOptions = {},
): Promise<LiveServerHandle> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const router = new ProviderRouter(config, (cfg: ProviderFactoryConfig, name) =>
    createProvider(cfg, name),
  );
  const app = buildApp({ config, router });

  return await new Promise<LiveServerHandle>((resolve, reject) => {
    let server: ServerType | undefined;
    const onError = (err: Error): void => {
      reject(err);
    };
    const onListening = (info: AddressInfo): void => {
      const handle: LiveServerHandle = {
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            if (!server) {
              resolveClose();
              return;
            }
            server.close((closeErr) => {
              if (closeErr) rejectClose(closeErr);
              else resolveClose();
            });
          }),
      };
      resolve(handle);
    };
    try {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, onListening);
      server.on('error', onError);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * 1×1 solid-red PNG, base64-encoded.
 *
 * Embedded inline so live smokes have zero external-HTTP dependency for
 * the image itself — the only network egress is from the provider SDK to
 * its own backend. Every supported vision backend (OpenAI GPT-4o,
 * Anthropic Claude 3.5, Google Gemini 1.5, Bedrock-hosted Claude) accepts
 * tiny single-pixel images and returns a non-empty (if terse) description,
 * which is all a smoke needs to prove.
 *
 * Operators who want richer smoke coverage can override the image payload
 * in their own spec variant; this constant is the default so the suite
 * stays hermetic.
 */
export const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Minimal describe-response shape used by every provider smoke for
 *  assertions. Matches `DescribeResponse` in `src/http/schemas.ts`. */
export interface LiveDescribeResponse {
  description: string;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
