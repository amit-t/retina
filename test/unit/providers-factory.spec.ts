import { afterEach, describe, expect, it } from 'vitest';
import { RetinaError, ValidationError } from '../../src/core/errors.js';
import {
  _resetProviderRegistryForTests,
  createProvider,
  PROVIDERS,
  type Provider,
  type ProviderFactoryConfig,
  registerProvider,
} from '../../src/core/providers/index.js';

/**
 * Minimal config fixture — the R06a factory accepts any structural
 * `ProviderFactoryConfig`; concrete providers (R06b/R07*) narrow the fields
 * they actually read.
 */
function baseConfig(overrides: Partial<ProviderFactoryConfig> = {}): ProviderFactoryConfig {
  return {
    PROVIDERS: ['openai'],
    ...overrides,
  };
}

/** Inert `Provider` double that records how it was built. */
function stubProvider(model = 'stub-model'): Provider {
  return {
    describe: async () => ({
      output: 'stub-describe',
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
    }),
    ocr: async () => ({ output: 'stub-ocr', usage: { inputTokens: 0, outputTokens: 0 }, model }),
    extract: async () => ({ output: {}, usage: { inputTokens: 0, outputTokens: 0 }, model }),
  };
}

describe('createProvider', () => {
  afterEach(() => {
    _resetProviderRegistryForTests();
  });

  it('throws ValidationError for an unknown provider name', () => {
    expect(() => createProvider(baseConfig(), 'not-a-provider')).toThrow(ValidationError);
  });

  it('ValidationError carries invalid_request code and 400 status', () => {
    try {
      createProvider(baseConfig(), 'not-a-provider');
      expect.unreachable('createProvider should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(RetinaError);
      const retina = err as ValidationError;
      expect(retina.code).toBe('invalid_request');
      expect(retina.status).toBe(400);
      expect(retina.message).toContain('not-a-provider');
    }
  });

  it('ValidationError details include the offending name and the registered supported list', () => {
    registerProvider('openai', () => stubProvider('gpt-stub'));

    try {
      createProvider(baseConfig(), 'bedrock');
      expect.unreachable('createProvider should have thrown');
    } catch (err) {
      const retina = err as ValidationError;
      expect(retina.details).toEqual({ name: 'bedrock', supported: ['openai'] });
    }
  });

  it('rejects every PROVIDERS value when the registry is empty (initial R06a state)', () => {
    // R06a ships with no concrete providers registered — R06b/R07* add them.
    for (const name of PROVIDERS) {
      expect(() => createProvider(baseConfig(), name)).toThrow(ValidationError);
    }
  });

  it('returns the builder-produced Provider once the name has been registered', () => {
    const built = stubProvider('gpt-stub');
    registerProvider('openai', () => built);

    const got = createProvider(baseConfig(), 'openai');

    expect(got).toBe(built);
  });

  it('passes the caller-supplied config through to the registered builder', () => {
    const seen: ProviderFactoryConfig[] = [];
    registerProvider('anthropic', (cfg) => {
      seen.push(cfg);
      return stubProvider();
    });

    const cfg = baseConfig({ ANTHROPIC_API_KEY: 'sk-ant-xxx', PROVIDERS: ['anthropic'] });
    createProvider(cfg, 'anthropic');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(cfg);
  });

  it('re-registering the same name replaces the previous builder', () => {
    const first = stubProvider('first');
    const second = stubProvider('second');
    registerProvider('google', () => first);
    registerProvider('google', () => second);

    expect(createProvider(baseConfig(), 'google')).toBe(second);
  });

  it('_resetProviderRegistryForTests clears previously-registered builders', () => {
    registerProvider('openai', () => stubProvider());
    _resetProviderRegistryForTests();

    expect(() => createProvider(baseConfig(), 'openai')).toThrow(ValidationError);
  });
});

describe('PROVIDERS constant', () => {
  it('lists the four provider names from spec §Configuration', () => {
    expect([...PROVIDERS]).toEqual(['bedrock', 'openai', 'anthropic', 'google']);
  });
});
