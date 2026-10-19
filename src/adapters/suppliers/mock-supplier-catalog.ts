import type { SupplierCatalog } from '../../application/ports/supplier-catalog.js';
import type { Product } from '../../domain/product.js';

/**
 * Catálogo FICTICIO para desarrollo y pruebas. Los proveedores, SKU y precios son inventados
 * (con órdenes de magnitud realistas) y no corresponden a ninguna empresa real.
 *
 * Con los parámetros por defecto (margen 30 %, entrega ≤ 7 días, bodega en US) el resultado
 * esperado es: 2 elegibles y 3 descartados por motivos distintos (margen, inventario, plazo).
 */
const MOCK_PRODUCTS: readonly Product[] = [
  {
    sku: 'DEMO-AUTO-001',
    name: 'Soporte magnético de celular para auto',
    description:
      'Soporte con imán N52 para rejilla de ventilación, rotación 360°, compatible con MagSafe.',
    category: 'Accesorios para auto',
    supplier: { id: 'demo-sup-nj', name: 'Demo Supplier New Jersey', warehouseCountry: 'US' },
    productCostCents: 420,
    shippingCostCents: 395,
    suggestedPriceCents: 1999,
    currency: 'USD',
    estimatedDelivery: { minDays: 3, maxDays: 5 },
    availability: { status: 'in_stock', quantity: 850 },
  },
  {
    sku: 'DEMO-HLTH-002',
    name: 'Corrector de postura ajustable',
    description: 'Corrector de postura transpirable con correas ajustables, tallas S a XL.',
    category: 'Salud y bienestar',
    supplier: { id: 'demo-sup-tx', name: 'Demo Supplier Texas', warehouseCountry: 'US' },
    productCostCents: 980,
    shippingCostCents: 550,
    suggestedPriceCents: 2499,
    currency: 'USD',
    estimatedDelivery: { minDays: 4, maxDays: 7 },
    availability: { status: 'low_stock', quantity: 35 },
  },
  {
    sku: 'DEMO-HOME-003',
    name: 'Tira LED RGB de 5 m con control por app',
    description: 'Tira LED 16.4 ft, 150 LED, sincronización con música y control Bluetooth.',
    category: 'Hogar e iluminación',
    supplier: { id: 'demo-sup-ca', name: 'Demo Supplier California', warehouseCountry: 'US' },
    productCostCents: 1150,
    shippingCostCents: 625,
    suggestedPriceCents: 2299,
    currency: 'USD',
    estimatedDelivery: { minDays: 3, maxDays: 6 },
    availability: { status: 'in_stock', quantity: 1200 },
  },
  {
    sku: 'DEMO-KTCH-004',
    name: 'Botella térmica de acero inoxidable 32 oz',
    description: 'Doble pared al vacío, mantiene frío 24 h y caliente 12 h, libre de BPA.',
    category: 'Cocina',
    supplier: { id: 'demo-sup-nj', name: 'Demo Supplier New Jersey', warehouseCountry: 'US' },
    productCostCents: 840,
    shippingCostCents: 710,
    suggestedPriceCents: 2999,
    currency: 'USD',
    estimatedDelivery: { minDays: 2, maxDays: 5 },
    availability: { status: 'out_of_stock', quantity: 0 },
  },
  {
    sku: 'DEMO-KTCH-005',
    name: 'Licuadora portátil recargable USB-C',
    description: 'Licuadora personal de 380 ml, 6 cuchillas, batería de 4000 mAh.',
    category: 'Cocina',
    supplier: { id: 'demo-sup-ga', name: 'Demo Supplier Georgia', warehouseCountry: 'US' },
    productCostCents: 1390,
    shippingCostCents: 680,
    suggestedPriceCents: 3999,
    currency: 'USD',
    estimatedDelivery: { minDays: 6, maxDays: 10 },
    availability: { status: 'in_stock', quantity: 410 },
  },
];

export class MockSupplierCatalog implements SupplierCatalog {
  readonly source = 'mock';

  listProducts(): Promise<Product[]> {
    // Copia profunda para que nadie pueda mutar el catálogo compartido.
    return Promise.resolve(structuredClone(MOCK_PRODUCTS) as Product[]);
  }
}
