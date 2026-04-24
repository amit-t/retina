#!/usr/bin/env tsx
/**
 * Replay fixture recorder.
 *
 * Regenerates `test/replay/fixtures/<provider>/describe-basic.json` by
 * issuing a real `describe` call against each configured provider and
 * capturing the raw HTTP exchange ai-sdk performs. Intended to be run by
 * a human operator when a provider changes its wire format or a new model
 * default is picked up — the committed fixtures then drive the offline
 * replay suite for every PR.
 *
 * Gating (deliberately strict):
 *   - The script aborts unless `RECORD=1` is set in the environment.
 *   - Each provider is recorded only when its credential(s) are present.
 *     Missing credentials skip that provider (logged to stderr) rather
 *     than fail the whole run, so partial regenerations are supported.
 *
 * Usage:
 *
 *   RECORD=1 OPENAI_API_KEY=sk-... pnpm tsx test/replay/record.ts
 *   RECORD=1 \
 *     OPENAI_API_KEY=sk-... \
 *     ANTHROPIC_API_KEY=sk-ant-... \
 *     GOOGLE_GENERATIVE_AI_API_KEY=... \
 *     AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *     pnpm tsx test/replay/record.ts
 *
 * The same prompt / image used by the replay spec is sent so the captured
 * response stays representative. The raw provider JSON body is written
 * verbatim — no redaction; fixtures MUST NOT contain secrets. The recorder
 * rejects responses that include obvious credential-looking keys as a
 * safety net before writing to disk.
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProvider } from '../../src/core/providers/index.ts';
import '../../src/core/providers/anthropic.ts';
import '../../src/core/providers/bedrock.ts';
import '../../src/core/providers/google.ts';
import '../../src/core/providers/openai.ts';

import type { ReplayProviderName } from './setup.ts';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Minimal PNG — same payload the describe.spec uses so fixtures match. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('retina-replay'),
]);

type Capture = {
  origin: string;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * Install a fetch interceptor on `globalThis.fetch` that forwards the
 * request, captures the raw response JSON, and returns it unchanged. The
 * recorder keeps a single `Capture` per invocation (describe is a single
 * HTTP call per provider) so the final snapshot is unambiguous.
 */
function captureFetch(): { restore: () => void; readonly capture: Capture | null } {
  const original = globalThis.fetch;
  let latest: Capture | null = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    const clone = response.clone();
    const url =
      typeof input === 'string' || input instanceof URL
        ? new URL(input.toString())
        : new URL(input.url);
    const headers: Record<string, string> = {};
    clone.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await clone.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON body — keep as string for the fixture.
    }
    latest = {
      origin: url.origin,
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      status: response.status,
      headers,
      body,
    };
    return response;
  };

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get capture() {
      return latest;
    },
  };
}

async function recordProvider(provider: ReplayProviderName): Promise<void> {
  const cfg = buildConfig(provider);
  if (cfg === null) {
    console.error(`[record] skipping ${provider} — missing credentials`);
    return;
  }

  const instance = createProvider(cfg, provider);

  const tracker = captureFetch();
  try {
    await instance.describe({
      bytes: PNG_BYTES,
      mime: 'image/png',
      prompt: 'What is in this image?',
    });
  } catch (err) {
    tracker.restore();
    console.error(`[record] ${provider} describe() failed:`, err);
    return;
  }
  tracker.restore();

  const cap = tracker.capture;
  if (!cap) {
    console.error(`[record] ${provider} made no outbound HTTP request — skipping`);
    return;
  }

  if (looksLikeSecret(cap.body)) {
    console.error(
      `[record] ${provider} response body contains suspicious credential-looking keys — NOT writing fixture. Redact manually and re-run.`,
    );
    return;
  }

  const fixture = {
    provider,
    task: 'describe',
    model: cfg.DEFAULT_MODEL ?? modelDefault(provider),
    request: {
      origin: cap.origin,
      method: cap.method,
      path: cap.path,
    },
    response: {
      status: cap.status,
      headers: { 'content-type': cap.headers['content-type'] ?? 'application/json' },
      body: cap.body,
    },
  };

  const out = resolve(FIXTURES_DIR, provider, 'describe-basic.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  console.error(`[record] wrote ${out}`);
}

function buildConfig(provider: ReplayProviderName): null | {
  PROVIDERS: readonly string[];
  DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
} {
  const env = process.env;
  switch (provider) {
    case 'openai':
      return env.OPENAI_API_KEY
        ? { PROVIDERS: ['openai'], OPENAI_API_KEY: env.OPENAI_API_KEY }
        : null;
    case 'anthropic':
      return env.ANTHROPIC_API_KEY
        ? { PROVIDERS: ['anthropic'], ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
        : null;
    case 'google':
      return env.GOOGLE_GENERATIVE_AI_API_KEY
        ? { PROVIDERS: ['google'], GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY }
        : null;
    case 'bedrock':
      return env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            PROVIDERS: ['bedrock'],
            AWS_REGION: env.AWS_REGION,
            AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
          }
        : null;
  }
}

/** Per-provider default model id — mirrors concrete provider modules. */
function modelDefault(provider: ReplayProviderName): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'google':
      return 'gemini-2.5-flash';
    case 'bedrock':
      return 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';
  }
}

/**
 * Heuristic safety net — trips when a provider accidentally echoes a bearer
 * token or AWS secret back into the response body. Preferred to a full
 * allowlist because each provider's JSON shape is open-ended.
 */
function looksLikeSecret(body: unknown): boolean {
  const text = JSON.stringify(body);
  return /\b(sk-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})\b/.test(text);
}

async function main(): Promise<void> {
  if (process.env.RECORD !== '1') {
    console.error(
      'Refusing to run: set RECORD=1 to regenerate replay fixtures. See test/replay/README.md.',
    );
    process.exitCode = 1;
    return;
  }

  for (const provider of ['openai', 'anthropic', 'google', 'bedrock'] as const) {
    await recordProvider(provider);
  }
}

await main();
