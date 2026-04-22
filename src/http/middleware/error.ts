// Central error handler. Every thrown error — whether a `RetinaError`
// subclass or an uncaught unknown — is mapped here to the spec's error
// envelope `{error: {code, message, requestId, details}}` with the matching
// HTTP status.
//
// Installed via `registerErrorHandler(app, {logger})`. We register an
// `app.onError()` handler rather than a middleware because Hono's composer
// catches thrown errors before they propagate to user middleware.

import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { InternalError, isRetinaError, type RetinaError } from '../../core/errors.js';
import type { Logger } from '../../logger.js';
import type { AppEnv } from '../context.js';

export interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface ErrorHandlerOptions {
  logger?: Logger;
}

export function registerErrorHandler(app: Hono<AppEnv>, opts: ErrorHandlerOptions = {}): void {
  const log = opts.logger;
  app.onError((err, c) => renderError(err, c, log));
}

export function renderError(err: unknown, c: Context<AppEnv>, log?: Logger): Response {
  const retina: RetinaError = isRetinaError(err)
    ? err
    : new InternalError('unexpected error', { cause: err });
  const requestId = c.get('requestId') ?? '';

  const payload: ErrorEnvelopeBody = {
    error: {
      code: retina.code,
      message: retina.message,
      requestId,
      ...(retina.details !== undefined ? { details: retina.details } : {}),
    },
  };

  if (retina instanceof InternalError) {
    log?.error({ err, requestId, code: retina.code }, 'unhandled error');
  } else {
    log?.warn({ requestId, code: retina.code, status: retina.status }, 'retina error');
  }

  // `c.json` builds a fresh Response; re-apply the request-id echo header on
  // the context so it survives into the final response.
  c.header('x-request-id', requestId);
  return c.json(payload, retina.status as ContentfulStatusCode);
}
