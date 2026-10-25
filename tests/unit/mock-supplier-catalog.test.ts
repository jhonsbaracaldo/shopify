import { describe, expect, it } from 'vitest';
import { MockSupplierCatalog } from '../../src/adapters/suppliers/mock-supplier-catalog.js';
import { evaluateProduct } from '../../src/domain/evaluation.js';
import { assertValidProduct } from '../../src/domain/product.js';
import { makeCriteria } from '../fixtures.js';

describe('MockSupplierCatalog', () => {
  it('devuelve cinco productos válidos con SKU únicos', async () => {
    const products = await new MockSupplierCatalog().listProducts();
    expect(products).toHaveLength(5);
    products.forEach((p) => expect(() => assertValidProduct(p)).not.toThrow());
    expect(new Set(products.map((p) => p.sku)).size).toBe(5);
  });

  it('entrega copias: mutar el resultado no altera el catálogo', async () => {
    const catalog = new MockSupplierCatalog();
    const first = await catalog.listProducts();
    first[0]!.productCostCents = 999_999;
    const second = await catalog.listProducts();
    expect(second[0]!.productCostCents).toBe(420);
  });

  it('con criterios por defecto produce 2 elegibles y 3 descartados', async () => {
    const products = await new MockSupplierCatalog().listProducts();
    const eligible = products
      .map((p) => evaluateProduct(p, makeCriteria()))
      .filter((r) => r.eligible)
      .map((r) => r.sku);
    expect(eligible).toEqual(['DEMO-AUTO-001', 'DEMO-HLTH-002']);
  });
});
