import { describe, expect, it } from 'vitest';
import { DomainValidationError } from '../../src/domain/errors.js';
import {
  calculateGrossMargin,
  calculateGrossProfit,
  calculateMinimumPrice,
  calculateTotalCost,
  meetsTargetMargin,
} from '../../src/domain/pricing.js';

describe('calculateTotalCost', () => {
  it('suma costo del producto y costo de envío', () => {
    expect(calculateTotalCost(1000, 500)).toBe(1500);
    expect(calculateTotalCost(420, 395)).toBe(815);
  });

  it('admite costo de envío cero (envío gratis del proveedor)', () => {
    expect(calculateTotalCost(1000, 0)).toBe(1000);
  });

  it('rechaza costos negativos o no enteros', () => {
    expect(() => calculateTotalCost(-1, 500)).toThrow(DomainValidationError);
    expect(() => calculateTotalCost(1000, -500)).toThrow(DomainValidationError);
    expect(() => calculateTotalCost(10.5, 500)).toThrow(DomainValidationError);
  });
});

describe('calculateGrossProfit', () => {
  it('calcula la ganancia bruta positiva', () => {
    expect(calculateGrossProfit(3000, 1500)).toBe(1500);
  });

  it('devuelve ganancia negativa si el precio no cubre el costo', () => {
    expect(calculateGrossProfit(1000, 1500)).toBe(-500);
  });
});

describe('calculateGrossMargin', () => {
  it('calcula el margen bruto en puntos básicos', () => {
    expect(calculateGrossMargin(3000, 1500)).toBe(5000); // 50 %
    expect(calculateGrossMargin(1999, 815)).toBe(5923); // 59.23 %
  });

  it('devuelve 0 % cuando precio = costo y margen negativo en pérdida', () => {
    expect(calculateGrossMargin(1500, 1500)).toBe(0);
    expect(calculateGrossMargin(1000, 1500)).toBe(-5000);
  });

  it('devuelve 100 % cuando el costo es cero', () => {
    expect(calculateGrossMargin(1000, 0)).toBe(10000);
  });

  it('rechaza precio cero (división por cero)', () => {
    expect(() => calculateGrossMargin(0, 1500)).toThrow(/mayor que cero/);
  });
});

describe('calculateMinimumPrice', () => {
  it('calcula el precio mínimo para el margen objetivo', () => {
    expect(calculateMinimumPrice(1500, 5000)).toBe(3000); // 15 / (1 - 0.5)
    expect(calculateMinimumPrice(700, 3000)).toBe(1000); // 7 / 0.7
  });

  it('redondea hacia arriba al centavo para garantizar el margen', () => {
    const price = calculateMinimumPrice(1530, 3000); // 15.30 / 0.7 = 21.857...
    expect(price).toBe(2186);
    expect(meetsTargetMargin(price, 1530, 3000)).toBe(true);
    expect(meetsTargetMargin(price - 1, 1530, 3000)).toBe(false);
  });

  it('con margen 0 % el precio mínimo es el costo', () => {
    expect(calculateMinimumPrice(1500, 0)).toBe(1500);
  });

  it('acepta el margen máximo 99.99 % sin dividir por cero', () => {
    expect(calculateMinimumPrice(100, 9999)).toBe(1_000_000);
  });

  it('rechaza margen 100 %, negativo o no entero', () => {
    expect(() => calculateMinimumPrice(1500, 10000)).toThrow(DomainValidationError);
    expect(() => calculateMinimumPrice(1500, -1)).toThrow(DomainValidationError);
    expect(() => calculateMinimumPrice(1500, 30.5)).toThrow(DomainValidationError);
  });

  it('con costo cero el precio mínimo es cero', () => {
    expect(calculateMinimumPrice(0, 3000)).toBe(0);
  });
});

describe('meetsTargetMargin', () => {
  it('compara de forma exacta en el límite', () => {
    expect(meetsTargetMargin(1000, 700, 3000)).toBe(true); // exactamente 30 %
    expect(meetsTargetMargin(999, 700, 3000)).toBe(false); // 29.93 %
  });

  it('no se deja engañar por el redondeo del margen mostrado', () => {
    // 29.996 % se muestra como 30.00 %, pero no alcanza el 30 % exacto
    const price = 250_000;
    const cost = 175_010;
    expect(calculateGrossMargin(price, cost)).toBe(3000);
    expect(meetsTargetMargin(price, cost, 3000)).toBe(false);
  });
});
