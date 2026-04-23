import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RetinaError, ValidationError } from '../../src/core/errors.js';
import {
  buildAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
} from '../../src/core/providers/anthropic.js';
import {
  _resetProviderRegistryForTests,
  createProvider,
  type ProviderFactoryConfig,
  registerProvider,
} from '../../src/core/providers/index.js';

/**
 * These unit tests exercise ONLY the R07b scope:
 *   1. `buildAnthropicProvider(config)` instantiates a `Provider` when
 *      `ANTHROPIC_API_KEY` is set on the config.
 *   2. Missing `ANTHROPIC_API_KEY` yields `ValidationError` (bootstrap
 *      surfaces misconfig, per spec §Error handling).
 *   3. Importing `anthropic.ts` has a side-effect that registers the
 *      builder under the name `"anthropic"` with the R06a factory, so
 *      `createProvider(config, 'anthropic')` succeeds.
 *   4. The exported `DEFAULT_ANTHROPIC_MODEL` is a non-empty string so
 *      callers (and the `ProviderRouter` retry trail) always have a
 *      concrete model id to report.
 *
 * The describe/ocr/extract method bodies delegate to `@ai-sdk/anthropic` +
 * `ai` and are exercised end-to-end by the R19 replay layer against
 * recorded HTTP fixtures — keeping them out of this unit file avoids
 * coupling R07b to the ai-sdk surface area that R06b/R07* haven't locked
 * down yet.
 */

function configWithKey(overrides: Partial<ProviderFactoryConfig> = {}): ProviderFactoryConfig {
  return {
    PROVIDERS: ['anthropic'],
    ANTHROPIC_API_KEY: 'sk-ant-unit-test',
    ...overrides,
  };
}

function configWithoutKey(): ProviderFactoryConfig {
  // Omit `ANTHROPIC_API_KEY` entirely so `exactOptionalPropertyTypes`
  // accepts the shape and `config.ANTHROPIC_API_KEY` is genuinely absent.
  return { PROVIDERS: ['anthropic'] };
}

describe('buildAnthropicProvider', () => {
  it('instantiates a Provider when ANTHROPIC_API_KEY is set', () => {
    const provider = buildAnthropicProvider(configWithKey());

    expect(typeof provider.describe).toBe('function');
    expect(typeof provider.ocr).toBe('function');
    expect(typeof provider.extract).toBe('function');
  });

  it('throws ValidationError when ANTHROPIC_API_KEY is missing', () => {
    expect(() => buildAnthropicProvider(configWithoutKey())).toThrow(ValidationError);
  });

  it('carries invalid_request code + 400 status + provider name in details', () => {
    try {
      buildAnthropicProvider(configWithoutKey());
      expect.unreachable('buildAnthropicProvider should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(RetinaError);
      const retina = err as ValidationError;
      expect(retina.code).toBe('invalid_request');
      expect(retina.status).toBe(400);
      expect(retina.message).toMatch(/ANTHROPIC_API_KEY/i);
      expect(retina.details).toEqual({ provider: 'anthropic' });
    }
  });

  it('rejects an empty-string ANTHROPIC_API_KEY the same as a missing one', () => {
    expect(() => buildAnthropicProvider(configWithKey({ ANTHROPIC_API_KEY: '' }))).toThrow(
      ValidationError,
    );
  });
});

describe('anthropic provider registration', () => {
  // The registry is process-global. Snapshot + restore around each test so
  // registration-ordering assertions don't leak into sibling specs.
  beforeEach(() => {
    _resetProviderRegistryForTests();
    registerProvider('anthropic', buildAnthropicProvider);
  });

  afterEach(() => {
    _resetProviderRegistryForTests();
  });

  it('createProvider(config, "anthropic") resolves via the registered builder', () => {
    const provider = createProvider(configWithKey(), 'anthropic');

    expect(typeof provider.describe).toBe('function');
    expect(typeof provider.ocr).toBe('function');
    expect(typeof provider.extract).toBe('function');
  });

  it('createProvider surfaces the missing-key ValidationError unchanged', () => {
    expect(() => createProvider(configWithoutKey(), 'anthropic')).toThrow(ValidationError);
  });
});

describe('DEFAULT_ANTHROPIC_MODEL', () => {
  it('is a non-empty string so router attempt trails always have a model id', () => {
    expect(typeof DEFAULT_ANTHROPIC_MODEL).toBe('string');
    expect(DEFAULT_ANTHROPIC_MODEL.length).toBeGreaterThan(0);
  });

  it('is a claude-* SKU (guards against accidentally wiring a non-Anthropic id)', () => {
    expect(DEFAULT_ANTHROPIC_MODEL.toLowerCase()).toMatch(/^claude[-_]/);
  });
});
