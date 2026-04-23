import { Buffer } from 'node:buffer';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ImageFetchError,
  ImageTooLargeError,
  UnsupportedMediaTypeError,
} from '../../../src/core/errors';
import { normalize } from '../../../src/core/image';

// Magic-byte prefixes padded with a few bytes of payload so sniff + cap
// assertions behave on realistic-ish buffers.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('abc'),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('abc')]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from('abc')]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('abc'),
]);

const ORIGIN = 'https://img.test';

describe('normalize', () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  describe('URL input', () => {
    it('happy path — fetches image/png, returns bytes + lower-cased mime', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/ok.png', method: 'GET' })
        .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } });

      const result = await normalize({ url: `${ORIGIN}/ok.png` }, { maxBytes: 10_000 });

      expect(result.mime).toBe('image/png');
      expect(Buffer.from(result.bytes).equals(PNG_BYTES)).toBe(true);
    });

    it('happy path — image/jpeg with charset parameter in Content-Type', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/ok.jpg', method: 'GET' })
        .reply(200, JPEG_BYTES, {
          headers: { 'content-type': 'image/jpeg; charset=binary' },
        });

      const result = await normalize({ url: `${ORIGIN}/ok.jpg` }, { maxBytes: 10_000 });

      expect(result.mime).toBe('image/jpeg');
      expect(Buffer.from(result.bytes).equals(JPEG_BYTES)).toBe(true);
    });

    it('fetch timeout → ImageFetchError with reason=timeout', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/slow', method: 'GET' })
        .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } })
        .delay(500);

      const err = await normalize(
        { url: `${ORIGIN}/slow` },
        { maxBytes: 10_000, urlTimeoutMs: 20 },
      ).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ImageFetchError);
      const details = (err as ImageFetchError).details as {
        url: string;
        timeoutMs: number;
        reason: string;
      };
      expect(details.reason).toBe('timeout');
      expect(details.url).toBe(`${ORIGIN}/slow`);
    });

    it('text/html response → UnsupportedMediaTypeError', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/page', method: 'GET' })
        .reply(200, '<html></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });

      const err = await normalize({ url: `${ORIGIN}/page` }, { maxBytes: 10_000 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
      const details = (err as UnsupportedMediaTypeError).details as { contentType: string };
      expect(details.contentType).toMatch(/^text\/html/);
    });

    it('streaming cap aborts early → ImageTooLargeError', async () => {
      const big = Buffer.alloc(5_000);
      PNG_BYTES.copy(big, 0);

      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/big.png', method: 'GET' })
        .reply(200, big, { headers: { 'content-type': 'image/png' } });

      const err = await normalize({ url: `${ORIGIN}/big.png` }, { maxBytes: 500 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ImageTooLargeError);
      const details = (err as ImageTooLargeError).details as {
        maxBytes: number;
        observedBytes: number;
      };
      expect(details.maxBytes).toBe(500);
      expect(details.observedBytes).toBeGreaterThan(500);
    });

    it('upstream 404 → ImageFetchError with status in details', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/missing', method: 'GET' })
        .reply(404, 'not found', { headers: { 'content-type': 'text/plain' } });

      const err = await normalize({ url: `${ORIGIN}/missing` }, { maxBytes: 10_000 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ImageFetchError);
      const details = (err as ImageFetchError).details as { status: number };
      expect(details.status).toBe(404);
    });

    it('upstream 500 → ImageFetchError with status in details', async () => {
      mockAgent
        .get(ORIGIN)
        .intercept({ path: '/boom', method: 'GET' })
        .reply(500, 'oops', { headers: { 'content-type': 'text/plain' } });

      const err = await normalize({ url: `${ORIGIN}/boom` }, { maxBytes: 10_000 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ImageFetchError);
      const details = (err as ImageFetchError).details as { status: number };
      expect(details.status).toBe(500);
    });
  });

  describe('base64 input', () => {
    it('happy path — PNG magic matches declared mime', async () => {
      const result = await normalize(
        { base64: PNG_BYTES.toString('base64'), mime: 'image/png' },
        { maxBytes: 10_000 },
      );
      expect(result.mime).toBe('image/png');
      expect(Buffer.from(result.bytes).equals(PNG_BYTES)).toBe(true);
    });

    it('happy path — WEBP magic matches declared mime', async () => {
      const result = await normalize(
        { base64: WEBP_BYTES.toString('base64'), mime: 'image/webp' },
        { maxBytes: 10_000 },
      );
      expect(result.mime).toBe('image/webp');
    });

    it('happy path — GIF magic matches declared mime', async () => {
      const result = await normalize(
        { base64: GIF_BYTES.toString('base64'), mime: 'image/gif' },
        { maxBytes: 10_000 },
      );
      expect(result.mime).toBe('image/gif');
    });

    it('mime mismatch (declared png, bytes are jpeg) → UnsupportedMediaTypeError', async () => {
      const err = await normalize(
        { base64: JPEG_BYTES.toString('base64'), mime: 'image/png' },
        { maxBytes: 10_000 },
      ).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
      const details = (err as UnsupportedMediaTypeError).details as {
        declaredMime: string;
        sniffedMime: string | null;
      };
      expect(details.declaredMime).toBe('image/png');
      expect(details.sniffedMime).toBe('image/jpeg');
    });

    it('unrecognized magic bytes → UnsupportedMediaTypeError with sniffedMime=null', async () => {
      const err = await normalize(
        { base64: Buffer.from('not an image at all').toString('base64'), mime: 'image/png' },
        { maxBytes: 10_000 },
      ).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
      const details = (err as UnsupportedMediaTypeError).details as {
        sniffedMime: string | null;
      };
      expect(details.sniffedMime).toBeNull();
    });

    it('base64 over cap → ImageTooLargeError', async () => {
      const big = Buffer.alloc(2_000);
      PNG_BYTES.copy(big, 0);
      await expect(
        normalize({ base64: big.toString('base64'), mime: 'image/png' }, { maxBytes: 500 }),
      ).rejects.toBeInstanceOf(ImageTooLargeError);
    });
  });

  describe('multipart (pre-decoded bytes) input', () => {
    it('happy path — passes bytes and mime through when within cap', async () => {
      const bytes = new Uint8Array(Buffer.from('whatever raw bytes'));
      const result = await normalize({ bytes, mime: 'image/png' }, { maxBytes: 10_000 });
      expect(result.mime).toBe('image/png');
      expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true);
    });

    it('too large → ImageTooLargeError', async () => {
      const bytes = new Uint8Array(2_000);
      const err = await normalize({ bytes, mime: 'image/png' }, { maxBytes: 500 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ImageTooLargeError);
      const details = (err as ImageTooLargeError).details as {
        maxBytes: number;
        observedBytes: number;
      };
      expect(details.maxBytes).toBe(500);
      expect(details.observedBytes).toBe(2_000);
    });
  });
});
