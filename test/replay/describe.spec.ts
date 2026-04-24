/**
 * R19 — POST /v1/describe replay suite.
 *
 * Exercises the full describe pipeline (buildApp → ProviderRouter →
 * concrete provider → ai-sdk → fetch) for every provider Retina supports
 * by replaying a recorded HTTP exchange via `undici` MockAgent. Each
 * assertion verifies the response envelope matches the fixture's provider
 * / model and that the provider SDK's response text flows through the
 * task runner into `DescribeResponse.description`.
 *
 * Fixtures live in `test/replay/fixtures/<provider>/describe-basic.json`
 * and can be regenerated (when real creds are present) with:
 *
 *     RECORD=1 pnpm tsx test/replay/record.ts
 *
 * The test intentionally uses the base64 image path so provider calls are
 * the only network traffic — normalize never hits `https://`.
 */

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ProviderRouter } from '../../src/core/provider-router.ts';
import { createProvider } from '../../src/core/providers/index.ts';
// Side-effect imports register the four provider builders with R06a's
// factory. The replay suite exercises each of them end to end.
import '../../src/core/providers/anthropic.ts';
import '../../src/core/providers/bedrock.ts';
import '../../src/core/providers/google.ts';
import '../../src/core/providers/openai.ts';
import type { ErrorMiddlewareLogger } from '../../src/http/middleware/error.ts';
import { beginReplay, loadFixture, type ReplayProviderName } from './setup.ts';

function silentLogger(): ErrorMiddlewareLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Minimal PNG — magic header plus filler. Small enough to stay inline. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('retina-replay'),
]);

/**
 * Provider-specific config knobs the ProviderRouter needs when exercising
 * each backend. Credential values are synthetic — real credentials are
 * only required by `test/replay/record.ts` when regenerating fixtures.
 */
const PROVIDER_CONFIG: Record<
  ReplayProviderName,
  {
    PROVIDERS: readonly string[];
    DEFAULT_PROVIDER: string;
    RETRY_ATTEMPTS: number;
    RETRY_BACKOFF_MS: number;
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    GOOGLE_GENERATIVE_AI_API_KEY?: string;
    AWS_REGION?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
  }
> = {
  openai: {
    PROVIDERS: ['openai'],
    DEFAULT_PROVIDER: 'openai',
    RETRY_ATTEMPTS: 0,
    RETRY_BACKOFF_MS: 0,
    OPENAI_API_KEY: 'sk-replay-openai',
  },
  anthropic: {
    PROVIDERS: ['anthropic'],
    DEFAULT_PROVIDER: 'anthropic',
    RETRY_ATTEMPTS: 0,
    RETRY_BACKOFF_MS: 0,
    ANTHROPIC_API_KEY: 'sk-ant-replay',
  },
  google: {
    PROVIDERS: ['google'],
    DEFAULT_PROVIDER: 'google',
    RETRY_ATTEMPTS: 0,
    RETRY_BACKOFF_MS: 0,
    GOOGLE_GENERATIVE_AI_API_KEY: 'gapi-replay',
  },
  bedrock: {
    PROVIDERS: ['bedrock'],
    DEFAULT_PROVIDER: 'bedrock',
    RETRY_ATTEMPTS: 0,
    RETRY_BACKOFF_MS: 0,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAREPLAYFAKEKEYID00',
    AWS_SECRET_ACCESS_KEY: 'replay-fake-secret-access-key-for-signing-only',
  },
};

describe('POST /v1/describe — replay (R19)', () => {
  let replay: ReturnType<typeof beginReplay>;

  beforeEach(() => {
    replay = beginReplay();
  });

  afterEach(async () => {
    await replay.dispose();
  });

  for (const provider of ['openai', 'anthropic', 'google', 'bedrock'] as const) {
    it(`${provider} — returns recorded description via MockAgent fixture`, async () => {
      const fixture = loadFixture(provider, 'describe-basic');
      replay.intercept(fixture);

      const cfg = PROVIDER_CONFIG[provider];
      const router = new ProviderRouter(
        {
          ...cfg,
          // When the caller supplies a DEFAULT_MODEL the provider dispatches
          // against it — pinning the fixture's model keeps the URL path
          // predictable so the MockAgent intercept matches exactly.
          DEFAULT_MODEL: fixture.model,
        },
        createProvider,
        { sleep: async () => {} },
      );

      const app = buildApp({ router, logger: silentLogger() });

      const res = await app.request('/v1/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: { base64: PNG_BYTES.toString('base64'), mime: 'image/png' },
          prompt: 'What is in this image?',
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        description: string;
        provider: string;
        model: string;
        usage: { inputTokens: number; outputTokens: number };
      };

      expect(body.provider).toBe(provider);
      expect(body.model).toBe(fixture.model);
      expect(typeof body.description).toBe('string');
      expect(body.description.length).toBeGreaterThan(0);
      expect(body.usage.inputTokens).toBeGreaterThan(0);
      expect(body.usage.outputTokens).toBeGreaterThan(0);
    });
  }
});
