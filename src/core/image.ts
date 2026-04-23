/**
 * Image normalization.
 *
 * `normalize(input, opts)` takes one of three input shapes and returns a
 * validated `{bytes, mime}` pair ready to hand to a provider:
 *
 * 1. `{url}`              — fetched over HTTP via `undici` with a hard
 *                           `AbortSignal.timeout(opts.urlTimeoutMs ?? 10_000)`.
 *                           Body is streamed chunk-by-chunk and the reader is
 *                           cancelled the moment cumulative bytes exceed
 *                           `opts.maxBytes`. Content-Type must start with
 *                           `image/`.
 * 2. `{base64, mime}`     — decoded to bytes; magic-byte sniff must agree
 *                           with the declared `mime`.
 * 3. `{bytes, mime}`      — already-decoded (e.g. multipart form); only the
 *                           size cap is enforced.
 *
 * Errors all subclass `RetinaError` so the HTTP error middleware (R02e)
 * maps them to the shared envelope:
 *
 *   - `ImageFetchError`          — URL 4xx/5xx, network failure, timeout.
 *   - `ImageTooLargeError`       — decoded size > `opts.maxBytes`.
 *   - `UnsupportedMediaTypeError` — non-`image/*` Content-Type or base64
 *                                   mime mismatch.
 */

import { Buffer } from 'node:buffer';
import { fetch } from 'undici';
import { ImageFetchError, ImageTooLargeError, UnsupportedMediaTypeError } from './errors';

/** Image mime subtypes Retina accepts on base64 input. */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Input variants handled by {@link normalize}.
 *
 * Keep in sync with `ImageInput` in `src/http/schemas.ts` once R04 lands;
 * both should accept the same shapes at the API boundary.
 */
export type NormalizeInput =
  | { url: string }
  | { base64: string; mime: ImageMime }
  | { bytes: Uint8Array; mime: string };

export interface NormalizeOptions {
  /** Hard cap on byte length; larger inputs throw `ImageTooLargeError`. */
  maxBytes: number;
  /** Timeout for the URL fetch path. Defaults to 10_000 ms per spec. */
  urlTimeoutMs?: number;
}

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: string;
}

const DEFAULT_URL_TIMEOUT_MS = 10_000;

const MAGIC_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const MAGIC_GIF87 = Buffer.from('GIF87a', 'ascii');
const MAGIC_GIF89 = Buffer.from('GIF89a', 'ascii');
const MAGIC_RIFF = Buffer.from('RIFF', 'ascii');
const MAGIC_WEBP = Buffer.from('WEBP', 'ascii');

export async function normalize(
  input: NormalizeInput,
  opts: NormalizeOptions,
): Promise<NormalizedImage> {
  if ('url' in input) return fromUrl(input.url, opts);
  if ('base64' in input) return fromBase64(input.base64, input.mime, opts);
  return fromBytes(input.bytes, input.mime, opts);
}

async function fromUrl(url: string, opts: NormalizeOptions): Promise<NormalizedImage> {
  const timeoutMs = opts.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    throw new ImageFetchError(
      isTimeoutError(cause) ? 'Image fetch timed out' : 'Image fetch failed',
      {
        cause,
        details: {
          url,
          timeoutMs,
          reason: isTimeoutError(cause) ? 'timeout' : 'network',
        },
      },
    );
  }

  if (!response.ok) {
    await drain(response);
    throw new ImageFetchError(`Image fetch returned ${response.status}`, {
      details: { url, status: response.status },
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    await drain(response);
    throw new UnsupportedMediaTypeError('Response Content-Type is not image/*', {
      details: { url, contentType },
    });
  }

  if (response.body === null) {
    throw new ImageFetchError('Image response had no body', { details: { url } });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        // Fire-and-forget cancel so the socket is released promptly; we
        // then throw synchronously. Any cancel rejection is ignored — we
        // care about surfacing the size cap, not the cancel outcome.
        void reader.cancel().catch(() => undefined);
        throw new ImageTooLargeError('Image body exceeds maxBytes', {
          details: { url, maxBytes: opts.maxBytes, observedBytes: total },
        });
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ImageTooLargeError) throw err;
    if (isTimeoutError(err)) {
      throw new ImageFetchError('Image fetch timed out', {
        cause: err,
        details: { url, timeoutMs, reason: 'timeout' },
      });
    }
    throw new ImageFetchError('Image body stream failed', {
      cause: err,
      details: { url },
    });
  }

  return {
    bytes: concatChunks(chunks, total),
    mime: parseMimeFromContentType(contentType),
  };
}

function fromBase64(base64: string, mime: ImageMime, opts: NormalizeOptions): NormalizedImage {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength > opts.maxBytes) {
    throw new ImageTooLargeError('Base64 image exceeds maxBytes', {
      details: { maxBytes: opts.maxBytes, observedBytes: bytes.byteLength },
    });
  }
  const sniffed = sniffMime(bytes);
  if (sniffed === null || sniffed !== mime) {
    throw new UnsupportedMediaTypeError('Declared mime does not match sniffed image magic bytes', {
      details: { declaredMime: mime, sniffedMime: sniffed },
    });
  }
  return { bytes, mime };
}

function fromBytes(bytes: Uint8Array, mime: string, opts: NormalizeOptions): NormalizedImage {
  if (bytes.byteLength > opts.maxBytes) {
    throw new ImageTooLargeError('Image bytes exceed maxBytes', {
      details: { maxBytes: opts.maxBytes, observedBytes: bytes.byteLength },
    });
  }
  return { bytes, mime };
}

function decodeBase64(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  // Detach from Node's shared Buffer pool so the returned view's byteLength
  // equals the decoded length exactly.
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function sniffMime(bytes: Uint8Array): ImageMime | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= MAGIC_PNG.length && buf.subarray(0, MAGIC_PNG.length).equals(MAGIC_PNG)) {
    return 'image/png';
  }
  if (buf.length >= MAGIC_JPEG.length && buf.subarray(0, MAGIC_JPEG.length).equals(MAGIC_JPEG)) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 6 &&
    (buf.subarray(0, 6).equals(MAGIC_GIF87) || buf.subarray(0, 6).equals(MAGIC_GIF89))
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(MAGIC_RIFF) &&
    buf.subarray(8, 12).equals(MAGIC_WEBP)
  ) {
    return 'image/webp';
  }
  return null;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseMimeFromContentType(contentType: string): string {
  const semi = contentType.indexOf(';');
  const raw = semi === -1 ? contentType : contentType.slice(0, semi);
  return raw.trim().toLowerCase();
}

async function drain(response: Awaited<ReturnType<typeof fetch>>): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Ignore — we're discarding the body, cancel errors don't matter.
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}
