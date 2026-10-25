import { describe, expect, it } from 'vitest';
import { normalizeSupplierProduct } from '../../../src/domain/catalog.js';
import { classifyProduct, type DuplicateMatch } from '../../../src/domain/classification.js';
import { MOCK_US_PRODUCTS } from '../../../src/adapters/suppliers/mock-us-supplier.js';
import type { EvaluationRules } from '../../../src/domain/rules.js';
import { defaultRules, makeCatalogProduct, makeVariant } from '../helpers.js';

const classify = (
  product = makeCatalogProduct(),
  rules: EvaluationRules = defaultRules,
  duplicates: DuplicateMatch[] = [],
) => classifyProduct(product, rules, { duplicates });

const outcome = (result: ReturnType<typeof classify>, rule: string) =>
  result.findings.find((f) => f.rule === rule)?.outcome;

const usStock = (quantity: number | null) => [
  { warehouseId: 'us', warehouseName: null, countryCode: 'US', quantity },
];
const cnStock = (quantity: number) => [
  { warehouseId: 'cn', warehouseName: null, countryCode: 'CN', quantity },
];

describe('classifyProduct — APPROVED', () => {
  it('aprueba un producto completo, con stock en EE. UU., entrega rápida y margen ≥ objetivo', () => {
    const result = classify();
    expect(result.classification).toBe('APPROVED');
    expect(result.findings.every((f) => f.outcome === 'PASS')).toBe(true);
    const variant = result.variants[0]!;
    expect(variant.status).toBe('ELIGIBLE');
    expect(variant.recommendedPriceCents).toBe(2999);
    expect(variant.salePriceCents).toBe(2999);
    expect(variant.shipping).toMatchObject({ costCents: 495, deliveryDays: { min: 4, max: 6 } }); // 2-4 + 2 de preparación
    expect(result.summary).toMatchObject({
      eligibleVariants: 1,
      priceRangeCents: { min: 2999, max: 2999 },
    });
    expect(result.notes.join(' ')).toMatch(/no es una autorización para publicar/);
    expect(result.notes.join(' ')).toMatch(/no son ganancias netas definitivas/);
  });

  it('elige la cotización más barata que cumple el plazo', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({
          shippingQuotes: [
            {
              method: 'Express',
              originCountry: 'US',
              destinationCountry: 'US',
              costCents: 1200,
              minDays: 1,
              maxDays: 2,
            },
            {
              method: 'Ground',
              originCountry: 'US',
              destinationCountry: 'US',
              costCents: 450,
              minDays: 3,
              maxDays: 5,
            },
            {
              method: 'Slow',
              originCountry: 'US',
              destinationCountry: 'US',
              costCents: 200,
              minDays: 9,
              maxDays: 15,
            },
          ],
        }),
      ],
    });
    expect(classify(product).variants[0]!.shipping?.method).toBe('Ground');
  });
});

describe('classifyProduct — productos sin bodega estadounidense', () => {
  it('rechaza si ninguna variante tiene bodega en EE. UU., aunque el proveedor sea de EE. UU.', () => {
    const product = makeCatalogProduct({
      variants: [makeVariant({ inventory: cnStock(5000), shippingQuotes: [] })],
    });
    const result = classify(product);
    expect(result.classification).toBe('REJECTED');
    expect(outcome(result, 'SHIPPING_ORIGIN')).toBe('REJECT');
    expect(result.variants[0]!.reasons).toContain('sin bodega en US');
  });

  it('ignora cotizaciones de envío desde otros países', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({
          shippingQuotes: [
            {
              method: 'CN→US',
              originCountry: 'CN',
              destinationCountry: 'US',
              costCents: 100,
              minDays: 10,
              maxDays: 20,
            },
          ],
        }),
      ],
    });
    const result = classify(product);
    expect(result.variants[0]!.shipping).toBeNull();
    expect(result.classification).toBe('REVIEW_REQUIRED');
  });

  it('pide revisión si el origen es desconocido (inventario no informado)', () => {
    const result = classify(makeCatalogProduct({ variants: [makeVariant({ inventory: null })] }));
    expect(outcome(result, 'SHIPPING_ORIGIN')).toBe('REVIEW');
    expect(result.classification).toBe('REVIEW_REQUIRED');
  });
});

describe('classifyProduct — productos agotados', () => {
  it('rechaza si está agotado en las bodegas de EE. UU.', () => {
    const result = classify(
      makeCatalogProduct({ variants: [makeVariant({ inventory: usStock(0) })] }),
    );
    expect(outcome(result, 'AVAILABILITY')).toBe('REJECT');
    expect(result.classification).toBe('REJECTED');
  });

  it('rechaza con existencias por debajo del mínimo configurado', () => {
    const result = classify(
      makeCatalogProduct({
        variants: [makeVariant({ inventory: usStock(defaultRules.inventory.minStockUnits - 1) })],
      }),
    );
    expect(result.classification).toBe('REJECTED');
  });

  it('advierte inventario bajo sin rechazar', () => {
    const result = classify(
      makeCatalogProduct({ variants: [makeVariant({ inventory: usStock(15) })] }),
    );
    expect(result.classification).toBe('APPROVED');
    expect(result.warnings.join(' ')).toMatch(/inventario bajo/);
  });

  it('aprueba si al menos una variante es elegible y excluye las demás del borrador', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({ externalId: 'A', options: { Color: 'Negro' }, inventory: usStock(100) }),
        makeVariant({ externalId: 'B', options: { Color: 'Blanco' }, inventory: usStock(0) }),
      ],
    });
    const result = classify(product);
    expect(result.classification).toBe('APPROVED');
    expect(result.variants.map((v) => v.status)).toEqual(['ELIGIBLE', 'EXCLUDED']);
    expect(result.warnings.join(' ')).toMatch(/1 de 2 variantes no son elegibles/);
  });
});

describe('classifyProduct — tiempo de entrega', () => {
  it('rechaza si el plazo (tránsito + preparación) supera el máximo', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({
          shippingQuotes: [
            {
              method: 'Lento',
              originCountry: 'US',
              destinationCountry: 'US',
              costCents: 300,
              minDays: 5,
              maxDays: 7,
            },
          ],
        }),
      ],
    });
    const result = classify(product); // 7 + 2 = 9 > 8
    expect(outcome(result, 'DELIVERY_TIME')).toBe('REJECT');
    expect(result.classification).toBe('REJECTED');
  });

  it('pide revisión si el proveedor no informa plazo', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({
          shippingQuotes: [
            {
              method: 'X',
              originCountry: 'US',
              destinationCountry: 'US',
              costCents: 300,
              minDays: null,
              maxDays: null,
            },
          ],
        }),
      ],
    });
    expect(outcome(classify(product), 'DELIVERY_TIME')).toBe('REVIEW');
  });
});

describe('classifyProduct — margen', () => {
  it('pide revisión cuando el precio recomendado supera el techo y el margen queda entre mínimo y objetivo', () => {
    const result = classify(
      makeCatalogProduct({
        variants: [
          makeVariant({
            costCents: 4400,
            shippingQuotes: [
              {
                method: 'G',
                originCountry: 'US',
                destinationCountry: 'US',
                costCents: 950,
                minDays: 2,
                maxDays: 4,
              },
            ],
          }),
        ],
      }),
    );
    const variant = result.variants[0]!;
    expect(variant.recommendedPriceCents).toBe(8299);
    expect(variant.salePriceCents).toBe(7999);
    expect(variant.priceCapped).toBe(true);
    expect(variant.economics!.estimatedProfitMarginBp).toBe(1803);
    expect(outcome(result, 'PROFIT_MARGIN')).toBe('REVIEW');
    expect(result.classification).toBe('REVIEW_REQUIRED');
  });

  it('rechaza cuando ni con el precio techo se alcanza el margen mínimo', () => {
    const result = classify(
      makeCatalogProduct({
        variants: [
          makeVariant({
            costCents: 6800,
            shippingQuotes: [
              {
                method: 'G',
                originCountry: 'US',
                destinationCountry: 'US',
                costCents: 2490,
                minDays: 3,
                maxDays: 6,
              },
            ],
          }),
        ],
      }),
    );
    expect(outcome(result, 'PROFIT_MARGIN')).toBe('REJECT');
    expect(result.variants[0]!.economics!.estimatedProfitCents).toBeLessThan(0);
  });

  it('pide revisión si falta el costo de adquisición', () => {
    const result = classify(makeCatalogProduct({ variants: [makeVariant({ costCents: null })] }));
    expect(outcome(result, 'PROFIT_MARGIN')).toBe('REVIEW');
    expect(result.variants[0]!.economics).toBeNull();
  });

  it('usa el envío estimado configurado cuando no hay cotización, pero exige revisión', () => {
    const rules: EvaluationRules = {
      ...defaultRules,
      shipping: { ...defaultRules.shipping, fallbackShippingCostCents: 700 },
    };
    const result = classify(
      makeCatalogProduct({ variants: [makeVariant({ shippingQuotes: null })] }),
      rules,
    );
    expect(result.variants[0]!.shipping).toMatchObject({ isEstimate: true, costCents: 700 });
    expect(result.variants[0]!.status).toBe('REVIEW');
    expect(result.classification).toBe('REVIEW_REQUIRED');
  });

  it('advierte si el precio propuesto supera el PVP sugerido por el proveedor', () => {
    const result = classify(
      makeCatalogProduct({ variants: [makeVariant({ suggestedRetailCents: 2500 })] }),
    );
    expect(result.warnings.join(' ')).toMatch(/supera el PVP sugerido/);
  });
});

describe('classifyProduct — información incompleta, categoría y duplicados', () => {
  it('pide revisión con descripción, imágenes o peso faltantes', () => {
    const result = classify(
      makeCatalogProduct({
        description: null,
        images: [],
        variants: [makeVariant({ weightGrams: null })],
      }),
    );
    expect(outcome(result, 'DATA_COMPLETENESS')).toBe('REVIEW');
    expect(result.findings[0]!.detail).toMatch(/descripción.*imágenes.*peso/);
  });

  it('rechaza datos inválidos (p. ej. moneda no soportada)', () => {
    const result = classify(makeCatalogProduct({ currency: 'EUR' }));
    expect(outcome(result, 'DATA_COMPLETENESS')).toBe('REJECT');
    expect(result.classification).toBe('REJECTED');
  });

  it('rechaza categorías bloqueadas y pide revisión en categorías reguladas', () => {
    expect(
      outcome(
        classify(makeCatalogProduct({ category: 'Kitchen > Knives' })),
        'CATEGORY_RESTRICTION',
      ),
    ).toBe('REJECT');
    expect(
      outcome(
        classify(makeCatalogProduct({ name: 'Organizador para baby room' })),
        'CATEGORY_RESTRICTION',
      ),
    ).toBe('REVIEW');
    // Coincidencia por palabra completa: "knifeless" no coincide con "knife".
    expect(
      outcome(classify(makeCatalogProduct({ name: 'Knifeless cutter' })), 'CATEGORY_RESTRICTION'),
    ).toBe('PASS');
  });

  it('pide revisión ante riesgo de duplicado', () => {
    const duplicates: DuplicateMatch[] = [
      { productId: 'x', supplierId: 's', externalId: 'E', name: 'n', reason: 'SAME_BARCODE' },
    ];
    const result = classify(makeCatalogProduct(), defaultRules, duplicates);
    expect(outcome(result, 'DUPLICATE_RISK')).toBe('REVIEW');
    expect(result.classification).toBe('REVIEW_REQUIRED');
  });
});

describe('catálogo mock con las reglas por defecto', () => {
  it('cubre los tres resultados de clasificación', () => {
    const results = Object.fromEntries(
      MOCK_US_PRODUCTS.map((p) => {
        const n = normalizeSupplierProduct(p);
        const product = {
          ...n,
          id: p.externalId,
          variants: n.variants.map((v) => ({ ...v, id: v.externalId })),
          version: 1,
          firstSeenAt: new Date(),
          lastSyncedAt: new Date(),
        };
        return [p.externalId, classify(product).classification];
      }),
    );
    expect(results).toEqual({
      'MUS-1001': 'APPROVED',
      'MUS-1002': 'APPROVED',
      'MUS-1003': 'REJECTED',
      'MUS-1004': 'REJECTED',
      'MUS-1005': 'REVIEW_REQUIRED',
      'MUS-1006': 'REVIEW_REQUIRED',
      'MUS-1007': 'REJECTED',
      'MUS-1008': 'REJECTED',
      'MUS-1009': 'APPROVED', // sin contexto de duplicados; con el catálogo completo pasa a REVIEW_REQUIRED
      'MUS-1010': 'REVIEW_REQUIRED',
    });
  });
});
