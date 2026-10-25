import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { errorBody } from './errors.js';

/**
 * Autenticación por clave en el header `X-Api-Key` con dos roles separados:
 * - admin: automatizaciones (n8n) → importar, evaluar, preparar y crear borradores.
 * - approver: decisiones humanas → aprobar/rechazar. n8n NO debe tener esta clave.
 * Sin clave configurada para un rol, los endpoints de ese rol responden 503 (fallan cerrados).
 */
export type Role = 'admin' | 'approver';

export const API_KEY_HEADER = 'x-api-key';

declare module 'fastify' {
  interface FastifyRequest {
    actorRole?: Role;
  }
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Comparación en tiempo constante (sobre hashes de igual longitud). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export interface AuthGuard {
  /** preHandler de Fastify para proteger una ruta completa. */
  require(allowed: Role[]): preHandlerHookHandler;
  /** Verificación dentro de un handler; si devuelve false, la respuesta de error ya se envió. */
  authorize(request: FastifyRequest, reply: FastifyReply, allowed: Role[]): boolean;
}

export function createAuthGuard(keys: {
  admin?: string | undefined;
  approver?: string | undefined;
}): AuthGuard {
  const configured: [Role, string][] = [];
  if (keys.admin) configured.push(['admin', keys.admin]);
  if (keys.approver) configured.push(['approver', keys.approver]);

  const authorize = (request: FastifyRequest, reply: FastifyReply, allowed: Role[]): boolean => {
    if (!configured.some(([role]) => allowed.includes(role))) {
      const names = allowed
        .map((r) => (r === 'admin' ? 'ADMIN_API_KEY' : 'APPROVER_API_KEY'))
        .join(' o ');
      void reply
        .status(503)
        .send(errorBody('AUTH_NOT_CONFIGURED', `Endpoint deshabilitado: configure ${names}`));
      return false;
    }
    const header = request.headers[API_KEY_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) {
      void reply.status(401).send(errorBody('UNAUTHORIZED', 'Falta el header X-Api-Key'));
      return false;
    }
    const role = configured.find(([, key]) => safeEqual(provided, key))?.[0];
    if (!role) {
      void reply.status(401).send(errorBody('UNAUTHORIZED', 'Clave de API no válida'));
      return false;
    }
    if (!allowed.includes(role)) {
      void reply
        .status(403)
        .send(errorBody('FORBIDDEN', `La clave de rol "${role}" no permite esta operación`));
      return false;
    }
    request.actorRole = role;
    return true;
  };

  return {
    authorize,
    require: (allowed) =>
      function guard(request, reply, done) {
        if (authorize(request, reply, allowed)) done();
      },
  };
}
