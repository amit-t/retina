// R21 — Anthropic live smoke: real HTTP to the Anthropic API through
// `/v1/describe`. See `./openai-describe.spec.ts` header for the skip
// contract; this file gates on `ANTHROPIC_API_KEY` instead.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LiveDescribeResponse,
  type LiveServerHandle,
  SAMPLE_PNG_BASE64,
  startLiveServer,
} from './setup.ts';

const ENABLED = Boolean(process.env.INTEGRATION) && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!ENABLED)('live — anthropic /v1/describe smoke', () => {
  let server: LiveServerHandle;

  beforeAll(async () => {
    server = await startLiveServer({
      env: {
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
        PROVIDERS: 'anthropic',
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ...(process.env.ANTHROPIC_MODEL !== undefined
          ? { DEFAULT_MODEL: process.env.ANTHROPIC_MODEL }
          : {}),
        REQUEST_TIMEOUT_MS: process.env.LIVE_REQUEST_TIMEOUT_MS ?? '60000',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it('returns a non-empty description from the real Anthropic API', async () => {
    const res = await fetch(`${server.baseUrl}/v1/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: { base64: SAMPLE_PNG_BASE64, mime: 'image/png' },
        prompt: 'Briefly describe this image in one sentence.',
        maxTokens: 64,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as LiveDescribeResponse;
    expect(body.provider).toBe('anthropic');
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
    expect(typeof body.description).toBe('string');
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.outputTokens).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
