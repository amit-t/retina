/**
 * Anthropic (Claude) vision provider — concrete `Provider` implementation
 * backed by `@ai-sdk/anthropic`.
 *
 * Wiring notes
 * ------------
 * - Importing this module has a side-effect: it calls
 *   `registerProvider('anthropic', buildAnthropicProvider)` against the
 *   R06a registry. R13's bootstrap imports it so `createProvider(config,
 *   'anthropic')` resolves at runtime.
 * - `buildAnthropicProvider` is the pure, synchronous factory. It throws
 *   `ValidationError` when `ANTHROPIC_API_KEY` is absent so misconfig fails
 *   at bootstrap rather than in a hot request path (spec §Error handling).
 * - The three `Provider` methods (`describe`, `ocr`, `extract`) forward the
 *   image bytes + task-specific hints into ai-sdk's `generateText` /
 *   `generateObject` primitives as a multimodal user message, then map
 *   ai-sdk's `LanguageModelUsage` onto the narrower `ProviderUsage` shape
 *   (missing counts coerce to `0` so callers can math on them safely).
 *   `signal` is forwarded so R08's request-timeout + client disconnects
 *   cancel provider work (spec §Data flow › Timeout / abort).
 * - `schema` for `extract` is an opaque JSON Schema object (type is fixed
 *   by R11); we wrap it with `jsonSchema()` to satisfy `generateObject`'s
 *   `FlexibleSchema` contract without pulling R11 types here.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import {
  type FilePart,
  type FlexibleSchema,
  generateObject,
  generateText,
  jsonSchema,
  type TextPart,
} from 'ai';
import { ValidationError } from '../errors';
import {
  type Provider,
  type ProviderCallInput,
  type ProviderCallResult,
  type ProviderFactoryConfig,
  registerProvider,
} from './index';

/**
 * Default Claude model dispatched when the caller does not override via
 * request-level options.
 *
 * TODO(spec-open-q): confirm the exact vision-capable SKU + whether we pin
 * the dated alias (e.g. `claude-haiku-4-5-20251001`) or track the floating
 * one. Spec §Configuration only gates the `DEFAULT_MODEL` env var shape; it
 * does not nail down the Anthropic-specific choice. Keep this flagged so
 * the open question surfaces in review rather than shipping silently.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

/** Fallback prompt when the caller does not supply one for `describe`. */
const DEFAULT_DESCRIBE_PROMPT = 'Describe this image in concise, factual detail.';

/** Fallback OCR instruction; `languages` hints are appended at call time. */
const DEFAULT_OCR_PROMPT =
  'Transcribe all legible text from this image verbatim. Return only the text, with no commentary.';

/** Fallback prompt when `extract` is invoked without a caller-supplied one. */
const DEFAULT_EXTRACT_PROMPT =
  'Extract the structured data from this image and return it as JSON matching the provided schema.';

/**
 * Build an Anthropic-backed `Provider`. Throws `ValidationError` when
 * `ANTHROPIC_API_KEY` is missing — this is how bootstrap wiring (R13) tells
 * the operator they asked for `PROVIDERS=anthropic` but did not hand in the
 * credential.
 */
export function buildAnthropicProvider(config: ProviderFactoryConfig): Provider {
  const apiKey = config.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ValidationError('ANTHROPIC_API_KEY is required to enable the anthropic provider', {
      details: { provider: 'anthropic' },
    });
  }

  const anthropic = createAnthropic({ apiKey });
  const modelId = DEFAULT_ANTHROPIC_MODEL;
  const model = anthropic(modelId);

  const toFilePart = (input: ProviderCallInput): FilePart => ({
    type: 'file',
    data: input.bytes,
    mediaType: input.mime,
  });

  const toTextPart = (text: string): TextPart => ({ type: 'text', text });

  return {
    async describe(input: ProviderCallInput): Promise<ProviderCallResult> {
      const prompt = input.prompt ?? DEFAULT_DESCRIBE_PROMPT;
      const result = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [toTextPart(prompt), toFilePart(input)],
          },
        ],
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        model: modelId,
      };
    },

    async ocr(input: ProviderCallInput): Promise<ProviderCallResult> {
      const langs =
        input.languages && input.languages.length > 0
          ? ` Languages present: ${input.languages.join(', ')}.`
          : '';
      const prompt = `${DEFAULT_OCR_PROMPT}${langs}`;
      const result = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [toTextPart(prompt), toFilePart(input)],
          },
        ],
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        model: modelId,
      };
    },

    async extract(input: ProviderCallInput): Promise<ProviderCallResult> {
      if (input.schema === undefined || input.schema === null) {
        throw new ValidationError('extract requires a JSON schema', {
          details: { provider: 'anthropic' },
        });
      }
      const schema = jsonSchema(input.schema as Parameters<typeof jsonSchema>[0]) as FlexibleSchema<
        Record<string, unknown>
      >;
      const prompt = input.prompt ?? DEFAULT_EXTRACT_PROMPT;
      const result = await generateObject({
        model,
        schema,
        messages: [
          {
            role: 'user',
            content: [toTextPart(prompt), toFilePart(input)],
          },
        ],
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.object,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        model: modelId,
      };
    },
  };
}

// Side-effect registration: importing this module is what makes
// `createProvider(config, 'anthropic')` resolve.
registerProvider('anthropic', buildAnthropicProvider);
