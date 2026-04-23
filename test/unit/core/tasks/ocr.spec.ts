// Unit tests for the `runOcr` task runner and `buildOcrPrompt` helper.
//
// These tests cover the task layer in isolation with a stub `TaskRouter`.
// HTTP-level behaviour (validation, normalize, 413) is covered by
// `test/unit/http/routes/ocr.spec.ts`.

import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallInput, ProviderUsage } from '../../../../src/core/providers/index.js';
import {
  buildOcrPrompt,
  type OcrResult,
  runOcr,
  type TaskRouter,
  type TaskRouterCallOptions,
} from '../../../../src/core/tasks/ocr.js';

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const USAGE: ProviderUsage = { inputTokens: 42, outputTokens: 17 };

type Call = {
  task: 'describe' | 'ocr' | 'extract';
  input: ProviderCallInput;
  opts: TaskRouterCallOptions;
};

function makeRouter(
  output: unknown,
  meta: { provider?: string; model?: string; usage?: ProviderUsage } = {},
): { router: TaskRouter; calls: Call[] } {
  const calls: Call[] = [];
  const router: TaskRouter = {
    call: vi.fn(async (task, input, opts) => {
      calls.push({ task, input, opts });
      return {
        output,
        usage: meta.usage ?? USAGE,
        provider: meta.provider ?? 'openai',
        model: meta.model ?? 'gpt-vision-stub',
      };
    }),
  };
  return { router, calls };
}

describe('buildOcrPrompt', () => {
  it('returns the base prompt when no languages are provided', () => {
    const prompt = buildOcrPrompt();
    expect(prompt).toMatch(/extract all legible text/i);
    expect(prompt).not.toMatch(/language/i);
  });

  it('returns the base prompt when languages is an empty array', () => {
    const prompt = buildOcrPrompt([]);
    expect(prompt).not.toMatch(/language/i);
  });

  it('appends the language list verbatim when provided', () => {
    const prompt = buildOcrPrompt(['en', 'fr']);
    expect(prompt).toMatch(/extract all legible text/i);
    expect(prompt).toMatch(/en, fr/);
  });
});

describe('runOcr', () => {
  it('happy path — returns text + single block + provider metadata from the router', async () => {
    const { router, calls } = makeRouter('Hello, world.', {
      provider: 'bedrock',
      model: 'claude-3',
    });

    const result: OcrResult = await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
    });

    expect(result).toEqual({
      text: 'Hello, world.',
      blocks: [{ text: 'Hello, world.', bbox: null }],
      provider: 'bedrock',
      model: 'claude-3',
      usage: USAGE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe('ocr');
    expect(calls[0]?.input.bytes).toBe(IMAGE_BYTES);
    expect(calls[0]?.input.mime).toBe('image/png');
  });

  it('forwards `languages` hint into both the prompt and the provider input', async () => {
    const { router, calls } = makeRouter('bonjour');

    await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
      languages: ['fr', 'en'],
    });

    expect(calls).toHaveLength(1);
    const input = calls[0]?.input;
    expect(input?.languages).toEqual(['fr', 'en']);
    expect(input?.prompt).toMatch(/fr, en/);
  });

  it('forwards ProviderOptions (provider/model/fallback/retries) to router opts (replace semantics)', async () => {
    const { router, calls } = makeRouter('hi');

    await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/jpeg',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      fallback: ['openai', 'google'],
      retries: 0,
    });

    expect(calls[0]?.opts).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      fallback: ['openai', 'google'],
      retries: 0,
    });
  });

  it('forwards AbortSignal on both the provider input and the router opts', async () => {
    const { router, calls } = makeRouter('txt');
    const controller = new AbortController();

    await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
      signal: controller.signal,
    });

    expect(calls[0]?.input.signal).toBe(controller.signal);
    expect(calls[0]?.opts.signal).toBe(controller.signal);
  });

  it('empty-text handled — returns {text: "", blocks: []} without throwing', async () => {
    const { router } = makeRouter('');

    const result = await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
    });

    expect(result.text).toBe('');
    expect(result.blocks).toEqual([]);
    // Blocks assertion holds even for the empty case (vacuously true).
    expect(result.blocks.every((b) => b.bbox === null)).toBe(true);
  });

  it('non-string provider output is coerced to empty text rather than crashing', async () => {
    const { router } = makeRouter({ unexpected: 'object' });

    const result = await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
    });

    expect(result.text).toBe('');
    expect(result.blocks).toEqual([]);
  });

  it('every returned block has bbox === null (MVP invariant)', async () => {
    const { router } = makeRouter('line one\nline two');

    const result = await runOcr(router, {
      bytes: IMAGE_BYTES,
      mime: 'image/png',
    });

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every((b) => b.bbox === null)).toBe(true);
  });

  it('propagates errors thrown by the router (no local catch/wrap)', async () => {
    const router: TaskRouter = {
      call: vi.fn(async () => {
        throw new Error('provider blew up');
      }),
    };

    await expect(runOcr(router, { bytes: IMAGE_BYTES, mime: 'image/png' })).rejects.toThrow(
      'provider blew up',
    );
  });
});
