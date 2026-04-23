/**
 * Google Generative AI (Gemini) provider.
 *
 * Implements the `Provider` interface (R06a) on top of `@ai-sdk/google`.
 * Reads `GOOGLE_GENERATIVE_AI_API_KEY` from the R03 config — missing key at
 * factory time throws `ValidationError` so misconfig fails at bootstrap (R13)
 * rather than mid-request.
 *
 * `ProviderOptions.model` (request-level) is threaded through `ProviderRouter`
 * (R06c); when unset we fall back to `config.DEFAULT_MODEL` and finally to
 * `DEFAULT_GOOGLE_MODEL` below.
 *
 * Task shapes:
 * - `describe` + `ocr` — `generateText` with an image+text multimodal user
 *   message. The `prompt`/`languages` hints from the caller shape the text
 *   part; `ocr`'s default prompt instructs the model to extract all visible
 *   text verbatim. Task runners (R08/R09) own higher-level prompt templates;
 *   this file only stitches the raw hint into the model call.
 * - `extract` — `generateObject` in `'json'` mode with the caller-supplied
 *   JSON Schema, which matches spec §API contracts `POST /v1/extract`.
 *
 * Importing this module registers the builder on R06a's registry as a side
 * effect, so a single `import './google'` at bootstrap (R13) wires it up.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject, generateText, jsonSchema, type ModelMessage } from 'ai';
import { ValidationError } from '../errors';
import {
  type Provider,
  type ProviderBuilder,
  type ProviderCallInput,
  type ProviderCallResult,
  type ProviderFactoryConfig,
  registerProvider,
} from './index';

/**
 * Default Gemini model for all three tasks. Kept here (rather than per-task)
 * until the spec nails down task-specific models.
 *
 * TODO(spec-open-q): verify vision-capable SKU — spec §Configuration lists
 * `GOOGLE_GENERATIVE_AI_API_KEY` but leaves the canonical model identifier
 * open. `gemini-2.5-flash` is chosen as a balanced vision-capable default
 * from the `@ai-sdk/google` supported list; confirm once product selects
 * the preferred SKU.
 */
export const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-flash';

/** Default OCR prompt used when the caller does not supply one. */
const OCR_PROMPT = 'Extract all visible text from this image verbatim.';

/** Default describe prompt used when the caller does not supply one. */
const DEFAULT_DESCRIBE_PROMPT = 'Describe this image.';

/** Default extract prompt used when the caller does not supply one. */
const EXTRACT_PROMPT = 'Extract structured data from this image using the provided schema.';

/**
 * Map ai-sdk's `LanguageModelUsage` (where each field is `number | undefined`)
 * onto the tight `ProviderUsage` shape (both fields required numbers). Missing
 * counts coerce to `0` so downstream accounting stays a plain sum.
 */
function toUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): ProviderCallResult['usage'] {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/**
 * Build the ai-sdk multimodal user message (one text part + one image part).
 * `bytes` are raw image bytes post-normalize (R05); `mime` is the sniffed
 * media type (`image/png`, `image/jpeg`, ...).
 */
function buildMessages(text: string, input: ProviderCallInput): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image', image: input.bytes, mediaType: input.mime },
      ],
    },
  ];
}

/**
 * Build a `Provider` bound to the given `config`. Exported so R06a's
 * `createProvider` can be called directly in tests without going through
 * the registry; module-level `registerProvider` wires the same builder
 * into the factory for production use.
 */
export const googleProviderBuilder: ProviderBuilder = (config: ProviderFactoryConfig): Provider => {
  const apiKey = config.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new ValidationError('GOOGLE_GENERATIVE_AI_API_KEY is required for the "google" provider');
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const modelId = config.DEFAULT_MODEL ?? DEFAULT_GOOGLE_MODEL;

  return {
    async describe(input: ProviderCallInput): Promise<ProviderCallResult> {
      const result = await generateText({
        model: google(modelId),
        messages: buildMessages(input.prompt ?? DEFAULT_DESCRIBE_PROMPT, input),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.text,
        usage: toUsage(result.totalUsage),
        model: modelId,
      };
    },

    async ocr(input: ProviderCallInput): Promise<ProviderCallResult> {
      const hint =
        input.languages && input.languages.length > 0
          ? `${OCR_PROMPT} Expected languages: ${input.languages.join(', ')}.`
          : OCR_PROMPT;
      const result = await generateText({
        model: google(modelId),
        messages: buildMessages(hint, input),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.text,
        usage: toUsage(result.totalUsage),
        model: modelId,
      };
    },

    async extract(input: ProviderCallInput): Promise<ProviderCallResult> {
      if (input.schema === undefined) {
        throw new ValidationError('extract requires a schema');
      }
      const result = await generateObject({
        model: google(modelId),
        schema: jsonSchema(input.schema as Parameters<typeof jsonSchema>[0]),
        messages: buildMessages(input.prompt ?? EXTRACT_PROMPT, input),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      return {
        output: result.object,
        usage: toUsage(result.usage),
        model: modelId,
      };
    },
  };
};

// Side-effect registration: importing this module adds the builder to R06a's
// factory. Re-registration is idempotent (`Map.set` replaces).
registerProvider('google', googleProviderBuilder);
