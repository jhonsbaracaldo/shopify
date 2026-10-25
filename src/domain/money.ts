import { DomainValidationError } from './errors.js';

/**
 * Los importes se manejan internamente como centavos enteros de USD.
 * Así se evitan los errores de coma flotante (p. ej. 0.1 + 0.2 !== 0.3).
 * Los porcentajes se manejan como puntos básicos enteros (1 % = 100 pb).
 */
export type Cents = number;
export type BasisPoints = number;

export const CURRENCY = 'USD' as const;
export type Currency = typeof CURRENCY;

/** Tope de seguridad: 1.000.000 USD. Mantiene los cálculos muy por debajo de Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT_CENTS: Cents = 100_000_000;
export const BASIS_POINTS_PER_UNIT = 10_000;

const DECIMAL_TOLERANCE = 1e-6;

function invalid(field: string, message: string): never {
  throw new DomainValidationError(`${field}: ${message}`, [{ path: field, message }]);
}

/** Indica si un número decimal tiene como máximo `decimals` cifras decimales. */
export function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < DECIMAL_TOLERANCE;
}

/** Convierte un importe en USD (máx. 2 decimales, no negativo) a centavos enteros. */
export function usdToCents(amount: number, field = 'importe'): Cents {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    invalid(field, 'debe ser un número finito');
  }
  if (amount < 0) invalid(field, 'no puede ser negativo');
  if (!hasAtMostDecimals(amount, 2)) invalid(field, 'admite como máximo 2 decimales');
  const cents = Math.round(amount * 100);
  assertCents(cents, field);
  return cents;
}

/** Convierte centavos enteros a USD. Al ser enteros, el resultado siempre tiene ≤ 2 decimales. */
export function centsToUsd(cents: Cents): number {
  return cents / 100;
}

/** Valida que el valor sea un importe en centavos: entero, no negativo y dentro del tope. */
export function assertCents(value: Cents, field = 'importe'): void {
  if (!Number.isSafeInteger(value)) invalid(field, 'debe ser un número entero de centavos');
  if (value < 0) invalid(field, 'no puede ser negativo');
  if (value > MAX_AMOUNT_CENTS)
    invalid(field, `no puede superar ${centsToUsd(MAX_AMOUNT_CENTS)} USD`);
}

/** Convierte un porcentaje (máx. 2 decimales) a puntos básicos enteros. */
export function percentToBasisPoints(percent: number, field = 'porcentaje'): BasisPoints {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    invalid(field, 'debe ser un número finito');
  }
  if (!hasAtMostDecimals(percent, 2)) invalid(field, 'admite como máximo 2 decimales');
  return Math.round(percent * 100);
}

export function basisPointsToPercent(bp: BasisPoints): number {
  return bp / 100;
}

/** Redondeo "mitad lejos de cero", simétrico para valores negativos. */
export function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Calcula un porcentaje (en puntos básicos) de un importe, redondeado al centavo. */
export function applyBasisPoints(amount: Cents, bp: BasisPoints): Cents {
  return roundHalfAwayFromZero((amount * bp) / BASIS_POINTS_PER_UNIT);
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)} USD`;
}
