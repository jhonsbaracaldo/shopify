import { describe, expect, it } from 'vitest';
import { DomainValidationError } from '../../../src/domain/errors.js';
import {
  ceilToPriceEnding,
  computeUnitEconomics,
  floorToPriceEnding,
  meetsProfitMargin,
  recommendSalePrice,
} from '../../../src/domain/profitability.js';
import type { EvaluationRules } from '../../../src/domain/rules.js';
import { defaultRules } from '../helpers.js';

const pricing = defaultRules.pricing;
const noEnding: EvaluationRules['pricing'] = { ...pricing, priceEndingCents: null };

describe('computeUnitEconomics', () => {
  it('desglosa todos los costos y separa contribución (antes de CAC) de beneficio estimado (después de CAC)', () => {
    // Reglas por defecto: pago 2.9 % + 0.30, devoluciones 3 %, plataforma 1 %, apps 0.25, CAC 6.00
    const e = computeUnitEconomics(2999, 980, 495, pricing);
    expect(e.landedCostCents).toBe(1475);
    expect(e.paymentFeeCents).toBe(87 + 30); // 2.9 % de 29.99 = 0.8697 → 0.87, más 0.30
    expect(e.returnsReserveCents).toBe(90);
    expect(e.otherVariableCosts).toEqual([
      { name: pricing.variableCosts[0]!.name, amountCents: 30 },
      { name: pricing.variableCosts[1]!.name, amountCents: 25 },
    ]);
    expect(e.totalVariableCostsCents).toBe(262);
    expect(e.contributionCents).toBe(1262);
    expect(e.contributionMarginBp).toBe(4208);
    expect(e.acquisitionCostCents).toBe(600);
    expect(e.estimatedProfitCents).toBe(662);
    expect(e.estimatedProfitMarginBp).toBe(2207);
  });

  it('admite pérdidas (beneficio negativo)', () => {
    const e = computeUnitEconomics(1000, 900, 300, pricing);
    expect(e.contributionCents).toBeLessThan(0);
    expect(e.estimatedProfitMarginBp).toBeLessThan(0);
  });

  it('rechaza precio cero (división por cero) e importes negativos', () => {
    expect(() => computeUnitEconomics(0, 100, 100, pricing)).toThrow(DomainValidationError);
    expect(() => computeUnitEconomics(1000, -1, 100, pricing)).toThrow(DomainValidationError);
  });
});

describe('recommendSalePrice', () => {
  it('calcula el precio mínimo que alcanza el margen objetivo después de todos los costos', () => {
    // Fórmula cerrada: (9.80 + 4.95 + 0.30 + 0.25 + 6.00) / (1 − 6.9 % − 20 %) = 29.138…
    // Con 29.13 los costos porcentuales redondeados al centavo (0.84 + 0.87 + 0.29) ya dan 20 %.
    const price = recommendSalePrice(980, 495, noEnding);
    expect(price).toBe(2913);
    expect(
      meetsProfitMargin(computeUnitEconomics(price, 980, 495, noEnding), noEnding.targetMarginBp),
    ).toBe(true);
    expect(
      meetsProfitMargin(
        computeUnitEconomics(price - 1, 980, 495, noEnding),
        noEnding.targetMarginBp,
      ),
    ).toBe(false);
  });

  it('aplica la terminación comercial (x.99) sin perder el margen', () => {
    const price = recommendSalePrice(980, 495, pricing);
    expect(price).toBe(2999);
    expect(
      meetsProfitMargin(computeUnitEconomics(price, 980, 495, pricing), pricing.targetMarginBp),
    ).toBe(true);
  });

  it('compensa los redondeos por componente al centavo en muchos casos', () => {
    for (let cost = 0; cost <= 20_000; cost += 137) {
      const price = recommendSalePrice(cost, 333, noEnding);
      expect(
        meetsProfitMargin(
          computeUnitEconomics(price, cost, 333, noEnding),
          noEnding.targetMarginBp,
        ),
      ).toBe(true);
      expect(
        meetsProfitMargin(
          computeUnitEconomics(price - 1, cost, 333, noEnding),
          noEnding.targetMarginBp,
        ),
      ).toBe(false);
    }
  });

  it('rechaza reglas inviables (costos % + margen ≥ 100 %)', () => {
    expect(() => recommendSalePrice(1000, 500, { ...pricing, targetMarginBp: 9400 })).toThrow(
      /inviables/,
    );
  });
});

describe('terminaciones de precio', () => {
  it('redondea hacia arriba y hacia abajo a x.99', () => {
    expect(ceilToPriceEnding(2143, 99)).toBe(2199);
    expect(ceilToPriceEnding(2199, 99)).toBe(2199);
    expect(ceilToPriceEnding(2100, 99)).toBe(2199);
    expect(floorToPriceEnding(8000, 99)).toBe(7999);
    expect(floorToPriceEnding(7999, 99)).toBe(7999);
    expect(floorToPriceEnding(7950, 99)).toBe(7899);
    expect(ceilToPriceEnding(2143, null)).toBe(2143);
  });
});
