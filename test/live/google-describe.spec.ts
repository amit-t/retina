// R21 — Google (Gemini) live smoke: real HTTP to the Generative Language
// API through `/v1/describe`. See `./openai-describe.spec.ts` header for
// the skip contract; this file gates on `GOOGLE_GENERATIVE_AI_API_KEY`
// (the canonical env var in `src/config.ts`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LiveDescribeResponse,
  type LiveServerHandle,
  SAMPLE_PNG_BASE64,
  startLiveServer,
} from './setup.ts';

const ENABLED =
  Boolean(process.env.INTEGRATION) && Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

describe.skipIf(!ENABLED)('live — google /v1/describe smoke', () => {
  let server: LiveServerHandle;

  beforeAll(async () => {
    server = await startLiveServer({
      env: {
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
        PROVIDERS: 'google',
        DEFAULT_PROVIDER: 'google',
        GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        ...(process.env.GOOGLE_MODEL !== undefined
          ? { DEFAULT_MODEL: process.env.GOOGLE_MODEL }
          : {}),
        REQUEST_TIMEOUT_MS: process.env.LIVE_REQUEST_TIMEOUT_MS ?? '60000',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it('returns a non-empty description from the real Google Gemini API', async () => {
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
    expect(body.provider).toBe('google');
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
    expect(typeof body.description).toBe('string');
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.outputTokens).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
