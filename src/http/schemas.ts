// Shared Zod request / response schemas for Retina's HTTP surface.
//
// These schemas are the single source of truth for the `/v1/*` wire
// contract defined in spec §API contracts
// (docs/superpowers/specs/2026-04-21-retina-image-api-design.md). Route
// handlers (R08, R09, R11, R12b, R17) import from this module; the
// corresponding TypeScript response types below are what handlers return
// after the provider router resolves.
//
// Design notes:
// - `ImageInput` is a `z.union` of two object variants (`{url}` vs
//   `{base64, mime}`) rather than `z.discriminatedUnion` because the two
//   variants have no shared literal discriminator — the spec differentiates
//   them by the presence of `url` vs `base64`.
// - `ExtractRequest` enforces XOR between `schema` and `templateId` via
//   `.superRefine`. `AnalyzeRequest` is a `z.discriminatedUnion` on
//   `task`; its `extract` branch reuses the same XOR guard.
// - Request-level `ProviderOptions` REPLACE env-level defaults per
//   constitution invariant #8. The router (R06c) enforces replace-semantics;
//   this file only validates shape.

import { z } from 'zod';

/** Image MIME types Retina accepts on the base64 path (spec §Shared types). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const ImageMime = z.enum(IMAGE_MIME_TYPES);
export type ImageMime = z.infer<typeof ImageMime>;

const UrlImageInput = z.object({
  url: z.url(),
});

const Base64ImageInput = z.object({
  base64: z.string().min(1),
  mime: ImageMime,
});

/**
 * Request image. Multipart uploads are an alternate request encoding
 * handled outside this schema (spec §Shared types): the multipart parser
 * hydrates the internal `{bytes, mime}` form directly.
 */
export const ImageInput = z.union([UrlImageInput, Base64ImageInput]);
export type ImageInput = z.infer<typeof ImageInput>;

/**
 * Per-request provider controls. Each field replaces (does not merge) the
 * corresponding env-level default in `ProviderRouter` (constitution
 * invariant #8).
 */
export const ProviderOptions = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  fallback: z.array(z.string().min(1)).optional(),
  retries: z.number().int().min(0).optional(),
});
export type ProviderOptions = z.infer<typeof ProviderOptions>;

const providerOptionsShape = {
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  fallback: z.array(z.string().min(1)).optional(),
  retries: z.number().int().min(0).optional(),
} as const;

/** Ad-hoc extraction schema — a permissive object. Validity as a full
 * JSON Schema document is the provider's concern, not this layer's. */
export const JsonSchemaObject = z.record(z.string(), z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaObject>;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const DescribeRequest = z.object({
  image: ImageInput,
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  ...providerOptionsShape,
});
export type DescribeRequest = z.infer<typeof DescribeRequest>;

export const OCRRequest = z.object({
  image: ImageInput,
  languages: z.array(z.string().min(1)).optional(),
  ...providerOptionsShape,
});
export type OCRRequest = z.infer<typeof OCRRequest>;

/** Shared XOR guard used by both `ExtractRequest` and the `extract` branch
 * of `AnalyzeRequest`. Requires exactly one of `schema` / `templateId`. */
function enforceExtractXor(
  val: { schema?: JsonSchemaObject | undefined; templateId?: string | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  const hasSchema = val.schema !== undefined;
  const hasTemplate = val.templateId !== undefined;
  if (hasSchema && hasTemplate) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide exactly one of `schema` or `templateId`, not both.',
      path: ['templateId'],
    });
    return;
  }
  if (!hasSchema && !hasTemplate) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide one of `schema` or `templateId`.',
      path: ['schema'],
    });
  }
}

export const ExtractRequest = z
  .object({
    image: ImageInput,
    schema: JsonSchemaObject.optional(),
    templateId: z.string().min(1).optional(),
    ...providerOptionsShape,
  })
  .superRefine(enforceExtractXor);
export type ExtractRequest = z.infer<typeof ExtractRequest>;

// Analyze request is a discriminated union on `task`. Variants are built
// from shared shape fragments so the wire contract stays aligned with the
// per-capability endpoints above.
const AnalyzeDescribe = z.object({
  task: z.literal('describe'),
  image: ImageInput,
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  ...providerOptionsShape,
});

const AnalyzeOcr = z.object({
  task: z.literal('ocr'),
  image: ImageInput,
  languages: z.array(z.string().min(1)).optional(),
  ...providerOptionsShape,
});

const AnalyzeExtract = z
  .object({
    task: z.literal('extract'),
    image: ImageInput,
    schema: JsonSchemaObject.optional(),
    templateId: z.string().min(1).optional(),
    ...providerOptionsShape,
  })
  .superRefine(enforceExtractXor);

export const AnalyzeRequest = z.discriminatedUnion('task', [
  AnalyzeDescribe,
  AnalyzeOcr,
  AnalyzeExtract,
]);
export type AnalyzeRequest = z.infer<typeof AnalyzeRequest>;

/**
 * `POST /v1/jobs` body — analyze shape + optional `callbackUrl`. The
 * worker POSTs to `callbackUrl` only on successful completion
 * (constitution invariant #11).
 */
export const JobsRequest = z.discriminatedUnion('task', [
  AnalyzeDescribe.extend({ callbackUrl: z.url().optional() }),
  AnalyzeOcr.extend({ callbackUrl: z.url().optional() }),
  z
    .object({
      task: z.literal('extract'),
      image: ImageInput,
      schema: JsonSchemaObject.optional(),
      templateId: z.string().min(1).optional(),
      callbackUrl: z.url().optional(),
      ...providerOptionsShape,
    })
    .superRefine(enforceExtractXor),
]);
export type JobsRequest = z.infer<typeof JobsRequest>;

// ---------------------------------------------------------------------------
// Response types (TS types only — responses are shaped by handlers, not
// parsed from untrusted input, so runtime Zod schemas aren't required).
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DescribeResponse {
  description: string;
  provider: string;
  model: string;
  usage: TokenUsage;
}

/**
 * OCR text block. `bbox` is ALWAYS `null` in MVP (spec §API contracts,
 * constitution non-goals); the field is reserved for a future Phase 2
 * upgrade that returns layout geometry.
 */
export interface OcrBlock {
  text: string;
  bbox: null;
}

export interface OcrResponse {
  text: string;
  blocks: OcrBlock[];
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface ExtractResponse {
  data: Record<string, unknown>;
  /** `null` when the ad-hoc `schema` path was used; template id otherwise. */
  templateId: string | null;
  provider: string;
  model: string;
  usage: TokenUsage;
}

export type AnalyzeResponse =
  | { task: 'describe'; result: DescribeResponse }
  | { task: 'ocr'; result: OcrResponse }
  | { task: 'extract'; result: ExtractResponse };

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobsEnqueueResponse {
  jobId: string;
  status: 'queued';
}

export interface JobRecordResponse {
  jobId: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
  result: AnalyzeResponse['result'] | null;
  error: { code: string; message: string } | null;
}
