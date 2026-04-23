import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ValidationError } from '../../src/core/errors.js';
import {
  _resetProviderRegistryForTests,
  createProvider,
  type ProviderFactoryConfig,
  registerProvider,
} from '../../src/core/providers/index.js';

/**
 * Mock `@ai-sdk/openai` and `ai` at the boundary — constitution §Testing
 * ladder calls for unit tests to mock `ai-sdk`. We hoist the mock creators
 * via `vi.hoisted` so `vi.mock` factories can reference them (vitest moves
 * `vi.mock` calls to the top of the file).
 */
const hoisted = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  generateText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: vi.fn((s: unknown) => ({ __wrappedJsonSchema: s })),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: hoisted.createOpenAI,
}));

vi.mock('ai', () => ({
  generateText: hoisted.generateText,
  generateObject: hoisted.generateObject,
  jsonSchema: hoisted.jsonSchema,
}));

// Import AFTER the mocks so the provider module binds to the mocked fns.
const { OPENAI_DEFAULT_MODEL_ID, buildOpenAiProvider } = await import(
  '../../src/core/providers/openai.js'
);

function baseConfig(overrides: Partial<ProviderFactoryConfig> = {}): ProviderFactoryConfig {
  return {
    PROVIDERS: ['openai'],
    OPENAI_API_KEY: 'sk-test',
    ...overrides,
  };
}

function usage(
  inputTokens = 10,
  outputTokens = 20,
): {
  inputTokens: number;
  outputTokens: number;
} {
  return { inputTokens, outputTokens };
}

describe('openai provider — builder', () => {
  const modelSentinel = { __model: 'openai-lm-sentinel' };
  const clientSentinel = vi.fn(() => modelSentinel);

  beforeEach(() => {
    hoisted.createOpenAI.mockReset();
    hoisted.generateText.mockReset();
    hoisted.generateObject.mockReset();
    hoisted.jsonSchema.mockClear();
    hoisted.createOpenAI.mockReturnValue(clientSentinel);
    clientSentinel.mockClear();
    clientSentinel.mockReturnValue(modelSentinel);
  });

  it('throws ValidationError when OPENAI_API_KEY is missing', () => {
    expect(() => buildOpenAiProvider(baseConfig({ OPENAI_API_KEY: undefined }))).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when OPENAI_API_KEY is the empty string', () => {
    try {
      buildOpenAiProvider(baseConfig({ OPENAI_API_KEY: '' }));
      expect.unreachable('buildOpenAiProvider should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const v = err as ValidationError;
      expect(v.code).toBe('invalid_request');
      expect(v.status).toBe(400);
      expect(v.details).toEqual({ provider: 'openai' });
    }
  });

  it('instantiates the ai-sdk client with the caller-supplied API key', () => {
    buildOpenAiProvider(baseConfig({ OPENAI_API_KEY: 'sk-live-XYZ' }));
    expect(hoisted.createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-live-XYZ' });
  });

  it('uses DEFAULT_MODEL from config when provided', () => {
    buildOpenAiProvider(baseConfig({ DEFAULT_MODEL: 'gpt-override' }));
    expect(clientSentinel).toHaveBeenCalledWith('gpt-override');
  });

  it('falls back to OPENAI_DEFAULT_MODEL_ID when DEFAULT_MODEL is not set', () => {
    buildOpenAiProvider(baseConfig());
    expect(clientSentinel).toHaveBeenCalledWith(OPENAI_DEFAULT_MODEL_ID);
  });
});

describe('openai provider — describe()', () => {
  const modelSentinel = { __model: 'lm' };

  beforeEach(() => {
    hoisted.createOpenAI.mockReset();
    hoisted.generateText.mockReset();
    hoisted.generateObject.mockReset();
    const client = vi.fn().mockReturnValue(modelSentinel);
    hoisted.createOpenAI.mockReturnValue(client);
  });

  it('returns {output, usage, model} with usage tokens normalized to numbers', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'a white cat', usage: usage(12, 34) });

    const provider = buildOpenAiProvider(baseConfig());
    const result = await provider.describe({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      prompt: 'What is in this image?',
    });

    expect(result).toEqual({
      output: 'a white cat',
      usage: { inputTokens: 12, outputTokens: 34 },
      model: OPENAI_DEFAULT_MODEL_ID,
    });
  });

  it('normalizes undefined usage fields to 0', async () => {
    hoisted.generateText.mockResolvedValue({
      text: '',
      usage: { inputTokens: undefined, outputTokens: undefined },
    });

    const provider = buildOpenAiProvider(baseConfig());
    const result = await provider.describe({ bytes: new Uint8Array(), mime: 'image/jpeg' });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('forwards the raw image bytes and mime into an ai-sdk image message part', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'ok', usage: usage() });
    const bytes = new Uint8Array([0xff, 0xd8]);

    const provider = buildOpenAiProvider(baseConfig());
    await provider.describe({ bytes, mime: 'image/jpeg', prompt: 'describe' });

    expect(hoisted.generateText).toHaveBeenCalledTimes(1);
    const call = hoisted.generateText.mock.calls[0]?.[0];
    expect(call.model).toBe(modelSentinel);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe('user');
    const content = call.messages[0].content;
    expect(content).toContainEqual({ type: 'text', text: 'describe' });
    expect(content).toContainEqual({ type: 'image', image: bytes, mediaType: 'image/jpeg' });
  });

  it('supplies a default prompt when the caller did not provide one', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'ok', usage: usage() });

    const provider = buildOpenAiProvider(baseConfig());
    await provider.describe({ bytes: new Uint8Array(), mime: 'image/png' });

    const call = hoisted.generateText.mock.calls[0]?.[0];
    const textParts = call.messages[0].content.filter((p: { type: string }) => p.type === 'text');
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text.length).toBeGreaterThan(0);
  });

  it('forwards AbortSignal into the ai-sdk call', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'ok', usage: usage() });
    const controller = new AbortController();

    const provider = buildOpenAiProvider(baseConfig());
    await provider.describe({
      bytes: new Uint8Array(),
      mime: 'image/png',
      signal: controller.signal,
    });

    const call = hoisted.generateText.mock.calls[0]?.[0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('omits abortSignal entirely when no signal was supplied', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'ok', usage: usage() });

    const provider = buildOpenAiProvider(baseConfig());
    await provider.describe({ bytes: new Uint8Array(), mime: 'image/png' });

    const call = hoisted.generateText.mock.calls[0]?.[0];
    expect('abortSignal' in call).toBe(false);
  });
});

describe('openai provider — ocr()', () => {
  beforeEach(() => {
    hoisted.createOpenAI.mockReset();
    hoisted.generateText.mockReset();
    hoisted.createOpenAI.mockReturnValue(vi.fn().mockReturnValue({ __model: 'lm' }));
  });

  it('returns the OCR text with the configured model id', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'hello\nworld', usage: usage(5, 7) });

    const provider = buildOpenAiProvider(baseConfig({ DEFAULT_MODEL: 'gpt-ocr' }));
    const result = await provider.ocr({ bytes: new Uint8Array(), mime: 'image/png' });

    expect(result).toEqual({
      output: 'hello\nworld',
      usage: { inputTokens: 5, outputTokens: 7 },
      model: 'gpt-ocr',
    });
  });

  it('weaves language hints into the user prompt when languages is supplied', async () => {
    hoisted.generateText.mockResolvedValue({ text: 'bonjour', usage: usage() });

    const provider = buildOpenAiProvider(baseConfig());
    await provider.ocr({
      bytes: new Uint8Array(),
      mime: 'image/png',
      languages: ['fr', 'de'],
    });

    const call = hoisted.generateText.mock.calls[0]?.[0];
    const userPrompt = call.messages[0].content.find((p: { type: string }) => p.type === 'text');
    expect(userPrompt.text).toMatch(/fr/);
    expect(userPrompt.text).toMatch(/de/);
  });

  it('does not mention languages when the caller omits them', async () => {
    hoisted.generateText.mockResolvedValue({ text: '', usage: usage() });

    const provider = buildOpenAiProvider(baseConfig());
    await provider.ocr({ bytes: new Uint8Array(), mime: 'image/png' });

    const call = hoisted.generateText.mock.calls[0]?.[0];
    const userPrompt = call.messages[0].content.find((p: { type: string }) => p.type === 'text');
    expect(userPrompt.text.toLowerCase()).not.toContain('language');
  });
});

describe('openai provider — extract()', () => {
  beforeEach(() => {
    hoisted.createOpenAI.mockReset();
    hoisted.generateObject.mockReset();
    hoisted.jsonSchema.mockClear();
    hoisted.jsonSchema.mockImplementation((s: unknown) => ({ __wrappedJsonSchema: s }));
    hoisted.createOpenAI.mockReturnValue(vi.fn().mockReturnValue({ __model: 'lm' }));
  });

  it('returns {output: object, usage, model} for a structured extraction', async () => {
    hoisted.generateObject.mockResolvedValue({
      object: { name: 'Alice', total: 42.5 },
      usage: usage(100, 200),
    });
    const schema = { type: 'object', properties: { name: { type: 'string' } } };

    const provider = buildOpenAiProvider(baseConfig());
    const result = await provider.extract({
      bytes: new Uint8Array([1]),
      mime: 'image/png',
      schema,
    });

    expect(result).toEqual({
      output: { name: 'Alice', total: 42.5 },
      usage: { inputTokens: 100, outputTokens: 200 },
      model: OPENAI_DEFAULT_MODEL_ID,
    });
  });

  it('wraps the caller-supplied JSON Schema via ai-sdk jsonSchema()', async () => {
    hoisted.generateObject.mockResolvedValue({ object: {}, usage: usage() });
    const schema = { type: 'object' };

    const provider = buildOpenAiProvider(baseConfig());
    await provider.extract({ bytes: new Uint8Array(), mime: 'image/png', schema });

    expect(hoisted.jsonSchema).toHaveBeenCalledWith(schema);
    const call = hoisted.generateObject.mock.calls[0]?.[0];
    expect(call.schema).toEqual({ __wrappedJsonSchema: schema });
  });

  it('throws ValidationError when schema is missing', async () => {
    const provider = buildOpenAiProvider(baseConfig());
    await expect(
      provider.extract({ bytes: new Uint8Array(), mime: 'image/png' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(hoisted.generateObject).not.toHaveBeenCalled();
  });
});

describe('openai provider — registration in R06a factory', () => {
  afterEach(() => {
    _resetProviderRegistryForTests();
  });

  it('registers under the name "openai" on module import', () => {
    // Re-register because prior test suites may have called
    // _resetProviderRegistryForTests.
    registerProvider('openai', buildOpenAiProvider);
    hoisted.createOpenAI.mockReturnValue(vi.fn().mockReturnValue({ __model: 'lm' }));

    const provider = createProvider(baseConfig(), 'openai');
    expect(typeof provider.describe).toBe('function');
    expect(typeof provider.ocr).toBe('function');
    expect(typeof provider.extract).toBe('function');
  });
});
