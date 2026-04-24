// R13 — integration-style test for the bootstrap wiring.
//
// The real bootstrap lives in `src/index.ts` and runs as an IIFE at module
// import time; importing it here would start an HTTP server on the port
// carried in `process.env`. Instead, this spec exercises the composition
// one layer down (`buildApp(deps)`) with the same dependency shape the
// bootstrap hands it:
//
//   loadConfig()                        — produces a valid `Config`
//   buildLogger(config.LOG_LEVEL)       — pino JSON logger
//   ProviderRouter + createProvider     — structural stub wired into deps
//   buildApp({config, logger, router})  — composition root under test
//   app.fetch('/healthz') → 200         — the R13 acceptance assertion
//
// We also lock down the secret-redaction helper that renders the startup
// banner's `config` payload (`redactConfigForLogging` from `src/index.ts`),
// because that helper is pure and testable without starting a server.
//
// See the R02h `app-compose.spec.ts` for the middleware pipeline covered
// end-to-end; this spec complements it by exercising the full bootstrap
// dependency graph (config + router + factory) the way index.ts does it.

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { ValidationError } from '../../src/core/errors.ts';
import { ProviderRouter } from '../../src/core/provider-router.ts';
import type {
  Provider,
  ProviderCallResult,
  ProviderFactoryConfig,
} from '../../src/core/providers/index.ts';
import { redactConfigForLogging } from '../../src/index.ts';
import { buildLogger } from '../../src/logger.ts';

// Minimal env a valid `loadConfig()` call needs. Mirrors the acceptance
// command line in `.ralph/fix_plan.md` R13:
//   PORT=8080 REDIS_URL=... PROVIDERS=openai DEFAULT_PROVIDER=openai
//   OPENAI_API_KEY=...
const VALID_ENV = {
  PORT: '8080',
  REDIS_URL: 'redis://localhost:6379/0',
  PROVIDERS: 'openai',
  DEFAULT_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test',
};

/** Structural provider that never dispatches — /healthz doesn't need one. */
const stubProvider: Provider = {
  describe: async (): Promise<ProviderCallResult> => {
    throw new Error('unused in this test');
  },
  ocr: async (): Promise<ProviderCallResult> => {
    throw new Error('unused in this test');
  },
  extract: async (): Promise<ProviderCallResult> => {
    throw new Error('unused in this test');
  },
};

/** Test-only factory so the router has a dep without touching real SDKs. */
const stubFactory = (_cfg: ProviderFactoryConfig, _name: string): Provider => stubProvider;

describe('bootstrap wiring (R13)', () => {
  it('composes config + logger + router + app and serves /healthz with the spec JSON shape', async () => {
    const config = loadConfig(VALID_ENV);

    // Capture logger output into a buffer — mirrors the pipeline but keeps
    // the test quiet. This also proves `buildLogger(config.LOG_LEVEL)`
    // works with a `Config` value (not just a hard-coded string).
    const lines: string[] = [];
    const captureStream = new Readable({ read() {} });
    captureStream.write = ((chunk: Buffer | string): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    }) as typeof captureStream.write;
    const logger = buildLogger(config.LOG_LEVEL, captureStream);

    const router = new ProviderRouter(config, stubFactory);
    const app = buildApp({ config, logger, router });

    const res = await app.fetch(new Request('http://localhost/healthz'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as {
      ok: boolean;
      redis: string;
      providers: Record<string, unknown>;
    };
    expect(body).toEqual({ ok: true, redis: 'down', providers: { openai: 'configured' } });
  });

  it('redacts AWS_*, GOOGLE_*, OPENAI_API_KEY and ANTHROPIC_API_KEY in the startup banner payload', () => {
    const config = loadConfig({
      ...VALID_ENV,
      PROVIDERS: 'openai,anthropic,google,bedrock',
      DEFAULT_PROVIDER: 'openai',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-secret',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-shh',
    });

    const banner = redactConfigForLogging(config);

    // Secrets: replaced with the literal [redacted] marker.
    expect(banner.OPENAI_API_KEY).toBe('[redacted]');
    expect(banner.ANTHROPIC_API_KEY).toBe('[redacted]');
    expect(banner.GOOGLE_GENERATIVE_AI_API_KEY).toBe('[redacted]');
    expect(banner.AWS_REGION).toBe('[redacted]');
    expect(banner.AWS_ACCESS_KEY_ID).toBe('[redacted]');
    expect(banner.AWS_SECRET_ACCESS_KEY).toBe('[redacted]');

    // Non-secret fields pass through untouched so operators can eyeball
    // them in the startup banner.
    expect(banner.PORT).toBe(config.PORT);
    expect(banner.REDIS_URL).toBe(config.REDIS_URL);
    expect(banner.LOG_LEVEL).toBe(config.LOG_LEVEL);
    expect(banner.PROVIDERS).toEqual(config.PROVIDERS);
    expect(banner.DEFAULT_PROVIDER).toBe(config.DEFAULT_PROVIDER);

    // Serializing the banner must not leak any of the raw secret strings.
    const serialized = JSON.stringify(banner);
    for (const secret of ['sk-test', 'sk-ant-secret', 'google-secret', 'AKIA-secret', 'aws-shh']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('loadConfig throws ValidationError (with Zod issue details) when required env is missing', () => {
    // Minimal env missing REDIS_URL + PROVIDERS + DEFAULT_PROVIDER — the
    // R13 acceptance requires that the bootstrap logs a zod error and
    // exits non-zero. `loadConfig` surfaces the same structured details
    // the bootstrap formats into the `config_parse_failed` log line.
    const thrown = (() => {
      try {
        loadConfig({});
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(ValidationError);
    const ve = thrown as ValidationError;
    expect(ve.code).toBe('invalid_request');
    expect(ve.status).toBe(400);
    const issues = (ve.details as { issues?: Array<{ path: string; message: string }> } | undefined)
      ?.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues?.length).toBeGreaterThan(0);
    // Sanity: the error carries a cause (the underlying ZodError) so the
    // bootstrap can log structured issue info.
    expect(ve.cause).toBeDefined();
  });

  it('ProviderRouter wired with the createProvider-style factory dispatches to the primary provider', async () => {
    const config = loadConfig(VALID_ENV);
    const describeSpy = vi.fn(
      async (): Promise<ProviderCallResult> => ({
        output: 'describe-ok',
        usage: { inputTokens: 1, outputTokens: 2 },
        model: 'stub-model',
      }),
    );
    const factory = (_cfg: ProviderFactoryConfig, _name: string): Provider => ({
      ...stubProvider,
      describe: describeSpy,
    });
    const router = new ProviderRouter(config, factory);

    const result = await router.call('describe', {
      bytes: new Uint8Array([0]),
      mime: 'image/png',
    });

    expect(describeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      output: 'describe-ok',
      usage: { inputTokens: 1, outputTokens: 2 },
      provider: config.DEFAULT_PROVIDER,
      model: 'stub-model',
    });
  });
});
