import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { InternalError, RetinaError } from '../../core/errors.js';
import type { Logger } from '../../logger.js';
import type { HonoEnv } from '../types.js';

export interface ErrorHandlerOptions {
  logger: Logger;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Hono `app.onError` handler that maps all thrown errors to the canonical
 * envelope:
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "requestId": "...", "details": {...} } }
 * ```
 *
 * - `RetinaError` subclasses are mapped to their `{code, status}`; `details`
 *   is forwarded when present.
 * - Everything else is coerced into an `InternalError` (500, `internal_error`)
 *   and logged with its stack at `error` level.
 */
export function errorHandler(opts: ErrorHandlerOptions): ErrorHandler<HonoEnv> {
  const { logger } = opts;
  return (err, c) => {
    const requestId = c.get('requestId') ?? '';
    const reqLogger = (c.get('logger') as Logger | undefined) ?? logger;

    const retinaErr =
      err instanceof RetinaError ? err : new InternalError(undefined, { cause: err });

    if (retinaErr instanceof InternalError) {
      reqLogger.error(
        { err, code: retinaErr.code, status: retinaErr.status, requestId },
        'unhandled error',
      );
    } else {
      reqLogger.warn(
        { code: retinaErr.code, status: retinaErr.status, requestId, details: retinaErr.details },
        retinaErr.message,
      );
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: retinaErr.code,
        message: retinaErr.message,
        requestId,
      },
    };
    if (retinaErr.details !== undefined) envelope.error.details = retinaErr.details;

    return c.json(envelope, retinaErr.status as ContentfulStatusCode);
  };
}
