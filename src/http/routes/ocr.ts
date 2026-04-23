// POST /v1/ocr — OCR sync endpoint.
//
// Pipeline: Zod-validate request (R04 schemas) → normalize image (R05) →
// dispatch through `TaskRouter.ocr` (R06c) via `runOcr` (this task's
// `src/core/tasks/ocr.ts`) → shape `OcrResponse` per spec §API contracts.
//
// Errors are always thrown as `RetinaError` subclasses so the global error
// middleware (R02e) emits the canonical envelope — this handler never
// constructs an error response itself (constitution invariants #6, #7).

import { Hono } from 'hono';
import { ValidationError } from '../../core/errors.js';
import { type NormalizeInput, normalize } from '../../core/image.js';
import { type RunOcrOptions, runOcr, type TaskRouter } from '../../core/tasks/ocr.js';
import { OCRRequest, type OcrResponse } from '../schemas.js';

export interface CreateOcrRouteDeps {
  router: TaskRouter;
  /** Byte cap forwarded into `normalize()` — always `config.MAX_IMAGE_BYTES`
   *  in production; tests may pass a smaller cap to exercise the 413 path. */
  maxBytes: number;
  /** Optional fetch timeout for the URL image variant (default 10_000ms in
   *  `normalize`). Exposed here for e2e tests to shrink the wait. */
  urlTimeoutMs?: number;
}

/**
 * Build the OCR route. Returned Hono app is mountable at the root by the
 * composition root (`src/app.ts`).
 */
export function createOcrRoute(deps: CreateOcrRouteDeps): Hono {
  const app = new Hono();

  app.post('/v1/ocr', async (c) => {
    const raw = await readJson(c.req.raw);
    const parsed = OCRRequest.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('Invalid OCR request body', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      });
    }

    const body = parsed.data;

    const normalizeOpts: Parameters<typeof normalize>[1] = { maxBytes: deps.maxBytes };
    if (deps.urlTimeoutMs !== undefined) normalizeOpts.urlTimeoutMs = deps.urlTimeoutMs;

    // `OCRRequest.image` is the `{url} | {base64, mime}` subset of
    // `NormalizeInput`; the third `{bytes, mime}` variant is reserved for
    // multipart uploads (R15).
    const normalized = await normalize(body.image as NormalizeInput, normalizeOpts);

    const runOpts: RunOcrOptions = {
      bytes: normalized.bytes,
      mime: normalized.mime,
    };
    if (body.languages !== undefined) runOpts.languages = body.languages;
    if (body.provider !== undefined) runOpts.provider = body.provider;
    if (body.model !== undefined) runOpts.model = body.model;
    if (body.fallback !== undefined) runOpts.fallback = body.fallback;
    if (body.retries !== undefined) runOpts.retries = body.retries;
    // Client-disconnect cancellation per spec §Data flow › Timeout / abort.
    // R13 will also wrap the handler in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`.
    if (c.req.raw.signal !== undefined) runOpts.signal = c.req.raw.signal;

    const result = await runOcr(deps.router, runOpts);

    const response: OcrResponse = {
      text: result.text,
      blocks: result.blocks,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    };
    return c.json(response);
  });

  return app;
}

/**
 * Parse the request body as JSON, converting syntax errors and empty bodies
 * into `ValidationError` so the error envelope carries the canonical
 * `invalid_request` code.
 */
async function readJson(req: Request): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch (cause) {
    throw new ValidationError('Failed to read request body', { cause });
  }
  if (text.length === 0) {
    throw new ValidationError('Request body is empty; expected JSON');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ValidationError('Request body is not valid JSON', { cause });
  }
}
