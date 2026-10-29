import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError, ServiceUnavailableError } from '../lib/errors.js';

/**
 * Central error mapping. Error body: { error: { code, message, details?, requestId } }
 *   400 VALIDATION_ERROR / MALFORMED_REQUEST / UNKNOWN_SYMBOL / IDEMPOTENCY_KEY_REQUIRED ...
 *   401 UNAUTHORIZED            404 *_NOT_FOUND
 *   409 IDEMPOTENCY_KEY_REUSED / ORDER_NOT_CANCELLABLE / TRANSACTION_CONFLICT
 *   422 INSUFFICIENT_FUNDS / INSUFFICIENT_SHARES / ORDER_BELOW_MINIMUM
 *   503 CIRCUIT_BREAKER_ACTIVE / MARKET_DATA_UNAVAILABLE (with Retry-After)
 *   500 INTERNAL_ERROR (details never leaked)
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void send(
      reply,
      request,
      404,
      'ROUTE_NOT_FOUND',
      `route ${request.method} ${request.url} not found`,
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      if (error instanceof ServiceUnavailableError && error.retryAfterSeconds !== undefined) {
        void reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      if (error.statusCode >= 500) request.log.warn({ code: error.code }, error.message);
      return send(reply, request, error.statusCode, error.code, error.message, error.details);
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, request, 400, 'VALIDATION_ERROR', 'request validation failed', {
        issues: error.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
        context: error.validationContext,
      });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      return send(reply, request, 500, 'INTERNAL_ERROR', 'internal server error');
    }
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '40001' || pgCode === '40P01') {
      request.log.warn({ err: error }, 'transaction conflict');
      return send(
        reply,
        request,
        409,
        'TRANSACTION_CONFLICT',
        'concurrent update conflict, please retry',
        {
          retryable: true,
        },
      );
    }
    if (error.statusCode === 401 || pgCode?.startsWith('FST_JWT')) {
      return send(reply, request, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return send(reply, request, error.statusCode, 'MALFORMED_REQUEST', error.message);
    }
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, 500, 'INTERNAL_ERROR', 'internal server error');
  });
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply.status(status).send({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId: String(request.id),
    },
  });
}
