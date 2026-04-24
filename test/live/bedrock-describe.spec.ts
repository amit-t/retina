// R21 — Amazon Bedrock live smoke: real HTTP to Bedrock Runtime through
// `/v1/describe`. See `./openai-describe.spec.ts` header for the skip
// contract.
//
// Bedrock's "provider key" in the spec sense is `AWS_REGION` — that is the
// required env var in `src/config.ts` (`PROVIDER_CREDENTIAL.bedrock`).
// Static AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are optional: when
// unset the @ai-sdk/amazon-bedrock builder falls back to AWS's default
// credential provider chain (shared config, IAM role, SSO). Operators
// running this smoke are expected to have those resolved by the time
// vitest invokes the suite.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LiveDescribeResponse,
  type LiveServerHandle,
  SAMPLE_PNG_BASE64,
  startLiveServer,
} from './setup.ts';

const ENABLED = Boolean(process.env.INTEGRATION) && Boolean(process.env.AWS_REGION);

describe.skipIf(!ENABLED)('live — bedrock /v1/describe smoke', () => {
  let server: LiveServerHandle;

  beforeAll(async () => {
    server = await startLiveServer({
      env: {
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
        PROVIDERS: 'bedrock',
        DEFAULT_PROVIDER: 'bedrock',
        AWS_REGION: process.env.AWS_REGION,
        ...(process.env.AWS_ACCESS_KEY_ID !== undefined
          ? { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID }
          : {}),
        ...(process.env.AWS_SECRET_ACCESS_KEY !== undefined
          ? { AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY }
          : {}),
        ...(process.env.BEDROCK_MODEL !== undefined
          ? { DEFAULT_MODEL: process.env.BEDROCK_MODEL }
          : {}),
        REQUEST_TIMEOUT_MS: process.env.LIVE_REQUEST_TIMEOUT_MS ?? '60000',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it('returns a non-empty description from the real Bedrock API', async () => {
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
    expect(body.provider).toBe('bedrock');
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
    expect(typeof body.description).toBe('string');
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.outputTokens).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
