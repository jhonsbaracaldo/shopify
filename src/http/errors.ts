import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApplicationError, ExternalServiceError, type ErrorKind } from '../application/errors.js';
import { DomainError, DomainValidationError, type ValidationIssue } from '../domain/errors.js';

/** Formato único de error de la API. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: ValidationIssue[];
    context?: Record<string, unknown>;
  };
}

export function errorBody(
  code: string,
  message: string,
  details?: ValidationIssue[],
  context?: Record<string, unknown>,
): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 && { details }),
      ...(context && Object.keys(context).length > 0 && { context }),
    },
  };
}

export function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(raíz)',
    message: issue.message,
  }));
}

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  bad_gateway: 502,
  unavailable: 503,
  timeout: 504,
};

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(errorBody('NOT_FOUND', `Ruta no encontrada: ${request.method} ${request.url}`));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', 'La solicitud no es válida', zodIssues(error)));
    }
    if (error instanceof ApplicationError) {
      const status = STATUS_BY_KIND[error.kind];
      if (error.retryAfterSeconds !== undefined)
        void reply.header('retry-after', String(error.retryAfterSeconds));
      const context = {
        ...error.context,
        ...(error instanceof ExternalServiceError && {
          service: error.service,
          retryable: error.retryable,
          ...(error.externalRequestId && { externalRequestId: error.externalRequestId }),
        }),
      };
      if (status >= 500)
        request.log.warn(
          { code: error.code, kind: error.kind, msg: error.message },
          'Error de servicio externo',
        );
      return reply
        .status(status)
        .send(errorBody(error.code, error.message, error.details, context));
    }
    if (error instanceof DomainValidationError) {
      return reply.status(422).send(errorBody(error.code, error.message, error.issues));
    }
    if (error instanceof DomainError) {
      return reply.status(422).send(errorBody(error.code, error.message));
    }

    const status = error.statusCode ?? 500;
    if (status === 415) {
      return reply
        .status(415)
        .send(errorBody('UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json'));
    }
    if (status >= 400 && status < 500) {
      // JSON mal formado, cuerpo vacío, payload demasiado grande, etc.
      return reply.status(status).send(errorBody('BAD_REQUEST', error.message));
    }

    request.log.error({ err: error }, 'Error no controlado');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Error interno del servidor'));
  });
}
