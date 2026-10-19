/** Logger estructurado mínimo (compatible con pino/Fastify). Nunca debe recibir credenciales. */
export interface AdapterLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export const silentLogger: AdapterLogger = { debug() {}, info() {}, warn() {} };
