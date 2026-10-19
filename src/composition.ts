import { resolve } from 'node:path';
import { ResilientHttpClient, RateLimiter } from './adapters/http/resilient-http-client.js';
import { MemoryPersistence } from './adapters/persistence/memory-persistence.js';
import { runMigrations } from './adapters/persistence/postgres/migrator.js';
import { PostgresPersistence } from './adapters/persistence/postgres/postgres-persistence.js';
import { DisabledStore } from './adapters/store/disabled-store.js';
import { MockStore } from './adapters/store/mock-store.js';
import {
  ClientCredentialsTokenProvider,
  StaticTokenProvider,
} from './adapters/store/shopify/shopify-auth.js';
import { ShopifyGraphqlClient } from './adapters/store/shopify/shopify-graphql-client.js';
import { ShopifyStore } from './adapters/store/shopify/shopify-store.js';
import { CjClient } from './adapters/suppliers/cj/cj-client.js';
import { CjSupplier } from './adapters/suppliers/cj/cj-supplier.js';
import { MockUsSupplier } from './adapters/suppliers/mock-us-supplier.js';
import type { CatalogContext } from './application/context.js';
import type { AdapterLogger } from './application/ports/logger.js';
import type { Persistence } from './application/ports/persistence.js';
import type { StorePort } from './application/ports/store-port.js';
import type { SupplierPort } from './application/ports/supplier-port.js';
import { SupplierRegistry } from './application/supplier-registry.js';
import type { AppConfig } from './config/env.js';
import { loadRulesFile } from './config/rules.js';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'migrations');

export function createSuppliers(config: AppConfig, logger: AdapterLogger): SupplierPort[] {
  const suppliers: SupplierPort[] = [];
  if (config.MOCK_SUPPLIER_ENABLED) suppliers.push(new MockUsSupplier());

  // CJ siempre se registra para que /suppliers muestre su estado; sin credenciales responde 503.
  const http = new ResilientHttpClient({
    service: 'cjdropshipping',
    retry: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 15_000 },
    rateLimiter: new RateLimiter(config.CJ_MAX_REQUESTS_PER_SECOND),
    logger,
  });
  const client = new CjClient({
    baseUrl: config.CJ_BASE_URL,
    apiKey: config.CJ_API_KEY ?? null,
    timeoutMs: config.CJ_TIMEOUT_MS,
    http,
    logger,
  });
  suppliers.push(
    new CjSupplier(client, {
      enabled: config.CJ_ENABLED,
      destinationCountry: 'US',
      quoteOriginCountries: ['US'],
      maxQuotedVariants: config.CJ_MAX_QUOTED_VARIANTS,
      logger,
    }),
  );
  return suppliers;
}

export function createStore(config: AppConfig, logger: AdapterLogger): StorePort {
  if (config.SHOPIFY_MODE === 'disabled') return new DisabledStore();
  if (config.SHOPIFY_MODE === 'mock') return new MockStore();

  const domain = config.SHOPIFY_STORE_DOMAIN!;
  const http = new ResilientHttpClient({
    service: 'shopify',
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
    rateLimiter: new RateLimiter(2),
    logger,
  });
  const tokens =
    config.SHOPIFY_CLIENT_ID && config.SHOPIFY_CLIENT_SECRET
      ? new ClientCredentialsTokenProvider({
          domain,
          clientId: config.SHOPIFY_CLIENT_ID,
          clientSecret: config.SHOPIFY_CLIENT_SECRET,
          http,
          timeoutMs: config.SHOPIFY_TIMEOUT_MS,
        })
      : new StaticTokenProvider(config.SHOPIFY_ADMIN_ACCESS_TOKEN!);
  const client = new ShopifyGraphqlClient({
    domain,
    apiVersion: config.SHOPIFY_API_VERSION,
    tokens,
    http,
    timeoutMs: config.SHOPIFY_TIMEOUT_MS,
    logger,
  });
  return new ShopifyStore(client, {
    domain,
    apiVersion: config.SHOPIFY_API_VERSION,
    writeEnabled: config.SHOPIFY_WRITE_ENABLED,
  });
}

export async function createPersistence(
  config: AppConfig,
  logger: AdapterLogger,
): Promise<Persistence> {
  if (!config.DATABASE_URL) {
    logger.warn(
      {},
      'DATABASE_URL no definido: persistencia EN MEMORIA (los datos se pierden al reiniciar)',
    );
    return new MemoryPersistence();
  }
  const persistence = PostgresPersistence.fromUrl(config.DATABASE_URL);
  if (config.DB_AUTO_MIGRATE) {
    const result = await runMigrations(persistence.rawPool, MIGRATIONS_DIR);
    logger.info(
      { applied: result.applied, alreadyApplied: result.alreadyApplied.length },
      'Migraciones verificadas',
    );
  }
  return persistence;
}

export async function createCatalogContext(
  config: AppConfig,
  logger: AdapterLogger,
): Promise<CatalogContext> {
  const rules = loadRulesFile(resolve(config.RULES_FILE));
  const persistence = await createPersistence(config, logger);
  const suppliers = new SupplierRegistry(createSuppliers(config, logger));
  for (const s of suppliers.list()) {
    await persistence.ensureSupplier({ id: s.id, name: s.name, kind: s.kind });
  }
  return {
    persistence,
    suppliers,
    store: createStore(config, logger),
    rules,
    vendorName: config.STORE_VENDOR_NAME ?? null,
    clock: () => new Date(),
    logger,
  };
}
