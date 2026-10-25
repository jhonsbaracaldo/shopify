import { randomUUID } from 'node:crypto';
import { MemoryPersistence } from '../../src/adapters/persistence/memory-persistence.js';
import { MockStore } from '../../src/adapters/store/mock-store.js';
import { MockUsSupplier } from '../../src/adapters/suppliers/mock-us-supplier.js';
import type { CatalogContext } from '../../src/application/context.js';
import { silentLogger } from '../../src/application/ports/logger.js';
import type { Persistence } from '../../src/application/ports/persistence.js';
import type { StorePort } from '../../src/application/ports/store-port.js';
import type { SupplierPort } from '../../src/application/ports/supplier-port.js';
import { SupplierRegistry } from '../../src/application/supplier-registry.js';
import { loadRulesFile } from '../../src/config/rules.js';
import {
  normalizeSupplierProduct,
  type CatalogProduct,
  type SupplierProduct,
  type SupplierVariant,
} from '../../src/domain/catalog.js';
import type { EvaluationRules } from '../../src/domain/rules.js';

/** Reglas reales del repositorio (config/evaluation-rules.json). */
export const defaultRules: EvaluationRules = loadRulesFile('config/evaluation-rules.json');

export function makeVariant(overrides: Partial<SupplierVariant> = {}): SupplierVariant {
  return {
    externalId: 'V-1',
    sku: 'SKU-V-1',
    name: 'Variante 1',
    options: {},
    barcode: null,
    costCents: 980,
    suggestedRetailCents: null,
    weightGrams: 500,
    imageUrl: null,
    inventory: [{ warehouseId: 'us-1', warehouseName: 'US 1', countryCode: 'US', quantity: 200 }],
    shippingQuotes: [
      {
        method: 'Ground',
        originCountry: 'US',
        destinationCountry: 'US',
        costCents: 495,
        minDays: 2,
        maxDays: 4,
      },
    ],
    ...overrides,
  };
}

export function makeSupplierProduct(overrides: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    supplierId: 'test-sup',
    externalId: 'P-1',
    sku: 'P-1',
    name: 'Soporte de aluminio para laptop',
    description: 'Descripción del producto',
    category: 'Office Supplies',
    images: ['https://example.com/a.jpg'],
    currency: 'USD',
    variants: [makeVariant()],
    ...overrides,
  };
}

/** Producto normalizado con IDs internos (como si se hubiera persistido). */
export function makeCatalogProduct(overrides: Partial<SupplierProduct> = {}): CatalogProduct {
  const normalized = normalizeSupplierProduct(makeSupplierProduct(overrides));
  const now = new Date('2026-10-18T12:00:00Z');
  return {
    ...normalized,
    id: randomUUID(),
    variants: normalized.variants.map((v) => ({ ...v, id: randomUUID() })),
    version: 1,
    firstSeenAt: now,
    lastSyncedAt: now,
  };
}

/** Reloj controlable para pruebas. */
export function fixedClock(start = '2026-10-18T12:00:00Z') {
  let current = new Date(start).getTime();
  const clock = () => new Date(current);
  clock.advance = (ms: number) => {
    current += ms;
  };
  return clock;
}

export function createTestContext(
  options: {
    persistence?: Persistence;
    store?: StorePort;
    suppliers?: SupplierPort[];
    rules?: EvaluationRules;
    clock?: () => Date;
  } = {},
): CatalogContext & { store: StorePort } {
  return {
    persistence: options.persistence ?? new MemoryPersistence(),
    suppliers: new SupplierRegistry(options.suppliers ?? [new MockUsSupplier()]),
    store: options.store ?? new MockStore(),
    rules: options.rules ?? defaultRules,
    vendorName: null,
    clock: options.clock ?? fixedClock(),
    logger: silentLogger,
  };
}

export const ADMIN_KEY = 'admin-key-for-tests-0123456789abcdef';
export const APPROVER_KEY = 'approver-key-for-tests-0123456789abcd';
