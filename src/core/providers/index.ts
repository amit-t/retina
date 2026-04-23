/**
 * Provider abstraction for the Retina image understanding service.
 *
 * Every concrete vision backend (Bedrock, OpenAI, Anthropic, Google — see
 * `src/core/providers/{openai,bedrock,anthropic,google}.ts` in R06b/R07*)
 * implements the `Provider` interface defined here and registers itself with
 * `registerProvider(name, builder)` at module top-level. `createProvider` is
 * the single lookup keyed by the `PROVIDERS` env var values (spec
 * §Configuration) and throws `ValidationError` for unknown names so misconfig
 * surfaces at bootstrap (R13) rather than in a hot request path.
 *
 * This file deliberately owns ONLY the boundary types and the registry.
 * `ProviderRouter` (R06c) layers primary/fallback/retry semantics on top.
 *
 * Shape of provider calls and results comes from spec §API contracts: every
 * task (`describe` / `ocr` / `extract`) receives a raw image plus optional
 * task-specific hints and returns a token-accounted result plus the exact
 * model string the provider dispatched to.
 */

import { ValidationError } from '../errors';

/**
 * Canonical set of provider names supported by the service — matches the
 * comma-separated `PROVIDERS` env var in spec §Configuration. The string
 * literal union is the single source of truth; registration and lookup both
 * accept arbitrary `string` so env var parse errors route through
 * `ValidationError` rather than TypeScript.
 */
export const PROVIDERS = ['bedrock', 'openai', 'anthropic', 'google'] as const;

/** Narrow string literal type of a supported provider. */
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * Structural slice of the R03 `Config` shape that provider builders need.
 * Defined inline (rather than imported) so `src/core/providers/` compiles
 * before R03 lands — concrete providers read the credential fields they
 * actually require. R13 passes the full loaded `Config` into `createProvider`
 * and it structurally satisfies this interface.
 */
export interface ProviderFactoryConfig {
  readonly PROVIDERS: readonly string[];
  readonly DEFAULT_MODEL?: string;
  readonly AWS_REGION?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly GOOGLE_GENERATIVE_AI_API_KEY?: string;
}

/**
 * Uniform input for every provider method. Individual methods pick up the
 * hints relevant to them — `describe` uses `prompt`, `ocr` uses `languages`,
 * `extract` uses `schema` — but the wrapping router (R06c) forwards them
 * generically so a single call site works across tasks.
 *
 * `signal` is always forwarded into the underlying `ai-sdk` call so sync
 * request timeouts (R08) and client disconnects cancel provider work
 * (spec §Data flow › Timeout / abort).
 */
export interface ProviderCallInput {
  /** Raw image bytes after normalization (`src/core/image.ts`, R05). */
  bytes: Uint8Array;
  /** Sniffed / validated mime (`image/png` | `image/jpeg` | ...). */
  mime: string;
  /** Freeform prompt used by `describe`; ignored by `ocr`/`extract`. */
  prompt?: string;
  /**
   * JSON Schema the provider must produce for `extract`. Typed as `unknown`
   * here because `JsonSchema` is defined by R11; `extract` implementations
   * forward this into ai-sdk's structured-output mode.
   */
  schema?: unknown;
  /** ISO 639 language hints for `ocr` (e.g. `['en', 'fr']`). */
  languages?: string[];
  /** Cancellation signal forwarded into the underlying ai-sdk call. */
  signal?: AbortSignal;
}

/** Token accounting mirrors the ai-sdk usage shape. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Uniform return type for every provider method. `output` is deliberately
 * `unknown` at this layer — task runners (`src/core/tasks/*`, R08/R09/R11)
 * narrow it to their response shape. `model` is the *actual* model string
 * the provider dispatched against so the response envelope and the
 * `ProviderFailedError.details.attempts` trail are precise.
 */
export interface ProviderCallResult {
  output: unknown;
  usage: ProviderUsage;
  model: string;
}

/**
 * The provider boundary. Every ai-sdk-backed implementation exposes exactly
 * these three methods; `ProviderRouter` (R06c) calls one of them per request.
 */
export interface Provider {
  describe(input: ProviderCallInput): Promise<ProviderCallResult>;
  ocr(input: ProviderCallInput): Promise<ProviderCallResult>;
  extract(input: ProviderCallInput): Promise<ProviderCallResult>;
}

/**
 * Factory signature each concrete provider module exposes. Builders are
 * synchronous: credential validation (e.g. "OPENAI_API_KEY required") runs
 * here so misconfig fails at bootstrap.
 */
export type ProviderBuilder = (config: ProviderFactoryConfig) => Provider;

/**
 * Module-scoped registry. Populated by side-effect imports from the concrete
 * provider modules (`src/core/providers/openai.ts` etc.) added in R06b/R07*.
 * Left empty in R06a so `createProvider` throws for every name until a
 * concrete provider explicitly registers itself.
 */
const builders = new Map<string, ProviderBuilder>();

/**
 * Register a provider builder for the given name. Concrete provider modules
 * call this at top-level so that simply importing them (from R13 bootstrap
 * or a test) adds them to the factory. Re-registering the same name replaces
 * the previous builder — useful for test doubles.
 */
export function registerProvider(name: ProviderName, builder: ProviderBuilder): void {
  builders.set(name, builder);
}

/**
 * Resolve and instantiate a `Provider` for `name`. Throws `ValidationError`
 * (400 `invalid_request`) when no provider has registered under that name,
 * which covers both "unknown string" and "provider module was never
 * imported" (the latter is a wiring bug, surfaced immediately).
 */
export function createProvider(config: ProviderFactoryConfig, name: string): Provider {
  const builder = builders.get(name);
  if (!builder) {
    throw new ValidationError(`Unknown provider "${name}"`, {
      details: {
        name,
        supported: [...builders.keys()],
      },
    });
  }
  return builder(config);
}

/**
 * Test-only hook to clear the registry between test cases so registration
 * side-effects from one spec file do not leak into another. Underscore
 * prefix signals it is not part of the public API.
 */
export function _resetProviderRegistryForTests(): void {
  builders.clear();
}
