import type {
  ListSupplierProductsQuery,
  Page,
  ShippingQuoteRequest,
  SupplierInfo,
  SupplierPort,
  SupplierProductSummary,
} from '../../application/ports/supplier-port.js';
import type {
  ShippingQuote,
  SupplierProduct,
  SupplierVariant,
  WarehouseStock,
} from '../../domain/catalog.js';
import { normalizeForMatching } from '../../domain/text.js';

/**
 * Proveedor FICTICIO para desarrollo, pruebas y demostración de los workflows de n8n.
 * NO representa a CJ ni a ningún proveedor real: nombres, IDs, precios e inventarios son inventados.
 * Cada producto cubre un caso de la clasificación (ver comentarios).
 */
const IMG = (n: string) => `https://example.com/mock-us/${n}.jpg`;

const usStock = (quantity: number | null, id = 'mock-nj'): WarehouseStock => ({
  warehouseId: id,
  warehouseName: 'Mock Warehouse New Jersey',
  countryCode: 'US',
  quantity,
});
const cnStock = (quantity: number): WarehouseStock => ({
  warehouseId: 'mock-sz',
  warehouseName: 'Mock Warehouse Shenzhen',
  countryCode: 'CN',
  quantity,
});
const usQuote = (
  costCents: number,
  minDays: number,
  maxDays: number,
  method = 'Mock Ground US',
): ShippingQuote => ({
  method,
  originCountry: 'US',
  destinationCountry: 'US',
  costCents,
  minDays,
  maxDays,
});

function variant(
  partial: Partial<SupplierVariant> & Pick<SupplierVariant, 'externalId'>,
): SupplierVariant {
  return {
    sku: `${partial.externalId}-SKU`,
    name: null,
    options: {},
    barcode: null,
    costCents: null,
    suggestedRetailCents: null,
    weightGrams: 500,
    imageUrl: null,
    inventory: [],
    shippingQuotes: [],
    ...partial,
  };
}

function product(partial: Omit<SupplierProduct, 'supplierId' | 'currency'>): SupplierProduct {
  return { supplierId: 'mock-us', currency: 'USD', ...partial };
}

export const MOCK_US_PRODUCTS: readonly SupplierProduct[] = [
  // Caso: APPROVED (dos variantes con stock en EE. UU., entrega rápida, margen suficiente).
  product({
    externalId: 'MUS-1001',
    sku: 'MUS-1001',
    name: 'Soporte ajustable de aluminio para laptop',
    description:
      '<p>Soporte plegable de aluminio, 6 alturas.</p><p>Compatible con laptops de 10 a 17 pulgadas.</p>',
    category: 'Office Supplies > Laptop Stands',
    images: [IMG('1001-a'), IMG('1001-b')],
    variants: [
      variant({
        externalId: 'MUS-1001-SLV',
        options: { Color: 'Silver' },
        costCents: 980,
        suggestedRetailCents: 3499,
        weightGrams: 650,
        inventory: [usStock(420)],
        shippingQuotes: [usQuote(495, 2, 4)],
      }),
      variant({
        externalId: 'MUS-1001-GRY',
        options: { Color: 'Space Gray' },
        costCents: 980,
        suggestedRetailCents: 3499,
        weightGrams: 650,
        inventory: [usStock(150)],
        shippingQuotes: [usQuote(495, 2, 4)],
      }),
    ],
  }),
  // Caso: APPROVED (una sola variante, sin opciones).
  product({
    externalId: 'MUS-1002',
    sku: 'MUS-1002',
    name: 'Lámpara LED de escritorio con base de carga inalámbrica',
    description: 'Lámpara LED regulable con 3 temperaturas de color y base de carga Qi.',
    category: 'Home > Lighting',
    images: [IMG('1002')],
    variants: [
      variant({
        externalId: 'MUS-1002-STD',
        costCents: 1420,
        weightGrams: 900,
        inventory: [usStock(85)],
        shippingQuotes: [usQuote(640, 2, 5)],
      }),
    ],
  }),
  // Caso: REJECTED por disponibilidad: la variante con bodega en EE. UU. está agotada y la otra solo está en China.
  product({
    externalId: 'MUS-1003',
    sku: 'MUS-1003',
    name: 'Botella térmica de acero inoxidable 1 L',
    description: 'Doble pared al vacío, 24 h frío / 12 h caliente.',
    category: 'Kitchen > Drinkware',
    images: [IMG('1003')],
    variants: [
      variant({
        externalId: 'MUS-1003-BLK',
        options: { Color: 'Black' },
        costCents: 760,
        weightGrams: 420,
        inventory: [usStock(0)],
        shippingQuotes: [usQuote(450, 2, 4)],
      }),
      variant({
        externalId: 'MUS-1003-WHT',
        options: { Color: 'White' },
        costCents: 760,
        weightGrams: 420,
        inventory: [cnStock(500)],
        shippingQuotes: [],
      }),
    ],
  }),
  // Caso: REJECTED por categoría bloqueada.
  product({
    externalId: 'MUS-1004',
    sku: 'MUS-1004',
    name: 'Set de cuchillos de cocina 6 piezas',
    description: 'Juego de cuchillos de acero inoxidable con bloque de madera.',
    category: 'Kitchen > Knives',
    images: [IMG('1004')],
    variants: [
      variant({
        externalId: 'MUS-1004-STD',
        costCents: 1850,
        weightGrams: 1600,
        inventory: [usStock(200)],
        shippingQuotes: [usQuote(890, 3, 5)],
      }),
    ],
  }),
  // Caso: REVIEW_REQUIRED por categoría con requisitos regulatorios (productos infantiles).
  product({
    externalId: 'MUS-1005',
    sku: 'MUS-1005',
    name: 'Organizador plegable de juguetes',
    description: 'Organizador de tela con 3 compartimentos.',
    category: 'Baby & Kids > Storage',
    images: [IMG('1005')],
    variants: [
      variant({
        externalId: 'MUS-1005-STD',
        costCents: 1100,
        weightGrams: 800,
        inventory: [usStock(300)],
        shippingQuotes: [usQuote(560, 2, 4)],
      }),
    ],
  }),
  // Caso: REVIEW_REQUIRED por margen: el precio recomendado supera el techo y el margen queda entre mínimo y objetivo.
  product({
    externalId: 'MUS-1006',
    sku: 'MUS-1006',
    name: 'Mochila antirrobo para laptop con puerto USB',
    description:
      'Mochila impermeable con cierre oculto y compartimento acolchado de 15,6 pulgadas.',
    category: 'Luggage > Backpacks',
    images: [IMG('1006')],
    variants: [
      variant({
        externalId: 'MUS-1006-STD',
        costCents: 4400,
        suggestedRetailCents: 7999,
        weightGrams: 1100,
        inventory: [usStock(140)],
        shippingQuotes: [usQuote(950, 2, 4)],
      }),
    ],
  }),
  // Caso: REJECTED por margen: ni con el precio techo cubre los costos.
  product({
    externalId: 'MUS-1007',
    sku: 'MUS-1007',
    name: 'Silla ergonómica de oficina con soporte lumbar',
    description: 'Silla de malla con reposabrazos ajustables.',
    category: 'Office Furniture > Chairs',
    images: [IMG('1007')],
    variants: [
      variant({
        externalId: 'MUS-1007-STD',
        costCents: 6800,
        weightGrams: 14000,
        inventory: [usStock(60)],
        shippingQuotes: [usQuote(2490, 3, 6)],
      }),
    ],
  }),
  // Caso: REJECTED por plazo de entrega (bodega en EE. UU. pero tránsito lento).
  product({
    externalId: 'MUS-1008',
    sku: 'MUS-1008',
    name: 'Funda de silicona para estuche de audífonos inalámbricos',
    description: 'Funda de silicona con mosquetón.',
    category: 'Electronics Accessories > Cases',
    images: [IMG('1008')],
    variants: [
      variant({
        externalId: 'MUS-1008-STD',
        costCents: 190,
        weightGrams: 40,
        inventory: [usStock(2000)],
        shippingQuotes: [usQuote(350, 7, 12, 'Mock Economy US')],
      }),
    ],
  }),
  // Caso: REVIEW_REQUIRED por posible duplicado de MUS-1003 (misma huella de nombre, distinto ID).
  product({
    externalId: 'MUS-1009',
    sku: 'MUS-1009',
    name: 'Botella térmica 1 L de acero inoxidable',
    description: 'Botella de acero inoxidable con tapa a prueba de fugas.',
    category: 'Kitchen > Drinkware',
    images: [IMG('1009')],
    variants: [
      variant({
        externalId: 'MUS-1009-STD',
        costCents: 790,
        weightGrams: 430,
        inventory: [usStock(90)],
        shippingQuotes: [usQuote(450, 2, 4)],
      }),
    ],
  }),
  // Caso: REVIEW_REQUIRED por información incompleta (sin descripción, peso, cantidad ni cotización).
  product({
    externalId: 'MUS-1010',
    sku: 'MUS-1010',
    name: 'Mini proyector portátil 1080p',
    description: null,
    category: 'Electronics > Projectors',
    images: [IMG('1010')],
    variants: [
      variant({
        externalId: 'MUS-1010-STD',
        costCents: 3150,
        weightGrams: null,
        inventory: [usStock(null)],
        shippingQuotes: null,
      }),
    ],
  }),
];

export class MockUsSupplier implements SupplierPort {
  readonly info: SupplierInfo = {
    id: 'mock-us',
    name: 'Proveedor ficticio EE. UU. (mock)',
    kind: 'mock',
    enabled: true,
    configured: true,
    capabilities: {
      inventoryByWarehouse: true,
      shippingQuotes: true,
      filterByShipFromCountry: true,
    },
    docsUrl: null,
    notes: ['Datos inventados para desarrollo y pruebas. No usar para decisiones comerciales.'],
  };

  constructor(private readonly products: readonly SupplierProduct[] = MOCK_US_PRODUCTS) {}

  private find(externalId: string): SupplierProduct | undefined {
    return this.products.find((p) => p.externalId === externalId);
  }

  private findVariant(variantId: string): SupplierVariant | undefined {
    return this.products.flatMap((p) => p.variants).find((v) => v.externalId === variantId);
  }

  listProducts(query: ListSupplierProductsQuery): Promise<Page<SupplierProductSummary>> {
    const keyword = query.keyword ? normalizeForMatching(query.keyword) : null;
    const filtered = this.products.filter((p) => {
      if (keyword && !normalizeForMatching(`${p.name} ${p.sku ?? ''}`).includes(keyword))
        return false;
      if (query.shipsFromCountry) {
        return p.variants.some((v) =>
          v.inventory?.some((s) => s.countryCode === query.shipsFromCountry),
        );
      }
      return true;
    });
    const start = (query.page - 1) * query.pageSize;
    const items = filtered.slice(start, start + query.pageSize).map((p) => ({
      externalId: p.externalId,
      sku: p.sku,
      name: p.name,
      imageUrl: p.images[0] ?? null,
      listCostCents: Math.min(...p.variants.map((v) => v.costCents ?? Number.POSITIVE_INFINITY)),
      category: p.category,
      warehouseCountries: [
        ...new Set(
          p.variants.flatMap(
            (v) =>
              v.inventory?.map((s) => s.countryCode).filter((c): c is string => c !== null) ?? [],
          ),
        ),
      ],
    }));
    return Promise.resolve({
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      hasMore: start + items.length < filtered.length,
    });
  }

  getProduct(externalId: string): Promise<SupplierProduct | null> {
    const found = this.find(externalId);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  getVariants(externalId: string): Promise<SupplierVariant[]> {
    return Promise.resolve(structuredClone(this.find(externalId)?.variants ?? []));
  }

  getInventory(variantExternalId: string): Promise<WarehouseStock[]> {
    return Promise.resolve(structuredClone(this.findVariant(variantExternalId)?.inventory ?? []));
  }

  getShippingQuotes(request: ShippingQuoteRequest): Promise<ShippingQuote[]> {
    const quotes = this.findVariant(request.variantExternalId)?.shippingQuotes ?? [];
    return Promise.resolve(
      structuredClone(
        quotes.filter(
          (q) =>
            q.originCountry === request.originCountry &&
            q.destinationCountry === request.destinationCountry,
        ),
      ),
    );
  }
}
