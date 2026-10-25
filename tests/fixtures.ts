import type { EvaluationCriteria } from '../src/domain/evaluation.js';
import type { Product } from '../src/domain/product.js';
import { loadConfig, type AppConfig } from '../src/config/env.js';

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    sku: 'TEST-001',
    name: 'Producto de prueba',
    description: 'Descripción de prueba',
    category: 'Pruebas',
    supplier: { id: 'sup-test', name: 'Proveedor de prueba', warehouseCountry: 'US' },
    productCostCents: 1000, // 10.00
    shippingCostCents: 500, // 5.00
    suggestedPriceCents: 3000, // 30.00
    currency: 'USD',
    estimatedDelivery: { minDays: 3, maxDays: 5 },
    availability: { status: 'in_stock', quantity: 100 },
    ...overrides,
  };
}

export function makeCriteria(overrides: Partial<EvaluationCriteria> = {}): EvaluationCriteria {
  return {
    targetMarginBp: 3000,
    maxDeliveryDays: 7,
    requiredOriginCountry: 'US',
    additionalCosts: [],
    ...overrides,
  };
}

export const testConfig: AppConfig = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DEFAULT_TARGET_MARGIN_PERCENT: '30',
  DEFAULT_MAX_DELIVERY_DAYS: '7',
  DEFAULT_REQUIRED_ORIGIN_COUNTRY: 'US',
});

/** Producto en formato HTTP (USD con decimales). */
export function makeProductDto(overrides: Record<string, unknown> = {}) {
  return {
    sku: 'TEST-001',
    name: 'Producto de prueba',
    description: 'Descripción de prueba',
    category: 'Pruebas',
    supplier: { id: 'sup-test', name: 'Proveedor de prueba', warehouseCountry: 'US' },
    productCost: 10,
    shippingCost: 5,
    suggestedPrice: 30,
    currency: 'USD',
    estimatedDeliveryDays: { min: 3, max: 5 },
    availability: { status: 'in_stock', quantity: 100 },
    ...overrides,
  };
}
