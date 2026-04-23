/**
 * `extract` task runner.
 *
 * `runExtract(router, registry, opts)` is the provider-agnostic slice invoked
 * by both `POST /v1/extract` (sync) and `POST /v1/jobs` when
 * `task === 'extract'` (async, R17). It resolves the JSON Schema from one of
 * two mutually-exclusive sources — the ad-hoc `opts.schema` or the
 * server-registered template keyed by `opts.templateId` — then dispatches
 * through the `TaskRouter` in structured-output mode.
 *
 * Spec § `POST /v1/extract` fixes the wire response shape:
 *
 *     { data, templateId: string | null, provider, model, usage }
 *
 * The ad-hoc path always emits `templateId: null` so callers can tell which
 * code path the server took without inspecting the request.
 *
 * Structural typing note: this module deliberately depends on structural
 * slices of `ProviderRouter` (R06c) and `TemplateRegistry` (R10) rather than
 * importing the concrete classes. That lets R11 land ahead of R10 and keeps
 * unit tests free of mock-heavy wiring — any test double that satisfies the
 * two interfaces suffices.
 */

import type { ProviderCallInput, ProviderUsage } from '../providers/index.js';

/** Task names the router dispatches on; mirrors `Provider`'s three methods. */
export type TaskName = 'describe' | 'ocr' | 'extract';

/**
 * Per-request router overrides. Each field REPLACES the env-level default
 * inside `ProviderRouter` (constitution invariant #8) — this module only
 * forwards the values, it neither merges nor inspects them.
 */
export interface TaskRouterCallOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  signal?: AbortSignal;
}

/** Uniform router result — matches R06c §ProviderRouter.call return. */
export interface TaskRouterResult {
  output: unknown;
  usage: ProviderUsage;
  provider: string;
  model: string;
}

/**
 * Structural slice of R06c's `ProviderRouter.call` surface. Concrete
 * `ProviderRouter` instances satisfy this by construction; unit tests only
 * need to implement `call`.
 */
export interface TaskRouter {
  call(
    task: TaskName,
    input: ProviderCallInput,
    opts?: TaskRouterCallOptions,
  ): Promise<TaskRouterResult>;
}

/**
 * JSON Schema carried by a template or supplied ad-hoc. The provider layer
 * forwards the object verbatim into `ai-sdk`'s `jsonSchema()` helper, so
 * validity as a full JSON Schema 7 document is the provider's concern —
 * Retina just type-tags it as a plain object at this layer.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Registered template shape. `id` echoes into the response when the
 * template path is taken; `schema` is forwarded into the provider call.
 * `version` / `description` are metadata returned by `GET /v1/templates`
 * and are unused by this runner.
 */
export interface Template {
  id: string;
  version: string;
  description: string;
  schema: JsonSchema;
}

/**
 * Structural slice of R10's `TemplateRegistry`. `get()` MUST throw
 * `TemplateNotFoundError` (from `src/core/errors.ts`) when the id does not
 * resolve — the error middleware maps that to a 404 `template_not_found`
 * response envelope, so this module neither catches nor rewraps the error.
 */
export interface TemplateRegistry {
  get(id: string): Template;
}

/** Per-request provider controls accepted by the task runner. Mirrors the
 *  `ProviderOptions` shape in `src/http/schemas.ts`. */
export interface TaskProviderOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
}

/**
 * Input to {@link runExtract}. Assembled by the HTTP route after Zod
 * validation (R04) and image normalization (R05). Exactly one of `schema`
 * or `templateId` must be populated — the XOR guard in R04 enforces this
 * at the wire layer; `runExtract` trusts its callers and prefers `schema`
 * if both happen to be supplied.
 */
export interface ExtractTaskInput {
  bytes: Uint8Array;
  mime: string;
  /** Ad-hoc JSON Schema — wins if both `schema` and `templateId` are set. */
  schema?: JsonSchema;
  /** Id of a server-registered template (loaded from `TEMPLATES_DIR`). */
  templateId?: string;
  /** Per-request router overrides. */
  providerOptions?: TaskProviderOptions;
  /** Cancellation signal threaded through to the provider. */
  signal?: AbortSignal;
}

/**
 * Shape returned to the route handler — matches `ExtractResponse` in
 * `src/http/schemas.ts`. `templateId` is `null` on the ad-hoc path and the
 * resolved id on the template path.
 */
export interface ExtractResult {
  data: Record<string, unknown>;
  templateId: string | null;
  provider: string;
  model: string;
  usage: ProviderUsage;
}

/**
 * Run an extract task via the provider router.
 *
 * Resolution rules:
 *
 *  - `opts.schema` present → ad-hoc path; response `templateId` is `null`.
 *    The registry is NOT consulted.
 *  - `opts.templateId` present (and `schema` absent) → template path;
 *    `registry.get(id)` resolves the schema. On unknown id the registry
 *    throws `TemplateNotFoundError` (from `src/core/errors.ts`) which
 *    propagates out of `runExtract` unchanged so the error middleware can
 *    shape the 404.
 *  - Neither present → this indicates a caller bug (the Zod XOR guard in
 *    R04 is meant to reject that at the route layer). We throw a plain
 *    `Error` here rather than a typed `RetinaError` so it surfaces as a
 *    500 `internal_error` in the envelope — the wire contract has already
 *    been violated upstream.
 *
 * Response coercion:
 *
 *  - The provider returns `output: unknown`. ai-sdk's `generateObject`
 *    yields a JS object for well-formed structured output; `extract`
 *    implementations (R06b/R07a-c) forward that straight through. Non-
 *    object outputs (null, string, array, etc.) are coerced to `{}` so the
 *    `data: Record<string, unknown>` contract always holds — the wire
 *    shape never lies about containing an object.
 */
export async function runExtract(
  router: TaskRouter,
  registry: TemplateRegistry,
  opts: ExtractTaskInput,
): Promise<ExtractResult> {
  const { schema, templateIdEcho } = resolveSchema(registry, opts);

  const input: ProviderCallInput = {
    bytes: opts.bytes,
    mime: opts.mime,
    schema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  const callOpts = buildCallOptions(opts.providerOptions, opts.signal);

  const { output, usage, provider, model } =
    callOpts === undefined
      ? await router.call('extract', input)
      : await router.call('extract', input, callOpts);

  return {
    data: coerceData(output),
    templateId: templateIdEcho,
    provider,
    model,
    usage,
  };
}

function resolveSchema(
  registry: TemplateRegistry,
  opts: ExtractTaskInput,
): { schema: JsonSchema; templateIdEcho: string | null } {
  if (opts.schema !== undefined) {
    return { schema: opts.schema, templateIdEcho: null };
  }
  if (opts.templateId !== undefined) {
    const template = registry.get(opts.templateId);
    return { schema: template.schema, templateIdEcho: template.id };
  }
  throw new Error(
    'runExtract requires one of `schema` or `templateId`; the route-layer XOR guard (R04) should have rejected this request',
  );
}

function buildCallOptions(
  providerOptions: TaskProviderOptions | undefined,
  signal: AbortSignal | undefined,
): TaskRouterCallOptions | undefined {
  const out: TaskRouterCallOptions = {};
  if (providerOptions?.provider !== undefined) out.provider = providerOptions.provider;
  if (providerOptions?.model !== undefined) out.model = providerOptions.model;
  if (providerOptions?.fallback !== undefined) out.fallback = providerOptions.fallback;
  if (providerOptions?.retries !== undefined) out.retries = providerOptions.retries;
  if (signal !== undefined) out.signal = signal;
  return Object.keys(out).length === 0 ? undefined : out;
}

function coerceData(output: unknown): Record<string, unknown> {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return {};
}
