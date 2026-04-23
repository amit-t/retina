/**
 * OpenAI backend for the Retina provider boundary (spec §Providers / Q5).
 *
 * Implements `Provider` from `./index.ts` (R06a) by dispatching through
 * `@ai-sdk/openai` + `ai`:
 *
 *   describe → `generateText({ model, messages: [user(prompt + image)] })`
 *   ocr      → `generateText({ model, messages: [user(ocr prompt + image)] })`
 *   extract  → `generateObject({ model, schema, messages: [user(image)] })`
 *
 * All provider SDK access is funneled through `ai-sdk` per constitution
 * invariant 5 — no raw `openai` calls.
 *
 * The builder is registered as the `'openai'` name in R06a's factory as a
 * module-load side effect, so simply importing this module from R13
 * bootstrap (or a test) adds it to `createProvider`.
 */

import { createOpenAI } from '@ai-sdk/openai';
import {
  generateObject,
  generateText,
  type ImagePart,
  jsonSchema,
  type TextPart,
  type UserModelMessage,
} from 'ai';

import { ValidationError } from '../errors.js';
import {
  type Provider,
  type ProviderBuilder,
  type ProviderCallInput,
  type ProviderCallResult,
  type ProviderFactoryConfig,
  registerProvider,
} from './index.js';

/**
 * Default OpenAI model ID used when `DEFAULT_MODEL` is not set in config.
 *
 * TODO(spec-open-q): verify vision-capable SKU — spec §Open questions lists
 * "Default model IDs per provider — needs a current pass against each
 * provider's vision-capable SKUs at implementation time." `gpt-4o` is the
 * current widely-deployed OpenAI vision model, but operators are expected
 * to override via `DEFAULT_MODEL` once they pick their SKU of record.
 */
export const OPENAI_DEFAULT_MODEL_ID = 'gpt-4o';

const OCR_SYSTEM_PROMPT =
  'You are an OCR engine. Transcribe ALL visible text from the image verbatim, preserving line breaks. Do not summarize, translate, or add commentary.';

const EXTRACT_SYSTEM_PROMPT =
  'You are a structured-extraction engine. Populate the provided JSON Schema from the image. Use null for unknown fields. Do not invent data.';

function buildOcrPrompt(languages: readonly string[] | undefined): string {
  if (!languages || languages.length === 0) return 'Transcribe all visible text from this image.';
  return `Transcribe all visible text from this image. Expected languages: ${languages.join(', ')}.`;
}

/**
 * Build the user-role message carrying prompt text + the image bytes. We
 * forward `mime` into `mediaType` so ai-sdk can encode the image correctly
 * for the underlying OpenAI Responses API call.
 */
function buildImageMessage(textParts: string[], input: ProviderCallInput): UserModelMessage {
  const content: Array<TextPart | ImagePart> = [];
  for (const text of textParts) {
    if (text.length > 0) content.push({ type: 'text', text });
  }
  content.push({ type: 'image', image: input.bytes, mediaType: input.mime });
  return { role: 'user', content };
}

function normalizeUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): ProviderCallResult['usage'] {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/**
 * Conditionally include `abortSignal` — `exactOptionalPropertyTypes` forbids
 * passing `undefined` for an optional field, and ai-sdk's types treat
 * `abortSignal?: AbortSignal` as genuinely absent vs. present.
 */
function withAbortSignal<T extends object>(
  base: T,
  signal: AbortSignal | undefined,
): T & { abortSignal?: AbortSignal } {
  return signal === undefined ? base : { ...base, abortSignal: signal };
}

export const buildOpenAiProvider: ProviderBuilder = (config: ProviderFactoryConfig): Provider => {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new ValidationError('OPENAI_API_KEY is required when provider "openai" is configured', {
      details: { provider: 'openai' },
    });
  }

  const modelId = config.DEFAULT_MODEL ?? OPENAI_DEFAULT_MODEL_ID;
  const client = createOpenAI({ apiKey });
  const model = client(modelId);

  const describe = async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    const userPrompt = input.prompt ?? 'Describe this image in detail.';
    const result = await generateText(
      withAbortSignal(
        {
          model,
          messages: [buildImageMessage([userPrompt], input)],
        },
        input.signal,
      ),
    );
    return {
      output: result.text,
      usage: normalizeUsage(result.usage),
      model: modelId,
    };
  };

  const ocr = async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    const result = await generateText(
      withAbortSignal(
        {
          model,
          system: OCR_SYSTEM_PROMPT,
          messages: [buildImageMessage([buildOcrPrompt(input.languages)], input)],
        },
        input.signal,
      ),
    );
    return {
      output: result.text,
      usage: normalizeUsage(result.usage),
      model: modelId,
    };
  };

  const extract = async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    if (input.schema === undefined || input.schema === null) {
      throw new ValidationError('extract requires a JSON Schema', {
        details: { provider: 'openai' },
      });
    }
    // ai-sdk's `jsonSchema` takes a JSON Schema 7 object; the task runner
    // (R11) validates the incoming schema is well-formed before we get here.
    const result = await generateObject(
      withAbortSignal(
        {
          model,
          // biome-ignore lint/suspicious/noExplicitAny: JsonSchema type lands in R11; the provider boundary accepts unknown and forwards into ai-sdk.
          schema: jsonSchema(input.schema as any),
          system: EXTRACT_SYSTEM_PROMPT,
          messages: [buildImageMessage([], input)],
        },
        input.signal,
      ),
    );
    return {
      output: result.object,
      usage: normalizeUsage(result.usage),
      model: modelId,
    };
  };

  return { describe, ocr, extract };
};

registerProvider('openai', buildOpenAiProvider);
