// Zod-validated runtime configuration for Retina.
//
// Every knob lives in the environment (spec §Configuration). `loadConfig`
// parses `process.env` (or a caller-supplied object for tests), coerces
// strings into their final types, applies defaults, and enforces the
// cross-field invariants:
//
//   - DEFAULT_PROVIDER ∈ PROVIDERS
//   - FALLBACK_CHAIN   ⊆ PROVIDERS
//   - bedrock    ∈ PROVIDERS ⇒ AWS_REGION
//   - openai     ∈ PROVIDERS ⇒ OPENAI_API_KEY
//   - anthropic  ∈ PROVIDERS ⇒ ANTHROPIC_API_KEY
//   - google     ∈ PROVIDERS ⇒ GOOGLE_GENERATIVE_AI_API_KEY
//
// On failure we throw `ValidationError` with `details.issues` carrying
// `{path, message}` per Zod issue so the bootstrap banner (R13) can render
// the exact field the operator fumbled.

import { z } from 'zod';
import { ValidationError } from './core/errors.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const PROVIDER_NAMES = ['bedrock', 'openai', 'anthropic', 'google'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const splitCsv = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const intEnv = (def: number) => z.coerce.number().int().default(def);

type CredentialKey =
  | 'AWS_REGION'
  | 'OPENAI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'GOOGLE_GENERATIVE_AI_API_KEY';

const PROVIDER_CREDENTIAL: Record<ProviderName, CredentialKey> = {
  bedrock: 'AWS_REGION',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const BaseSchema = z.object({
  PORT: intEnv(8080).pipe(z.number().int().min(1).max(65535)),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  REDIS_URL: z.string().min(1),
  MAX_IMAGE_BYTES: intEnv(10_485_760).pipe(z.number().int().positive()),
  PROVIDERS: z
    .string()
    .min(1)
    .transform(splitCsv)
    .pipe(z.array(z.enum(PROVIDER_NAMES)).min(1)),
  DEFAULT_PROVIDER: z.enum(PROVIDER_NAMES),
  DEFAULT_MODEL: z.string().min(1).optional(),
  FALLBACK_CHAIN: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? [] : splitCsv(s)))
    .pipe(z.array(z.enum(PROVIDER_NAMES))),
  RETRY_ATTEMPTS: intEnv(0).pipe(z.number().int().nonnegative()),
  RETRY_BACKOFF_MS: intEnv(250).pipe(z.number().int().nonnegative()),
  AWS_REGION: z.string().min(1).optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  TEMPLATES_DIR: z.string().min(1).default('/app/templates'),
  JOB_RESULT_TTL_SECONDS: intEnv(86_400).pipe(z.number().int().positive()),
  JOB_MAX_ATTEMPTS: intEnv(3).pipe(z.number().int().min(1)),
  WORKER_CONCURRENCY: intEnv(2).pipe(z.number().int().positive()),
  REQUEST_TIMEOUT_MS: intEnv(30_000).pipe(z.number().int().positive()),
  SSE_HEARTBEAT_MS: intEnv(15_000).pipe(z.number().int().positive()),
});

export const ConfigSchema = BaseSchema.superRefine((cfg, ctx) => {
  if (!cfg.PROVIDERS.includes(cfg.DEFAULT_PROVIDER)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DEFAULT_PROVIDER'],
      message: `DEFAULT_PROVIDER "${cfg.DEFAULT_PROVIDER}" is not in PROVIDERS (${cfg.PROVIDERS.join(
        ', ',
      )})`,
    });
  }

  cfg.FALLBACK_CHAIN.forEach((entry, index) => {
    if (!cfg.PROVIDERS.includes(entry)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FALLBACK_CHAIN', index],
        message: `FALLBACK_CHAIN entry "${entry}" is not in PROVIDERS (${cfg.PROVIDERS.join(
          ', ',
        )})`,
      });
    }
  });

  for (const provider of cfg.PROVIDERS) {
    const credential = PROVIDER_CREDENTIAL[provider];
    if (cfg[credential] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [credential],
        message: `${credential} is required because PROVIDERS includes "${provider}"`,
      });
    }
  }
});

export type Config = z.infer<typeof BaseSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
}

const stripEmpty = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(stripEmpty(env));
  if (result.success) return result.data;

  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    message: issue.message,
  }));

  throw new ValidationError('Invalid configuration', {
    details: { issues },
    cause: result.error,
  });
}
