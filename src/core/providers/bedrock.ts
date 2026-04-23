/**
 * Amazon Bedrock provider implementation for the R06a `Provider` interface.
 *
 * Wires `@ai-sdk/amazon-bedrock` + `ai`'s `generateText`/`generateObject`
 * into our uniform three-method surface (`describe` / `ocr` / `extract`).
 *
 * Credential resolution follows Bedrock-on-AWS deployment norms:
 *   - `AWS_REGION` is REQUIRED — missing it is a bootstrap error surfaced as
 *     `ValidationError` so operators catch misconfig before hitting the
 *     request path (spec §Configuration + constitution invariant #10).
 *   - Explicit `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are OPTIONAL
 *     and forwarded verbatim when both are present.
 *   - When neither explicit key is provided, `createAmazonBedrock` falls
 *     back to AWS's default credential provider chain — environment vars,
 *     shared config file, IAM instance / pod role, SSO — so production
 *     workloads running under an IAM role just work without plumbing
 *     static creds through env.
 *
 * Registration happens at module top-level (`registerProvider('bedrock',
 * createBedrockProvider)`) so R13 bootstrap / tests only need to import
 * this file to light the provider up in the R06a factory.
 */

import {
  type AmazonBedrockProvider,
  type AmazonBedrockProviderSettings,
  createAmazonBedrock,
} from '@ai-sdk/amazon-bedrock';
import { generateObject, generateText, type JSONSchema7, jsonSchema } from 'ai';
import { ValidationError } from '../errors';
import {
  type Provider,
  type ProviderBuilder,
  type ProviderCallInput,
  type ProviderCallResult,
  type ProviderFactoryConfig,
  type ProviderUsage,
  registerProvider,
} from './index';

/**
 * Default Bedrock chat model used when `config.DEFAULT_MODEL` is not set.
 *
 * TODO(spec-open-q): confirm the canonical Bedrock vision SKU we want to
 * ship with. Claude 3.5 Sonnet v2 is vision-capable on Bedrock and widely
 * enabled in the common US regions, which is why it is the current default
 * — but the spec leaves the exact baseline undecided, so this constant
 * will be revisited when the vision SKU matrix is pinned down.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';

const DEFAULT_DESCRIBE_PROMPT =
  'Describe this image in detail. Focus on the objects, people, setting, ' +
  'and any notable context. Respond with a single paragraph of plain text.';

function buildOcrPrompt(languages: readonly string[] | undefined): string {
  const base =
    'Extract every visible piece of text from this image verbatim. Preserve ' +
    'reading order. Respond with plain text only — no commentary, no ' +
    'markdown fences.';
  if (!languages || languages.length === 0) return base;
  return `${base} Expected languages (ISO 639): ${languages.join(', ')}.`;
}

function mapUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): ProviderUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

function buildSettings(config: ProviderFactoryConfig): AmazonBedrockProviderSettings {
  if (!config.AWS_REGION) {
    throw new ValidationError('AWS_REGION is required for the bedrock provider', {
      details: { provider: 'bedrock', missing: 'AWS_REGION' },
    });
  }

  const hasAccessKey =
    typeof config.AWS_ACCESS_KEY_ID === 'string' && config.AWS_ACCESS_KEY_ID !== '';
  const hasSecretKey =
    typeof config.AWS_SECRET_ACCESS_KEY === 'string' && config.AWS_SECRET_ACCESS_KEY !== '';
  if (hasAccessKey !== hasSecretKey) {
    throw new ValidationError(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together for the bedrock provider',
      {
        details: {
          provider: 'bedrock',
          missing: hasAccessKey ? 'AWS_SECRET_ACCESS_KEY' : 'AWS_ACCESS_KEY_ID',
        },
      },
    );
  }

  // Only populate explicit credentials when BOTH are present; otherwise the
  // ai-sdk falls through to the AWS default credential provider chain
  // (IAM instance/pod role, SSO, shared config) — which is how production
  // deployments are expected to authenticate.
  if (hasAccessKey && hasSecretKey) {
    return {
      region: config.AWS_REGION,
      accessKeyId: config.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY as string,
    };
  }
  return { region: config.AWS_REGION };
}

async function runDescribe(
  bedrock: AmazonBedrockProvider,
  modelId: string,
  input: ProviderCallInput,
): Promise<ProviderCallResult> {
  const result = await generateText({
    model: bedrock(modelId),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.prompt ?? DEFAULT_DESCRIBE_PROMPT },
          { type: 'image', image: input.bytes, mediaType: input.mime },
        ],
      },
    ],
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });
  return { output: result.text, usage: mapUsage(result.usage), model: modelId };
}

async function runOcr(
  bedrock: AmazonBedrockProvider,
  modelId: string,
  input: ProviderCallInput,
): Promise<ProviderCallResult> {
  const result = await generateText({
    model: bedrock(modelId),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildOcrPrompt(input.languages) },
          { type: 'image', image: input.bytes, mediaType: input.mime },
        ],
      },
    ],
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });
  return { output: result.text, usage: mapUsage(result.usage), model: modelId };
}

async function runExtract(
  bedrock: AmazonBedrockProvider,
  modelId: string,
  input: ProviderCallInput,
): Promise<ProviderCallResult> {
  if (input.schema === undefined) {
    throw new ValidationError('extract requires a schema on the bedrock provider', {
      details: { provider: 'bedrock', missing: 'schema' },
    });
  }
  const result = await generateObject({
    model: bedrock(modelId),
    schema: jsonSchema(input.schema as JSONSchema7),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              input.prompt ??
              'Extract structured data from this image that satisfies the provided JSON schema.',
          },
          { type: 'image', image: input.bytes, mediaType: input.mime },
        ],
      },
    ],
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });
  return { output: result.object, usage: mapUsage(result.usage), model: modelId };
}

/**
 * Builder registered with the R06a factory under the name `bedrock`. Throws
 * `ValidationError` synchronously when required config is missing so R13
 * bootstrap (not a hot request) surfaces misconfig.
 */
export const createBedrockProvider: ProviderBuilder = (config): Provider => {
  const settings = buildSettings(config);
  const bedrock = createAmazonBedrock(settings);
  const modelId = config.DEFAULT_MODEL ?? DEFAULT_BEDROCK_MODEL_ID;

  return {
    describe: (input) => runDescribe(bedrock, modelId, input),
    ocr: (input) => runOcr(bedrock, modelId, input),
    extract: (input) => runExtract(bedrock, modelId, input),
  };
};

registerProvider('bedrock', createBedrockProvider);
