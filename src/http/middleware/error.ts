// Single place every error gets converted into the HTTP envelope.
//
// Envelope shape (spec §Error handling):
//
//   {
//     "error": {
//       "code": "<stable-code>",
//       "message": "<human string>",
//       "requestId": "<echoed-or-generated>",
//       "details": { ... }   // optional, only when RetinaError.details is set
//     }
//   }
//
// Behaviour:
//   - `RetinaError` subclasses: map to their declared `status` + `code`.
//   - Anything else: treat as `InternalError` 500, log with stack. The
//     original error is attached as `cause` for downstream tracing.
//
// Note: the error middleware registers as Hono's `onError` (not as a
// before-next middleware). That way Hono routes or downstream middleware
// that `throw` RetinaError subclasses are caught automatically.

import type { ErrorHandler } from 'hono';
import { InternalError, isRetinaError } from '../../core/errors.js';
import type { Logger } from '../../logger.js';
import type { AppEnv } from '../types.js';

export interface ErrorMiddlewareOptions {
  logger: Logger;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function errorHandler(options: ErrorMiddlewareOptions): ErrorHandler<AppEnv> {
  const { logger } = options;
  return (err, c) => {
    const requestId = c.get('requestId') ?? '';
    const retinaError = isRetinaError(err)
      ? err
      : new InternalError('internal error', { cause: err });

    if (retinaError.status >= 500) {
      logger.error(
        {
          err,
          code: retinaError.code,
          status: retinaError.status,
          requestId,
        },
        retinaError.message,
      );
    } else {
      logger.warn(
        {
          code: retinaError.code,
          status: retinaError.status,
          requestId,
        },
        retinaError.message,
      );
    }

    const body: ErrorEnvelope = {
      error: {
        code: retinaError.code,
        message: retinaError.message,
        requestId,
      },
    };
    if (retinaError.details !== undefined) {
      body.error.details = retinaError.details;
    }

    return c.json(body, retinaError.status as Parameters<typeof c.json>[1]);
  };
}
