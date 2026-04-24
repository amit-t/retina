// R21 — OpenAI live smoke: real HTTP to the OpenAI API through `/v1/describe`.
//
// Skip contract (spec §Testing ladder + task R21):
//
//   - `INTEGRATION` env var is the master switch.
//   - `OPENAI_API_KEY` selects this provider.
//
// When either is missing the describe block is SKIPPED (not failed), so
// `pnpm test:live` stays green for developers and partial-cred CI runs.
// `INTEGRATION=1 OPENAI_API_KEY=sk-... pnpm test:live` activates this file
// (Acceptance: task R21).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LiveDescribeResponse,
  type LiveServerHandle,
  SAMPLE_PNG_BASE64,
  startLiveServer,
} from './setup.ts';

const ENABLED = Boolean(process.env.INTEGRATION) && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!ENABLED)('live — openai /v1/describe smoke', () => {
  let server: LiveServerHandle;

  beforeAll(async () => {
    // Build a provider-narrow env slice so the other providers' missing
    // creds don't trip `loadConfig`'s `PROVIDERS ⇒ <CRED>` invariant.
    server = await startLiveServer({
      env: {
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
        PROVIDERS: 'openai',
        DEFAULT_PROVIDER: 'openai',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        // Operator override for the actual SKU; default is `gpt-4o` from R06b.
        ...(process.env.OPENAI_MODEL !== undefined
          ? { DEFAULT_MODEL: process.env.OPENAI_MODEL }
          : {}),
        REQUEST_TIMEOUT_MS: process.env.LIVE_REQUEST_TIMEOUT_MS ?? '60000',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it('returns a non-empty description from the real OpenAI API', async () => {
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
    expect(body.provider).toBe('openai');
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
    expect(typeof body.description).toBe('string');
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.outputTokens).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
