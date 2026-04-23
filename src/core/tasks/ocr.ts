// OCR task runner.
//
// `runOcr(router, opts)` builds the provider-agnostic OCR call, dispatches
// it through the `ProviderRouter` (R06c), and shapes the result into the
// wire-stable `OcrResult` defined in spec §API contracts
// (docs/superpowers/specs/2026-04-21-retina-image-api-design.md §`POST
// /v1/ocr`).
//
// Key invariants (constitution §Non-goals #5, spec §Non-goals):
//
//   - `blocks[].bbox` is ALWAYS `null`. Bounding-box OCR is explicitly Phase 2.
//   - `blocks` mirrors `text`: one block containing the full text, or `[]`
//     when the provider returned empty text. The shape keeps the response
//     stable for the future per-block upgrade without lying about content.
//   - `languages` is forwarded both into the textual prompt and into the
//     provider call input so SDK-level language hints (where supported)
//     can pick it up alongside the prompt-level nudge.
//
// This module deliberately depends on a structural `TaskRouter` interface
// rather than importing the concrete `ProviderRouter` class from R06c so
// R09 can land (and be unit-tested with a stub router) before R06c merges.
// The real `ProviderRouter.call` signature satisfies this interface by
// construction.

import type { ProviderCallInput, ProviderUsage } from '../providers/index.js';

/** Task names the router dispatches on; mirrors `Provider`'s three methods. */
export type TaskName = 'describe' | 'ocr' | 'extract';

/**
 * Request-level router overrides. Per constitution invariant #8 each field
 * REPLACES (does not merge with) the env-level default inside the router.
 * Forwarded through verbatim — `runOcr` neither inspects nor mutates them.
 */
export interface TaskRouterCallOptions {
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  signal?: AbortSignal;
}

/**
 * Structural slice of R06c's `ProviderRouter.call` surface that task
 * runners need. Concrete `ProviderRouter` instances satisfy this by
 * construction; test doubles only need to implement `call`.
 */
export interface TaskRouter {
  call(
    task: TaskName,
    input: ProviderCallInput,
    opts: TaskRouterCallOptions,
  ): Promise<{
    output: unknown;
    usage: ProviderUsage;
    provider: string;
    model: string;
  }>;
}

/**
 * OCR text block. `bbox` is ALWAYS `null` in MVP; see file header. Keep the
 * shape aligned with `OcrBlock` in `src/http/schemas.ts` — the HTTP response
 * type imports from there.
 */
export interface OcrBlock {
  text: string;
  bbox: null;
}

export interface OcrResult {
  text: string;
  blocks: OcrBlock[];
  provider: string;
  model: string;
  usage: ProviderUsage;
}

/**
 * Inputs to {@link runOcr}. `bytes`/`mime` come from `normalize()` (R05);
 * the rest mirrors the wire shape of `OCRRequest & ProviderOptions`.
 */
export interface RunOcrOptions {
  bytes: Uint8Array;
  mime: string;
  languages?: string[];
  provider?: string;
  model?: string;
  fallback?: string[];
  retries?: number;
  signal?: AbortSignal;
}

const OCR_PROMPT_BASE =
  'Extract all legible text from the image. Return only the extracted text, preserving reading order where possible. Do not summarize, translate, or add commentary. If no text is present, return an empty string.';

/**
 * Build the OCR user prompt. Exported for the unit test that asserts the
 * `languages` hint is forwarded into the prompt verbatim.
 */
export function buildOcrPrompt(languages?: readonly string[]): string {
  if (languages === undefined || languages.length === 0) return OCR_PROMPT_BASE;
  return `${OCR_PROMPT_BASE} The text is written in the following language(s): ${languages.join(
    ', ',
  )}.`;
}

export async function runOcr(router: TaskRouter, opts: RunOcrOptions): Promise<OcrResult> {
  const prompt = buildOcrPrompt(opts.languages);

  const callInput: ProviderCallInput = {
    bytes: opts.bytes,
    mime: opts.mime,
    prompt,
  };
  if (opts.languages !== undefined) callInput.languages = opts.languages;
  if (opts.signal !== undefined) callInput.signal = opts.signal;

  const callOpts: TaskRouterCallOptions = {};
  if (opts.provider !== undefined) callOpts.provider = opts.provider;
  if (opts.model !== undefined) callOpts.model = opts.model;
  if (opts.fallback !== undefined) callOpts.fallback = opts.fallback;
  if (opts.retries !== undefined) callOpts.retries = opts.retries;
  if (opts.signal !== undefined) callOpts.signal = opts.signal;

  const result = await router.call('ocr', callInput, callOpts);

  const text = typeof result.output === 'string' ? result.output : '';
  // Single-block MVP shape (see file header). Empty text → empty blocks so
  // clients can rely on `blocks.length === 0` as the no-text signal without
  // inspecting `text` too.
  const blocks: OcrBlock[] = text.length > 0 ? [{ text, bbox: null }] : [];

  return {
    text,
    blocks,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}
