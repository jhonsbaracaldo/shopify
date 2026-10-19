import Fastify, { type FastifyInstance } from 'fastify';
import type { CatalogContext } from '../application/context.js';
import { storeKeyOf } from '../application/context.js';
import type { AdapterLogger } from '../application/ports/logger.js';
import type { SupplierCatalog } from '../application/ports/supplier-catalog.js';
import { EvaluateProductUseCase } from '../application/use-cases/evaluate-product.js';
import { ListProductsUseCase } from '../application/use-cases/list-products.js';
import type { AppConfig } from '../config/env.js';
import { percentToBasisPoints } from '../domain/money.js';
import { createAuthGuard } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { catalogRoutes, createCatalogEvaluateHandler } from './routes/catalog.js';
import { healthRoutes } from './routes/health.js';
import { productRoutes } from './routes/products.js';

export const SERVICE_NAME = 'dropshipping-automation-backend';
export const SERVICE_VERSION = '0.2.0';

export interface AppDependencies {
  config: AppConfig;
  /** Catálogo simulado de la Fase 1 (GET /api/v1/products). */
  catalog: SupplierCatalog;
  /**
   * Fase 2: catálogo persistente, proveedores, tienda y reglas. Si se omite, solo hay Fase 1.
   * Puede ser una factory que recibe el logger de Fastify; en ese caso la app cierra la persistencia.
   */
  catalogContext?: CatalogContext | ((logger: AdapterLogger) => Promise<CatalogContext>);
}

/** Composition root HTTP: construye la aplicación Fastify inyectando configuración y adaptadores. */
export async function buildApp({
  config,
  catalog,
  catalogContext: contextOrFactory,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Defensa adicional: estos headers nunca deben llegar a los logs.
            redact: [
              'req.headers["x-api-key"]',
              'req.headers.authorization',
              'req.headers["x-shopify-access-token"]',
            ],
          },
    bodyLimit: 1024 * 1024,
  });

  // La API solo acepta JSON: sin este parser, text/plain responde 415 en lugar de llegar como string.
  app.removeContentTypeParser('text/plain');
  registerErrorHandling(app);

  const listProducts = new ListProductsUseCase(catalog);
  const evaluateProduct = new EvaluateProductUseCase({
    targetMarginBp: percentToBasisPoints(config.DEFAULT_TARGET_MARGIN_PERCENT),
    maxDeliveryDays: config.DEFAULT_MAX_DELIVERY_DAYS,
    requiredOriginCountry: config.DEFAULT_REQUIRED_ORIGIN_COUNTRY,
  });

  const auth = createAuthGuard({ admin: config.ADMIN_API_KEY, approver: config.APPROVER_API_KEY });

  let catalogContext: CatalogContext | undefined;
  if (typeof contextOrFactory === 'function') {
    const created = await contextOrFactory(app.log);
    catalogContext = created;
    app.addHook('onClose', () => created.persistence.close());
  } else {
    catalogContext = contextOrFactory;
  }

  await app.register(healthRoutes, {
    serviceName: SERVICE_NAME,
    version: SERVICE_VERSION,
    catalogSource: catalog.source,
    ...(catalogContext && {
      components: async () => ({
        persistence: {
          kind: catalogContext.persistence.kind,
          ok: await catalogContext.persistence.ping(),
        },
        store: {
          key: storeKeyOf(catalogContext.store.info),
          mode: catalogContext.store.info.mode,
          writeEnabled: catalogContext.store.info.writeEnabled,
        },
        suppliers: catalogContext.suppliers
          .list()
          .map((s) => ({ id: s.id, kind: s.kind, enabled: s.enabled, configured: s.configured })),
        rulesVersion: catalogContext.rules.version,
        auth: {
          adminKeyConfigured: Boolean(config.ADMIN_API_KEY),
          approverKeyConfigured: Boolean(config.APPROVER_API_KEY),
        },
      }),
    }),
  });
  await app.register(productRoutes, {
    prefix: '/api/v1',
    listProducts,
    evaluateProduct,
    ...(catalogContext && { catalogEvaluate: createCatalogEvaluateHandler(catalogContext, auth) }),
  });
  if (catalogContext) {
    await app.register(catalogRoutes, { prefix: '/api/v1', ctx: catalogContext, auth });
  }

  return app;
}
