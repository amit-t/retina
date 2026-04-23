// R07a — unit tests for the Amazon Bedrock provider.
//
// Exercises the narrow R06a-level contract: the builder registers itself
// with the factory, the factory instantiates when `AWS_REGION` is present,
// and missing `AWS_REGION` aborts with a typed `ValidationError` so
// misconfig surfaces at R13 bootstrap. The real `@ai-sdk/amazon-bedrock`
// module is replaced with a `vi.mock` stub so the builder never reaches
// out to AWS (no network, no credential lookups, no process env hit).
// Full describe/ocr/extract behavior against ai-sdk lives in R08/R09/R11.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock calls are hoisted above all imports, so declaring the spies
// inside the factory keeps the mocked module self-contained and avoids
// the "Cannot access X before initialization" ESM TDZ trap.
vi.mock('@ai-sdk/amazon-bedrock', () => {
  const createAmazonBedrock = vi.fn(() => {
    const fn = (_modelId: string) => ({ __stub: 'language-model' });
    return Object.assign(fn, {
      languageModel: fn,
      embedding: fn,
      embeddingModel: fn,
      textEmbedding: fn,
      textEmbeddingModel: fn,
      image: fn,
      imageModel: fn,
      reranking: fn,
      rerankingModel: fn,
      tools: {},
    });
  });
  return { createAmazonBedrock };
});

vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({
    text: 'stub-text',
    usage: { inputTokens: 1, outputTokens: 2 },
  })),
  generateObject: vi.fn(async () => ({
    object: { ok: true },
    usage: { inputTokens: 3, outputTokens: 4 },
  })),
  jsonSchema: vi.fn((s: unknown) => s),
}));

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';
import { ValidationError } from '../../src/core/errors';
// Side-effect import: registers the bedrock builder under 'bedrock' in the
// R06a factory. Importing it once here (before any createProvider call)
// matches the R13 bootstrap order and isolates registry state to this
// vitest worker.
import { DEFAULT_BEDROCK_MODEL_ID } from '../../src/core/providers/bedrock';
import { createProvider, type ProviderFactoryConfig } from '../../src/core/providers/index';

function baseConfig(overrides: Partial<ProviderFactoryConfig> = {}): ProviderFactoryConfig {
  return {
    PROVIDERS: ['bedrock'],
    AWS_REGION: 'us-east-1',
    ...overrides,
  };
}

describe('bedrock provider (R07a)', () => {
  beforeEach(() => {
    vi.mocked(createAmazonBedrock).mockClear();
    vi.mocked(generateText).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers under the name "bedrock" and builds a Provider with all three task methods', () => {
    const provider = createProvider(baseConfig(), 'bedrock');

    expect(typeof provider.describe).toBe('function');
    expect(typeof provider.ocr).toBe('function');
    expect(typeof provider.extract).toBe('function');
  });

  it('instantiates the ai-sdk bedrock client with the configured AWS_REGION', () => {
    createProvider(baseConfig({ AWS_REGION: 'eu-west-1' }), 'bedrock');

    expect(createAmazonBedrock).toHaveBeenCalledTimes(1);
    const settings = vi.mocked(createAmazonBedrock).mock.calls[0]?.[0] as {
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };
    expect(settings.region).toBe('eu-west-1');
    // No explicit keys supplied → builder omits them so the ai-sdk falls
    // through to the AWS default credential provider chain (IAM role).
    expect(settings.accessKeyId).toBeUndefined();
    expect(settings.secretAccessKey).toBeUndefined();
  });

  it('forwards explicit AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY when both are set', () => {
    createProvider(
      baseConfig({
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secretExample',
      }),
      'bedrock',
    );

    const settings = vi.mocked(createAmazonBedrock).mock.calls[0]?.[0] as {
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };
    expect(settings).toEqual({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secretExample',
    });
  });

  it('throws ValidationError when AWS_REGION is missing', () => {
    const cfg: ProviderFactoryConfig = { PROVIDERS: ['bedrock'] };

    expect(() => createProvider(cfg, 'bedrock')).toThrow(ValidationError);
    expect(createAmazonBedrock).not.toHaveBeenCalled();
  });

  it('ValidationError from missing AWS_REGION carries invalid_request / 400 / diagnostic details', () => {
    const cfg: ProviderFactoryConfig = { PROVIDERS: ['bedrock'] };

    try {
      createProvider(cfg, 'bedrock');
      expect.unreachable('bedrock builder should have thrown on missing AWS_REGION');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const retina = err as ValidationError;
      expect(retina.code).toBe('invalid_request');
      expect(retina.status).toBe(400);
      expect(retina.message).toMatch(/AWS_REGION/);
      expect(retina.details).toEqual({ provider: 'bedrock', missing: 'AWS_REGION' });
    }
  });

  it('throws ValidationError when only one of AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY is set', () => {
    expect(() =>
      createProvider(baseConfig({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' }), 'bedrock'),
    ).toThrow(ValidationError);
    expect(() =>
      createProvider(baseConfig({ AWS_SECRET_ACCESS_KEY: 'secretExample' }), 'bedrock'),
    ).toThrow(ValidationError);
    expect(createAmazonBedrock).not.toHaveBeenCalled();
  });

  it('uses config.DEFAULT_MODEL when provided; falls back to DEFAULT_BEDROCK_MODEL_ID otherwise', async () => {
    const overridden = createProvider(baseConfig({ DEFAULT_MODEL: 'custom-model-id' }), 'bedrock');
    const out1 = await overridden.describe({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
    });
    expect(out1.model).toBe('custom-model-id');

    const def = createProvider(baseConfig(), 'bedrock');
    const out2 = await def.describe({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/jpeg',
    });
    expect(out2.model).toBe(DEFAULT_BEDROCK_MODEL_ID);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('exports a non-empty DEFAULT_BEDROCK_MODEL_ID constant (spec-open-q)', () => {
    expect(typeof DEFAULT_BEDROCK_MODEL_ID).toBe('string');
    expect(DEFAULT_BEDROCK_MODEL_ID.length).toBeGreaterThan(0);
  });
});
