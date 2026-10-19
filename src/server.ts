import 'dotenv/config';
import { MockSupplierCatalog } from './adapters/suppliers/mock-supplier-catalog.js';
import { createCatalogContext } from './composition.js';
import { ConfigError, loadConfig } from './config/env.js';
import { RulesConfigError } from './config/rules.js';
import { buildApp } from './http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({
    config,
    catalog: new MockSupplierCatalog(),
    catalogContext: (logger) => createCatalogContext(config, logger),
  });

  const shutdown = (signal: string) => {
    app.log.info(`Señal ${signal} recibida, cerrando servidor...`);
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    `Desde n8n (Docker) use: http://host.docker.internal:${config.PORT} — no use localhost dentro del contenedor`,
  );
  app.log.info(
    {
      shopifyMode: config.SHOPIFY_MODE,
      shopifyWriteEnabled: config.SHOPIFY_WRITE_ENABLED,
      persistence: config.DATABASE_URL ? 'postgres' : 'memory',
    },
    'Modo de integraciones',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof RulesConfigError) {
    console.error(error.message);
  } else {
    console.error(
      'No se pudo iniciar el servidor:',
      error instanceof Error ? error.message : error,
    );
  }
  process.exit(1);
});
