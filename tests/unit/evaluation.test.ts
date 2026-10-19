import { describe, expect, it } from 'vitest';
import { evaluateProduct } from '../../src/domain/evaluation.js';
import { DomainValidationError } from '../../src/domain/errors.js';
import type { Product } from '../../src/domain/product.js';
import { makeCriteria, makeProduct } from '../fixtures.js';

const failedRules = (product: Product, criteria = makeCriteria()) =>
  evaluateProduct(product, criteria)
    .checks.filter((c) => !c.passed)
    .map((c) => c.rule);

describe('evaluateProduct — producto rentable', () => {
  const result = evaluateProduct(makeProduct(), makeCriteria());

  it('calcula costos, ganancia y margen brutos', () => {
    expect(result.totalCostCents).toBe(1500);
    expect(result.grossProfitCents).toBe(1500);
    expect(result.grossMarginBp).toBe(5000);
    expect(result.minimumPriceCents).toBe(2143); // 15 / 0.7 = 21.4285… → 21.43
    expect(result.priceSource).toBe('suggested');
  });

  it('es elegible y sin advertencias', () => {
    expect(result.eligible).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.recommendation).toMatch(/^Elegible/);
  });

  it('no calcula ganancia neta si no se dan costos adicionales', () => {
    expect(result.net).toBeNull();
    expect(result.notes.join(' ')).toMatch(/Ganancia neta no calculada/);
  });
});

describe('evaluateProduct — productos no rentables o no elegibles', () => {
  it('descarta por margen insuficiente y sugiere precio mínimo', () => {
    const result = evaluateProduct(makeProduct({ suggestedPriceCents: 2000 }), makeCriteria());
    expect(result.grossMarginBp).toBe(2500);
    expect(result.eligible).toBe(false);
    expect(failedRules(makeProduct({ suggestedPriceCents: 2000 }))).toEqual(['MIN_GROSS_MARGIN']);
    expect(result.warnings[0]).toContain('21.43 USD');
  });

  it('marca pérdida cuando el precio no cubre el costo', () => {
    const result = evaluateProduct(makeProduct({ suggestedPriceCents: 1200 }), makeCriteria());
    expect(result.grossProfitCents).toBe(-300);
    expect(result.grossMarginBp).toBe(-2500);
    expect(result.warnings).toContain(
      'El precio de venta no cubre el costo total: pérdida por unidad',
    );
  });

  it('descarta si no hay inventario', () => {
    const product = makeProduct({ availability: { status: 'out_of_stock', quantity: 0 } });
    expect(failedRules(product)).toEqual(['AVAILABILITY']);
  });

  it('descarta si la cantidad es 0 aunque el estado diga in_stock', () => {
    const product = makeProduct({ availability: { status: 'in_stock', quantity: 0 } });
    expect(failedRules(product)).toEqual(['AVAILABILITY']);
  });

  it('advierte con inventario bajo pero no descarta', () => {
    const result = evaluateProduct(
      makeProduct({ availability: { status: 'low_stock', quantity: 5 } }),
      makeCriteria(),
    );
    expect(result.eligible).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Inventario bajo/);
  });

  it('descarta si la entrega supera el máximo y acepta el límite exacto', () => {
    expect(failedRules(makeProduct({ estimatedDelivery: { minDays: 6, maxDays: 10 } }))).toEqual([
      'DELIVERY_TIME',
    ]);
    expect(failedRules(makeProduct({ estimatedDelivery: { minDays: 5, maxDays: 7 } }))).toEqual([]);
  });

  it('descarta si la bodega no está en el país exigido y permite desactivar la regla', () => {
    const product = makeProduct({
      supplier: { id: 's', name: 'Proveedor CN', warehouseCountry: 'CN' },
    });
    expect(failedRules(product)).toEqual(['WAREHOUSE_ORIGIN']);
    expect(failedRules(product, makeCriteria({ requiredOriginCountry: null }))).toEqual([]);
  });

  it('acumula varios motivos de descarte', () => {
    const product = makeProduct({
      suggestedPriceCents: 1600,
      availability: { status: 'out_of_stock', quantity: 0 },
      estimatedDelivery: { minDays: 10, maxDays: 15 },
    });
    const result = evaluateProduct(product, makeCriteria());
    expect(result.recommendation).toContain('MIN_GROSS_MARGIN, AVAILABILITY, DELIVERY_TIME');
  });
});

describe('evaluateProduct — parámetros', () => {
  it('usa el precio de venta indicado en lugar del sugerido', () => {
    const result = evaluateProduct(makeProduct(), makeCriteria({ salePriceCents: 2500 }));
    expect(result.priceSource).toBe('override');
    expect(result.salePriceCents).toBe(2500);
    expect(result.grossMarginBp).toBe(4000);
  });

  it('calcula la ganancia neta solo con los costos adicionales proporcionados', () => {
    const result = evaluateProduct(
      makeProduct(),
      makeCriteria({
        additionalCosts: [
          { name: 'Comisión de pago', type: 'percent_of_price', basisPoints: 290 },
          { name: 'Publicidad por unidad', type: 'fixed', amountCents: 800 },
        ],
      }),
    );
    expect(result.net).toEqual({
      additionalCostsCents: 887,
      breakdown: [
        { name: 'Comisión de pago', amountCents: 87 },
        { name: 'Publicidad por unidad', amountCents: 800 },
      ],
      netProfitCents: 613,
      netMarginBp: 2043,
    });
    // El margen bruto no cambia por los costos adicionales.
    expect(result.grossMarginBp).toBe(5000);
    expect(result.checks.find((c) => c.rule === 'POSITIVE_NET_PROFIT')?.passed).toBe(true);
  });

  it('descarta si la ganancia neta estimada no es positiva', () => {
    const result = evaluateProduct(
      makeProduct(),
      makeCriteria({ additionalCosts: [{ name: 'Publicidad', type: 'fixed', amountCents: 1500 }] }),
    );
    expect(result.net?.netProfitCents).toBe(0);
    expect(result.eligible).toBe(false);
  });

  it('margen objetivo 0 % acepta cualquier precio que cubra el costo', () => {
    const product = makeProduct({ suggestedPriceCents: 1500 });
    expect(evaluateProduct(product, makeCriteria({ targetMarginBp: 0 })).eligible).toBe(true);
  });
});

describe('evaluateProduct — datos inválidos', () => {
  it('rechaza costos negativos', () => {
    expect(() => evaluateProduct(makeProduct({ productCostCents: -100 }), makeCriteria())).toThrow(
      DomainValidationError,
    );
  });

  it('rechaza precio sugerido cero', () => {
    try {
      evaluateProduct(makeProduct({ suggestedPriceCents: 0 }), makeCriteria());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      expect((error as DomainValidationError).issues).toContainEqual({
        path: 'suggestedPrice',
        message: 'debe ser mayor que cero',
      });
    }
  });

  it('rechaza precio de venta cero indicado como parámetro', () => {
    expect(() => evaluateProduct(makeProduct(), makeCriteria({ salePriceCents: 0 }))).toThrow(
      DomainValidationError,
    );
  });

  it('rechaza campos obligatorios vacíos y rango de entrega invertido', () => {
    try {
      evaluateProduct(
        makeProduct({ sku: '  ', name: '', estimatedDelivery: { minDays: 8, maxDays: 3 } }),
        makeCriteria(),
      );
      expect.unreachable();
    } catch (error) {
      const paths = (error as DomainValidationError).issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['sku', 'name', 'estimatedDelivery']));
    }
  });

  it('rechaza moneda distinta de USD', () => {
    const product = { ...makeProduct(), currency: 'COP' } as unknown as Product;
    expect(() => evaluateProduct(product, makeCriteria())).toThrow(DomainValidationError);
  });

  it('rechaza margen objetivo de 100 % (división por cero)', () => {
    expect(() => evaluateProduct(makeProduct(), makeCriteria({ targetMarginBp: 10000 }))).toThrow(
      DomainValidationError,
    );
  });

  it('rechaza porcentajes adicionales fuera de rango', () => {
    expect(() =>
      evaluateProduct(
        makeProduct(),
        makeCriteria({
          additionalCosts: [{ name: 'x', type: 'percent_of_price', basisPoints: 10001 }],
        }),
      ),
    ).toThrow(DomainValidationError);
  });
});
