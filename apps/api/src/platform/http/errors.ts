import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '@edu/kernel';
import { AuthorizationNotEvaluatedError, PolicyConfigurationError } from '@edu/authz';
import type { Logger } from '@edu/observability';

/**
 * Central error handler.
 *
 * The governing rule: the client learns the error CODE and nothing about the
 * server's internals. Stack traces, SQL text, constraint names and driver
 * messages are logged, never serialized. Anything unrecognized becomes a
 * generic 500 — a new error type cannot start leaking detail just because
 * nobody remembered to add a case for it.
 *
 * The `correlationId` is returned so a user can quote it in a support request
 * and an operator can find the full detail in the logs.
 */
export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.correlationId;
    const log = logger.child({ correlationId, method: request.method, path: request.url });

    if (error instanceof ZodError) {
      // Field paths and messages are safe to return: they describe the client's
      // own request. Received VALUES are not included.
      log.info('request validation rejected', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      });
      return reply.status(400).send({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Validation failed',
          detail: {
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          correlationId,
        },
      });
    }

    if (error instanceof AppError) {
      const level = error.httpStatus >= 500 ? 'error' : 'info';
      log[level]('request failed', { code: error.code, status: error.httpStatus });
      return reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.publicDetail ? { detail: error.publicDetail } : {}),
          correlationId,
        },
      });
    }

    // These two mean the authorization plumbing itself is wired wrong. They are
    // never the user's fault, they must never be silently downgraded to a 403,
    // and they are worth waking somebody up for.
    if (
      error instanceof AuthorizationNotEvaluatedError ||
      error instanceof PolicyConfigurationError
    ) {
      log.error('AUTHORIZATION PLUMBING FAULT — failing closed', {
        fault: error.name,
        reason: error.message,
      });
      return reply.status(500).send({
        error: { code: ErrorCode.INTERNAL, message: 'Internal error', correlationId },
      });
    }

    if (isBodyTooLarge(error)) {
      return reply.status(413).send({
        error: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'Payload too large', correlationId },
      });
    }

    // Framework-level CLIENT errors (malformed JSON, an empty body where one is
    // required, an unsupported content type, a rate-limit rejection).
    //
    // These must keep their 4xx status. Reporting a malformed request as 500
    // would be wrong twice over: it tells the caller the server is broken when
    // it is not, and it corrupts the error-rate signal that on-call alerting
    // depends on — a burst of junk requests would look like an outage.
    //
    // Only the STATUS is taken from the framework error; the message is our own,
    // so no internal detail escapes.
    const frameworkStatus = clientErrorStatus(error);
    if (frameworkStatus !== null) {
      log.info('client error', { status: frameworkStatus });
      return reply.status(frameworkStatus).send({
        error: {
          code: frameworkStatus === 429 ? ErrorCode.RATE_LIMITED : ErrorCode.VALIDATION_FAILED,
          message: frameworkStatus === 429 ? 'Too many requests' : 'Bad request',
          correlationId,
        },
      });
    }

    log.error('unhandled error', { error });
    return reply.status(500).send({
      error: { code: ErrorCode.INTERNAL, message: 'Internal error', correlationId },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Not found',
        correlationId: request.correlationId,
      },
    }),
  );
}

function isBodyTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}

/**
 * Returns the 4xx status of a framework-raised client error, or null if this is
 * not one. Anything 5xx deliberately returns null so it falls through to the
 * generic 500 path and gets logged as an unhandled error.
 */
function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  return status >= 400 && status <= 499 ? status : null;
}
