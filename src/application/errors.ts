import type { ValidationIssue } from '../domain/errors.js';

export type ErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_gateway'
  | 'timeout';

/** Error de aplicación con un `kind` que la capa HTTP traduce a un código de estado. */
export class ApplicationError extends Error {
  /** Datos estructurados y seguros (sin secretos) para incluir en la respuesta de error. */
  context?: Record<string, unknown>;

  constructor(
    public readonly kind: ErrorKind,
    public readonly code: string,
    message: string,
    public readonly details?: ValidationIssue[],
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }

  withContext(context: Record<string, unknown>): this {
    this.context = { ...this.context, ...context };
    return this;
  }
}

/**
 * Error de un servicio externo (proveedor o tienda). `retryable` indica si reintentar tiene
 * sentido (timeouts, 429, 5xx). Nunca incluye credenciales en el mensaje.
 */
export class ExternalServiceError extends ApplicationError {
  constructor(
    public readonly service: string,
    kind: ErrorKind,
    code: string,
    message: string,
    public readonly retryable: boolean,
    retryAfterSeconds?: number,
    public readonly externalRequestId?: string,
  ) {
    super(kind, code, `[${service}] ${message}`, undefined, retryAfterSeconds);
  }
}

export const notFound = (what: string, id: string) =>
  new ApplicationError('not_found', 'NOT_FOUND', `${what} no encontrado: ${id}`);
