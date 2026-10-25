import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IdempotencyRepository } from '../application/ports/persistence.js';
import { hashOf } from '../domain/text.js';
import { errorBody } from './errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Idempotencia por header `Idempotency-Key` (TTL 24 h):
 * - misma clave + mismo cuerpo  → se devuelve la respuesta original (header Idempotent-Replayed: true);
 * - misma clave + cuerpo distinto → 422 IDEMPOTENCY_KEY_REUSED;
 * - solicitud aún en curso        → 409 IDEMPOTENCY_IN_PROGRESS.
 * Solo se guardan respuestas 2xx: ante un error la clave se libera para permitir el reintento.
 */
export async function withIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  store: IdempotencyRepository,
  options: { scope: string; required: boolean; now: () => Date },
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<FastifyReply> {
  const header = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(header) ? header[0] : header;

  if (!key) {
    if (options.required) {
      return reply
        .status(400)
        .send(
          errorBody(
            'IDEMPOTENCY_KEY_REQUIRED',
            'Esta operación requiere el header Idempotency-Key (8-128 caracteres)',
          ),
        );
    }
    const result = await handler();
    return reply.status(result.status).send(result.body);
  }
  if (!KEY_RE.test(key)) {
    return reply
      .status(400)
      .send(
        errorBody(
          'IDEMPOTENCY_KEY_INVALID',
          'Idempotency-Key debe tener 8-128 caracteres [A-Za-z0-9._:-]',
        ),
      );
  }

  const requestHash = hashOf({
    method: request.method,
    url: request.url,
    body: request.body ?? null,
  });
  const begin = await store.beginIdempotent(
    options.scope,
    key,
    requestHash,
    options.now(),
    IDEMPOTENCY_TTL_MS,
  );
  if (begin.state === 'mismatch') {
    return reply
      .status(422)
      .send(
        errorBody(
          'IDEMPOTENCY_KEY_REUSED',
          'La Idempotency-Key ya se usó con una solicitud distinta',
        ),
      );
  }
  if (begin.state === 'in_progress') {
    return reply
      .status(409)
      .send(
        errorBody('IDEMPOTENCY_IN_PROGRESS', 'Hay una solicitud en curso con esta Idempotency-Key'),
      );
  }
  if (begin.state === 'completed') {
    return reply
      .header('idempotent-replayed', 'true')
      .status(begin.responseStatus)
      .send(begin.responseBody);
  }

  try {
    const result = await handler();
    if (result.status >= 200 && result.status < 300) {
      await store.completeIdempotent(options.scope, key, result.status, result.body, options.now());
    } else {
      await store.releaseIdempotent(options.scope, key);
    }
    return reply.status(result.status).send(result.body);
  } catch (error) {
    await store.releaseIdempotent(options.scope, key);
    throw error;
  }
}
