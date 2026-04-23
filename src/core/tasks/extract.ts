/**
 * `extract` task runner.
 *
 * `runExtract(router, registry, opts)` is the provider-agnostic slice invoked
 * by `POST /v1/extract` (R11 route) and the `extract` branch of `POST
 * /v1/analyze` (R12b). It resolves the JSON Schema the provider must produce
 * from EITHER the ad-hoc `opts.schema` OR a template looked up by
 * `opts.templateId`, forwards the per-request `ProviderOptions` via
 * replace-semantics (constitution invariant #8), and shapes the provider's
 * structured-output result into the wire shape:
 *
 *   { data, templateId, provider, model, usage }
 *
 * The structural `TaskRouter` interface lives in this module so R12b can
 * depend on it without importing `src/core/tasks/describe.ts` transitively.
 * The concrete `ProviderRouter` (R06c) satisfies it structurally.
 *
 * NOTE (R12b scope): this file ships the minimum surface `src/http/routes/
 * analyze.ts` needs to dispatch the extract branch with mocked deps in its
 * unit tests. R11 will flesh it out with structured-output semantics on the
 * provider side, a dedicated `POST /v1/extract` route, and its own
 * `test/unit/route-extract.spec.ts` suite.
 */

import { TemplateNotFoundError, ValidationError } from '../errors.js';
import type { ProviderCallInput, ProviderUsage } from '../providers/index.js';

/** Task names the router dispatches on — mirrors `Provider`'s three methods. */
export type TaskName = 'describe' | 'ocr' | 'extract';

/**
 * Per-request router overrides. Each field REPLACES (does not merge with)
 * the env-level default inside `ProviderRouter` (constitution invariant #8).
 */
export interface TaskRouterCallOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  signal?: AbortSignal;
}

/**
 * Structural slice of R06c's `ProviderRouter.call` surface that this task
 * runner needs. Concrete `ProviderRouter` instances satisfy this by
 * construction; test doubles only need to implement `call`.
 */
export interface TaskRouter {
  call(
    task: TaskName,
    input: ProviderCallInput,
    opts?: TaskRouterCallOptions,
  ): Promise<{
    output: unknown;
    usage: ProviderUsage;
    provider: string;
    model: string;
  }>;
}

/**
 * Permissive JSON Schema shape accepted at this layer. The full validity of
 * a JSON Schema document is the provider's concern (ai-sdk structured-output
 * mode), not this runner's.
 */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * One template as returned by `TemplateRegistry.get`. The full shape comes
 * from R10 (`src/core/templates.ts`); this file only depends on the two
 * fields `runExtract` reads — `id` for the response envelope and `schema`
 * for the provider call.
 */
export interface Template {
  id: string;
  version: string;
  description: string;
  schema: JsonSchemaObject;
}

/**
 * Structural slice of R10's `TemplateRegistry` used by `runExtract`.
 *
 * `.get(id)` must throw `TemplateNotFoundError` on miss (R11 spec). R10's
 * concrete implementation satisfies this by construction; tests can supply
 * an object literal with just a `get` method.
 */
export interface TemplateRegistry {
  get(id: string): Template;
  list(): ReadonlyArray<Pick<Template, 'id' | 'version' | 'description'>>;
}

/**
 * Inputs to {@link runExtract}. `bytes`/`mime` come from `normalize()` (R05);
 * `schema` XOR `templateId` mirrors the wire contract — the XOR itself is
 * enforced by Zod (`src/http/schemas.ts`), so this runner treats both
 * fields as opaque and re-checks only that exactly one was supplied.
 */
export interface RunExtractOptions {
  bytes: Uint8Array;
  mime: string;
  /** Ad-hoc JSON Schema the caller wants the provider to produce. */
  schema?: JsonSchemaObject;
  /** Template id resolved against `registry`. */
  templateId?: string;
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  signal?: AbortSignal;
}

/** Shape returned to the route handler — matches `ExtractResponse` in
 *  `src/http/schemas.ts`. `templateId` is `null` when the ad-hoc `schema`
 *  path was used, the resolved id otherwise. */
export interface ExtractResult {
  data: Record<string, unknown>;
  templateId: string | null;
  provider: string;
  model: string;
  usage: ProviderUsage;
}

export async function runExtract(
  router: TaskRouter,
  registry: TemplateRegistry,
  opts: RunExtractOptions,
): Promise<ExtractResult> {
  const { schema, templateId } = resolveSchema(registry, opts);

  const callInput: ProviderCallInput = {
    bytes: opts.bytes,
    mime: opts.mime,
    schema,
  };
  if (opts.signal !== undefined) callInput.signal = opts.signal;

  const callOpts: TaskRouterCallOptions = {};
  if (opts.provider !== undefined) callOpts.provider = opts.provider;
  if (opts.model !== undefined) callOpts.model = opts.model;
  if (opts.fallback !== undefined) callOpts.fallback = opts.fallback;
  if (opts.retries !== undefined) callOpts.retries = opts.retries;
  if (opts.signal !== undefined) callOpts.signal = opts.signal;

  const hasOpts = Object.keys(callOpts).length > 0;
  const result = hasOpts
    ? await router.call('extract', callInput, callOpts)
    : await router.call('extract', callInput);

  return {
    data: coerceData(result.output),
    templateId,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

/**
 * Resolve the schema for a provider call.
 *
 *   - `opts.schema` → ad-hoc path; `templateId` in the response is `null`.
 *   - `opts.templateId` → registry lookup; response `templateId` is the
 *     resolved id (propagated even if the registry normalizes casing).
 *
 * The Zod layer already enforces XOR so hitting the neither/both branches
 * here is a wiring bug, not a user error — throw `ValidationError` so the
 * error envelope is still correct if it does happen.
 */
function resolveSchema(
  registry: TemplateRegistry,
  opts: RunExtractOptions,
): { schema: JsonSchemaObject; templateId: string | null } {
  const hasSchema = opts.schema !== undefined;
  const hasTemplate = opts.templateId !== undefined;

  if (hasSchema && hasTemplate) {
    throw new ValidationError('Provide exactly one of `schema` or `templateId`, not both.');
  }
  if (!hasSchema && !hasTemplate) {
    throw new ValidationError('Provide one of `schema` or `templateId`.');
  }

  if (hasSchema) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by hasSchema.
    return { schema: opts.schema!, templateId: null };
  }

  // biome-ignore lint/style/noNonNullAssertion: guarded by hasTemplate.
  const template = registry.get(opts.templateId!);
  if (template === undefined) {
    // Defence-in-depth: R10 contract says `.get` throws on miss, but a test
    // double that returns `undefined` must still map to the canonical 404.
    throw new TemplateNotFoundError(`Template "${opts.templateId}" not found`);
  }
  return { schema: template.schema, templateId: template.id };
}

/**
 * Coerce the provider's structured-output `output` into the response `data`
 * field. Providers (R06b/R07*, via ai-sdk structured-output) return a
 * parsed object; we only refuse non-objects so the wire type
 * `Record<string, unknown>` holds.
 */
function coerceData(output: unknown): Record<string, unknown> {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  throw new ValidationError('Provider returned non-object extract result', {
    details: { outputType: output === null ? 'null' : typeof output },
  });
}
