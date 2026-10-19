import { describe, expect, it } from 'vitest';
import { DomainValidationError } from '../../src/domain/errors.js';
import {
  applyBasisPoints,
  centsToUsd,
  formatUsd,
  hasAtMostDecimals,
  percentToBasisPoints,
  usdToCents,
} from '../../src/domain/money.js';

describe('money', () => {
  it('convierte USD a centavos sin errores de coma flotante', () => {
    expect(usdToCents(19.99)).toBe(1999);
    expect(usdToCents(0.1) + usdToCents(0.2)).toBe(usdToCents(0.3));
    expect(usdToCents(1.005 - 0.005)).toBe(100);
    expect(usdToCents(4.35)).toBe(435); // 4.35 * 100 = 434.99999999999994 en coma flotante
    expect(usdToCents(0)).toBe(0);
  });

  it('convierte centavos a USD', () => {
    expect(centsToUsd(1999)).toBe(19.99);
    expect(centsToUsd(5)).toBe(0.05);
  });

  it('rechaza importes negativos, no finitos, con más de 2 decimales o excesivos', () => {
    expect(() => usdToCents(-1)).toThrow(DomainValidationError);
    expect(() => usdToCents(Number.NaN)).toThrow(DomainValidationError);
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(DomainValidationError);
    expect(() => usdToCents(1.234)).toThrow(/2 decimales/);
    expect(() => usdToCents(1_000_000.01)).toThrow(DomainValidationError);
  });

  it('convierte porcentajes a puntos básicos', () => {
    expect(percentToBasisPoints(30)).toBe(3000);
    expect(percentToBasisPoints(2.9)).toBe(290);
    expect(() => percentToBasisPoints(2.901)).toThrow(DomainValidationError);
  });

  it('aplica porcentajes redondeando al centavo', () => {
    expect(applyBasisPoints(2999, 290)).toBe(87); // 2.9 % de 29.99 = 0.86971
    expect(applyBasisPoints(1000, 1500)).toBe(150);
  });

  it('detecta cantidad de decimales y formatea importes', () => {
    expect(hasAtMostDecimals(10.25, 2)).toBe(true);
    expect(hasAtMostDecimals(10.255, 2)).toBe(false);
    expect(formatUsd(-1250)).toBe('-12.50 USD');
    expect(formatUsd(5)).toBe('0.05 USD');
  });
});
