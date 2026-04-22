import type { Context, ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { InternalError, RetinaError } from '../../core/errors';

/**
 * Shape of the error response envelope sent to clients.
 *
 * All non-2xx responses from the API conform to this contract (constitution
 * invariant #6). See docs/superpowers/specs/2026-04-21-retina-image-api-design.md
 * §Error handling.
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Minimal structural type for the logger so this module does not hard-depend
 * on pino (logger wiring lives in R02 sub-item 2 / src/logger.ts). Any pino
 * `Logger` instance satisfies this shape.
 */
export interface ErrorMiddlewareLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ErrorMiddlewareDeps {
  logger: ErrorMiddlewareLogger;
}

const REQUEST_ID_HEADER = 'x-request-id';
const UNKNOWN_REQUEST_ID = 'unknown';

/**
 * Build the single error-mapping layer for the Retina HTTP app.
 *
 * - Thrown `RetinaError` subclasses → JSON envelope
 *   `{error: {code, message, requestId, details?}}` with the error's
 *   `status`.
 * - Anything else is wrapped in `InternalError` (500, `internal_error`) and
 *   logged with its stack at `error` level.
 *
 * The `x-request-id` response header is always echoed so clients can
 * correlate failures with upstream logs.
 */
export function createErrorHandler({ logger }: ErrorMiddlewareDeps): ErrorHandler {
  return (err, c) => {
    const requestId = getRequestId(c);
    c.header(REQUEST_ID_HEADER, requestId);

    if (err instanceof RetinaError) {
      logger.warn(
        {
          requestId,
          code: err.code,
          status: err.status,
          err: serializeError(err),
        },
        'retina_error',
      );
      return c.json(buildEnvelope(err, requestId), err.status as ContentfulStatusCode);
    }

    const wrapped = new InternalError({ cause: err });
    logger.error(
      {
        requestId,
        code: wrapped.code,
        status: wrapped.status,
        err: serializeError(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'internal_error',
    );
    return c.json(buildEnvelope(wrapped, requestId), wrapped.status as ContentfulStatusCode);
  };
}

function buildEnvelope(err: RetinaError, requestId: string): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    error: {
      code: err.code,
      message: err.message,
      requestId,
    },
  };
  if (err.details !== undefined) {
    envelope.error.details = err.details;
  }
  return envelope;
}

function getRequestId(c: Context): string {
  // request-id middleware (R02 sub-item 3) sets this; fall back to the raw
  // header so the error middleware is usable on its own.
  const fromContext: unknown = c.get('requestId');
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext;
  }
  const fromHeader = c.req.header(REQUEST_ID_HEADER);
  if (fromHeader && fromHeader.length > 0) {
    return fromHeader;
  }
  return UNKNOWN_REQUEST_ID;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.stack !== undefined) out.stack = err.stack;
    if ('cause' in err && err.cause !== undefined) out.cause = String(err.cause);
    return out;
  }
  return { value: String(err) };
}
