import type { FastifyPluginAsync } from 'fastify';

export interface HealthRouteOptions {
  serviceName: string;
  version: string;
  catalogSource: string;
  /** Fase 2 (opcional): estado de componentes, sin datos sensibles. */
  components?: () => Promise<Record<string, unknown>>;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = (app, options) => {
  app.get('/health', async () => ({
    status: 'ok',
    service: options.serviceName,
    version: options.version,
    catalogSource: options.catalogSource,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    ...(options.components && { components: await options.components() }),
  }));
  return Promise.resolve();
};
