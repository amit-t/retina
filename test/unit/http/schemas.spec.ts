import { describe, expect, it } from 'vitest';
import {
  AnalyzeRequest,
  DescribeRequest,
  ExtractRequest,
  IMAGE_MIME_TYPES,
  ImageInput,
  JobsRequest,
  OCRRequest,
  ProviderOptions,
} from '../../../src/http/schemas.js';

const urlImage = { url: 'https://example.com/cat.png' };
const base64Image = {
  base64: 'AAAA',
  mime: 'image/png' as const,
};

describe('ImageInput', () => {
  it('accepts a URL variant', () => {
    expect(ImageInput.parse(urlImage)).toEqual(urlImage);
  });

  it('accepts a base64 + mime variant with every allowed mime', () => {
    for (const mime of IMAGE_MIME_TYPES) {
      const parsed = ImageInput.parse({ base64: 'AAAA', mime });
      expect(parsed).toEqual({ base64: 'AAAA', mime });
    }
  });

  it('rejects base64 payloads with a non-image mime', () => {
    const res = ImageInput.safeParse({ base64: 'AAAA', mime: 'image/bmp' });
    expect(res.success).toBe(false);
  });

  it('rejects payloads that are neither a valid URL nor a valid base64 blob', () => {
    const res = ImageInput.safeParse({ url: 'not-a-url' });
    expect(res.success).toBe(false);
  });
});

describe('ProviderOptions', () => {
  it('accepts every field empty', () => {
    expect(ProviderOptions.parse({})).toEqual({});
  });

  it('accepts fully-populated options', () => {
    const input = {
      provider: 'openai',
      model: 'gpt-x',
      fallback: ['anthropic', 'bedrock'],
      retries: 2,
    };
    expect(ProviderOptions.parse(input)).toEqual(input);
  });

  it('rejects negative retries', () => {
    const res = ProviderOptions.safeParse({ retries: -1 });
    expect(res.success).toBe(false);
  });
});

describe('DescribeRequest', () => {
  it('accepts a valid body with provider options', () => {
    const body = {
      image: urlImage,
      prompt: 'Describe this image',
      maxTokens: 256,
      provider: 'openai',
      retries: 1,
    };
    expect(DescribeRequest.parse(body)).toEqual(body);
  });

  it('rejects a body missing `image`', () => {
    const res = DescribeRequest.safeParse({ prompt: 'hi' });
    expect(res.success).toBe(false);
  });
});

describe('OCRRequest', () => {
  it('accepts a valid body with languages', () => {
    const body = { image: base64Image, languages: ['en', 'de'] };
    expect(OCRRequest.parse(body)).toEqual(body);
  });

  it('rejects a non-array `languages` field', () => {
    const res = OCRRequest.safeParse({ image: urlImage, languages: 'en' });
    expect(res.success).toBe(false);
  });
});

describe('ExtractRequest', () => {
  it('accepts the ad-hoc `schema` path', () => {
    const body = {
      image: urlImage,
      schema: { type: 'object', properties: { total: { type: 'number' } } },
    };
    expect(ExtractRequest.parse(body)).toEqual(body);
  });

  it('accepts the `templateId` path', () => {
    const body = { image: urlImage, templateId: 'invoice-v1' };
    expect(ExtractRequest.parse(body)).toEqual(body);
  });

  it('rejects a body with neither `schema` nor `templateId` (XOR floor)', () => {
    const res = ExtractRequest.safeParse({ image: urlImage });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => /schema.*templateId|templateId.*schema/i.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects a body with BOTH `schema` and `templateId` (XOR ceiling)', () => {
    const res = ExtractRequest.safeParse({
      image: urlImage,
      schema: { type: 'object' },
      templateId: 'invoice-v1',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /not both/i.test(i.message))).toBe(true);
    }
  });

  it('rejects a body missing `image`', () => {
    const res = ExtractRequest.safeParse({ templateId: 'invoice-v1' });
    expect(res.success).toBe(false);
  });
});

describe('AnalyzeRequest', () => {
  it('accepts a `describe` task', () => {
    const body = { task: 'describe' as const, image: urlImage, prompt: 'go' };
    expect(AnalyzeRequest.parse(body)).toEqual(body);
  });

  it('accepts an `ocr` task', () => {
    const body = { task: 'ocr' as const, image: urlImage, languages: ['en'] };
    expect(AnalyzeRequest.parse(body)).toEqual(body);
  });

  it('accepts an `extract` task on the templateId path', () => {
    const body = { task: 'extract' as const, image: urlImage, templateId: 'invoice-v1' };
    expect(AnalyzeRequest.parse(body)).toEqual(body);
  });

  it('rejects an unknown `task` literal', () => {
    const res = AnalyzeRequest.safeParse({ task: 'translate', image: urlImage });
    expect(res.success).toBe(false);
  });

  it('enforces the ExtractRequest XOR inside the `extract` branch', () => {
    const res = AnalyzeRequest.safeParse({
      task: 'extract',
      image: urlImage,
      schema: { type: 'object' },
      templateId: 'invoice-v1',
    });
    expect(res.success).toBe(false);
  });
});

describe('JobsRequest', () => {
  it('accepts an analyze-shaped body with `callbackUrl`', () => {
    const body = {
      task: 'describe' as const,
      image: urlImage,
      callbackUrl: 'https://webhook.example/cb',
    };
    expect(JobsRequest.parse(body)).toEqual(body);
  });

  it('rejects a body with a non-URL `callbackUrl`', () => {
    const res = JobsRequest.safeParse({
      task: 'describe',
      image: urlImage,
      callbackUrl: 'not-a-url',
    });
    expect(res.success).toBe(false);
  });
});
