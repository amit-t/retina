/**
 * Retina entrypoint.
 *
 * Bootstraps the service in the order required by the spec and constitution:
 *
 *     loadConfig() → buildLogger(level)
 *                  → createProvider factory (side-effect-registered backends)
 *                  → ProviderRouter
 *                  → loadTemplates (skipped when TEMPLATES_DIR is absent)
 *                  → buildApp({config, logger, router, templates?})
 *                  → serve({fetch: app.fetch, port}) via @hono/node-server
 *
 * On successful startup we log a single `retina_starting` line whose
 * `config` payload is the loaded `Config` with secret-bearing fields
 * redacted. Matching spec §Configuration, the redacted keys are:
 *
 *   - `AWS_*`                        (region + access key + secret)
 *   - `OPENAI_API_KEY`
 *   - `ANTHROPIC_API_KEY`
 *   - `GOOGLE_*`                     (currently only GOOGLE_GENERATIVE_AI_API_KEY)
 *
 * Config parse failure emits a `config_parse_failed` JSON line carrying
 * the Zod issue list (via `ValidationError.details.issues`) and exits
 * non-zero per the R13 acceptance criteria.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { type Config, loadConfig } from './config.js';
import { RetinaError } from './core/errors.js';
import { ProviderRouter } from './core/provider-router.js';
import { createProvider, type ProviderFactoryConfig } from './core/providers/index.js';
// Side-effect imports — each provider module registers its builder with
// the R06a factory on load, so merely importing them here populates
// `createProvider`'s registry before the router starts calling it.
import './core/providers/anthropic.js';
import './core/providers/bedrock.js';
import './core/providers/google.js';
import './core/providers/openai.js';
import { loadTemplates, type TemplateRegistry } from './core/templates.js';
import { buildLogger } from './logger.js';

/** Exact-match keys redacted from the startup banner. */
const REDACT_EXACT_KEYS: ReadonlySet<string> = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);

/** Key prefixes redacted from the startup banner (`AWS_*`, `GOOGLE_*`). */
const REDACT_PREFIXES: readonly string[] = ['AWS_', 'GOOGLE_'];

/**
 * Return a shallow clone of `cfg` with secret-bearing fields replaced by
 * the literal string `'[redacted]'`. Undefined fields are preserved as-is
 * so operators can see which optional credentials were supplied vs. not.
 */
export function redactConfigForLogging(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    const secret =
      REDACT_EXACT_KEYS.has(key) || REDACT_PREFIXES.some((prefix) => key.startsWith(prefix));
    out[key] = secret && value !== undefined ? '[redacted]' : value;
  }
  return out;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    // `loadConfig` throws `ValidationError` with `details.issues` carrying
    // each Zod problem. Emit one JSON line describing the failure then
    // exit non-zero so container orchestrators surface it as a crash loop.
    const earlyLogger = buildLogger('info');
    if (err instanceof RetinaError) {
      earlyLogger.fatal(
        {
          err: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        },
        'config_parse_failed',
      );
    } else {
      earlyLogger.fatal({ err }, 'config_parse_failed');
    }
    process.exit(1);
  }

  const logger = buildLogger(config.LOG_LEVEL);

  const factory = (factoryConfig: ProviderFactoryConfig, name: string) =>
    createProvider(factoryConfig, name);
  const router = new ProviderRouter(config, factory);

  // Templates (R10) are optional at boot. A missing `TEMPLATES_DIR` is
  // common in fresh checkouts / bare container runs — we warn and
  // continue; routes requiring templates (`/v1/extract`, `/v1/templates`,
  // the `extract` branch of `/v1/analyze`) simply stay unmounted. A dir
  // that exists but contains malformed files remains fatal per R10.
  let templates: TemplateRegistry | undefined;
  if (existsSync(config.TEMPLATES_DIR)) {
    templates = loadTemplates(config.TEMPLATES_DIR);
    logger.info({ dir: config.TEMPLATES_DIR, count: templates.list().length }, 'templates_loaded');
  } else {
    logger.warn({ dir: config.TEMPLATES_DIR }, 'templates_directory_missing');
  }

  const app = buildApp({
    config,
    logger,
    router,
    ...(templates !== undefined ? { templates } : {}),
  });

  logger.info({ config: redactConfigForLogging(config) }, 'retina_starting');

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port, address: info.address }, 'retina_listening');
  });
}

/**
 * True when this module is being executed directly (e.g. `tsx src/index.ts`
 * or `node dist/index.js`) rather than imported by a test. Tests that need
 * `redactConfigForLogging` or `main` can import this file without
 * accidentally booting an HTTP server.
 */
export const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    // Final safety net. Config-parse failure already exits above; anything
    // else (e.g. `serve()` crashing on EADDRINUSE) falls through to here.
    const crashLogger = buildLogger('info');
    crashLogger.fatal({ err }, 'retina_startup_crashed');
    process.exit(1);
  });
}
