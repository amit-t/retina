import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
// Side-effect of importing `google.js`: registers the "google" builder on
// the R06a factory, so `createProvider(..., 'google')` resolves below.
import { DEFAULT_GOOGLE_MODEL } from '../../src/core/providers/google.js';
import { createProvider, type ProviderFactoryConfig } from '../../src/core/providers/index.js';

/**
 * Mock the `ai` module at the module boundary so the provider never attempts
 * a real network call. The mocked `generateText` / `generateObject` return the
 * shapes task runners (R08/R09/R11) will consume; the provider's own job is
 * to stitch them into `ProviderCallResult`.
 */
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(async (_args: unknown) => ({
      text: 'mock-description',
      totalUsage: { inputTokens: 11, outputTokens: 22 },
    })),
    generateObject: vi.fn(async (_args: unknown) => ({
      object: { vendor: 'Acme', total: 42 },
      usage: { inputTokens: 33, outputTokens: 44 },
    })),
  };
});

/**
 * Mock `@ai-sdk/google` so `createGoogleGenerativeAI` returns a callable
 * stub that records the API key it was handed and produces a placeholder
 * `LanguageModel` for `generateText` / `generateObject` to receive.
 */
const createGoogleGenerativeAIMock = vi.fn((_opts: { apiKey?: string }) => {
  const languageModel = { __tag: 'mock-google-language-model' };
  return Object.assign(() => languageModel, { languageModel: () => languageModel });
});

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: (opts: { apiKey?: string }) => createGoogleGenerativeAIMock(opts),
}));

function baseConfig(overrides: Partial<ProviderFactoryConfig> = {}): ProviderFactoryConfig {
  return {
    PROVIDERS: ['google'],
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key',
    ...overrides,
  };
}

describe('google provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('factory', () => {
    it('registers itself under "google" and the R06a factory instantiates it', () => {
      const provider = createProvider(baseConfig(), 'google');
      expect(provider).toBeDefined();
      expect(typeof provider.describe).toBe('function');
      expect(typeof provider.ocr).toBe('function');
      expect(typeof provider.extract).toBe('function');
    });

    it('forwards the API key into createGoogleGenerativeAI', () => {
      createProvider(baseConfig({ GOOGLE_GENERATIVE_AI_API_KEY: 'sk-google-xyz' }), 'google');
      expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: 'sk-google-xyz' });
    });

    it('throws ValidationError when GOOGLE_GENERATIVE_AI_API_KEY is missing', () => {
      const cfg: ProviderFactoryConfig = { PROVIDERS: ['google'] };
      expect(() => createProvider(cfg, 'google')).toThrow(ValidationError);
    });

    it('throws ValidationError when GOOGLE_GENERATIVE_AI_API_KEY is an empty string', () => {
      expect(() =>
        createProvider(baseConfig({ GOOGLE_GENERATIVE_AI_API_KEY: '' }), 'google'),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError when GOOGLE_GENERATIVE_AI_API_KEY is whitespace only', () => {
      expect(() =>
        createProvider(baseConfig({ GOOGLE_GENERATIVE_AI_API_KEY: '   ' }), 'google'),
      ).toThrow(ValidationError);
    });

    it('missing-key ValidationError mentions the env var so ops can act on it', () => {
      try {
        createProvider({ PROVIDERS: ['google'] }, 'google');
        expect.unreachable('expected ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
      }
    });
  });

  describe('DEFAULT_GOOGLE_MODEL constant', () => {
    it('exports a non-empty default model id', () => {
      expect(typeof DEFAULT_GOOGLE_MODEL).toBe('string');
      expect(DEFAULT_GOOGLE_MODEL.length).toBeGreaterThan(0);
    });
  });

  describe('describe()', () => {
    it('returns {output, usage, model} shaped result with the default model', async () => {
      const provider = createProvider(baseConfig(), 'google');
      const res = await provider.describe({
        bytes: new Uint8Array([0xff, 0xd8]),
        mime: 'image/jpeg',
        prompt: 'what is this?',
      });

      expect(res.output).toBe('mock-description');
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
      expect(typeof res.model).toBe('string');
      expect(res.model.length).toBeGreaterThan(0);
    });

    it('uses config.DEFAULT_MODEL when set (overrides DEFAULT_GOOGLE_MODEL)', async () => {
      const provider = createProvider(
        baseConfig({ DEFAULT_MODEL: 'gemini-override-model' }),
        'google',
      );
      const res = await provider.describe({
        bytes: new Uint8Array(),
        mime: 'image/png',
      });
      expect(res.model).toBe('gemini-override-model');
    });
  });

  describe('ocr()', () => {
    it('returns generateText output shaped as a ProviderCallResult', async () => {
      const provider = createProvider(baseConfig(), 'google');
      const res = await provider.ocr({
        bytes: new Uint8Array([0x89, 0x50]),
        mime: 'image/png',
        languages: ['en', 'fr'],
      });
      expect(res.output).toBe('mock-description');
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    });
  });

  describe('extract()', () => {
    it('returns generateObject output with usage', async () => {
      const provider = createProvider(baseConfig(), 'google');
      const res = await provider.extract({
        bytes: new Uint8Array(),
        mime: 'image/png',
        schema: { type: 'object', properties: { total: { type: 'number' } } },
      });
      expect(res.output).toEqual({ vendor: 'Acme', total: 42 });
      expect(res.usage).toEqual({ inputTokens: 33, outputTokens: 44 });
    });

    it('throws ValidationError when schema is omitted', async () => {
      const provider = createProvider(baseConfig(), 'google');
      await expect(
        provider.extract({ bytes: new Uint8Array(), mime: 'image/png' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('usage coercion', () => {
    it('undefined token counts from ai-sdk coerce to zero', async () => {
      const aiMod = await import('ai');
      vi.mocked(aiMod.generateText).mockResolvedValueOnce({
        text: 'hello',
        totalUsage: { inputTokens: undefined, outputTokens: undefined },
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock, full shape unneeded
      } as any);

      const provider = createProvider(baseConfig(), 'google');
      const res = await provider.describe({ bytes: new Uint8Array(), mime: 'image/png' });
      expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });
});
