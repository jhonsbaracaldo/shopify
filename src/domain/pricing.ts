import { DomainValidationError } from './errors.js';
import {
  BASIS_POINTS_PER_UNIT,
  assertCents,
  roundHalfAwayFromZero,
  type BasisPoints,
  type Cents,
} from './money.js';

/**
 * Reglas de precios. Todas trabajan con centavos enteros y puntos básicos enteros,
 * de modo que los resultados son exactos y reproducibles.
 *
 * Importante: aquí solo se calcula la ganancia y el margen BRUTOS:
 *   ganancia bruta = precio de venta − (costo del producto + costo de envío)
 * No incluyen publicidad, impuestos, devoluciones ni comisiones de Shopify/pasarela.
 */

/** Margen objetivo máximo admitido: 99,99 %. Un margen del 100 % implicaría dividir por cero. */
export const MAX_TARGET_MARGIN_BP: BasisPoints = BASIS_POINTS_PER_UNIT - 1;

function assertPositivePrice(salePrice: Cents): void {
  assertCents(salePrice, 'precio de venta');
  if (salePrice === 0) {
    throw new DomainValidationError('precio de venta: debe ser mayor que cero', [
      { path: 'salePrice', message: 'debe ser mayor que cero (evita división por cero)' },
    ]);
  }
}

export function assertTargetMargin(targetMargin: BasisPoints): void {
  if (!Number.isInteger(targetMargin) || targetMargin < 0 || targetMargin > MAX_TARGET_MARGIN_BP) {
    throw new DomainValidationError('margen objetivo: debe estar entre 0 % y 99,99 %', [
      { path: 'targetMarginPercent', message: 'debe estar entre 0 y 99.99' },
    ]);
  }
}

/** Costo total de adquisición por unidad = costo del producto + costo de envío. */
export function calculateTotalCost(productCost: Cents, shippingCost: Cents): Cents {
  assertCents(productCost, 'costo del producto');
  assertCents(shippingCost, 'costo de envío');
  return productCost + shippingCost;
}

/** Ganancia bruta por unidad. Puede ser negativa si el precio no cubre el costo. */
export function calculateGrossProfit(salePrice: Cents, totalCost: Cents): Cents {
  assertCents(salePrice, 'precio de venta');
  assertCents(totalCost, 'costo total');
  return salePrice - totalCost;
}

/**
 * Margen bruto sobre el precio de venta, en puntos básicos (redondeado al punto básico).
 * margen = (precio − costo) / precio
 */
export function calculateGrossMargin(salePrice: Cents, totalCost: Cents): BasisPoints {
  assertPositivePrice(salePrice);
  const profit = calculateGrossProfit(salePrice, totalCost);
  return roundHalfAwayFromZero((profit * BASIS_POINTS_PER_UNIT) / salePrice);
}

/**
 * Comparación exacta (sin redondeos) de si el precio alcanza el margen objetivo:
 *   (precio − costo) / precio ≥ objetivo  ⇔  (precio − costo) · 10000 ≥ objetivo · precio
 */
export function meetsTargetMargin(
  salePrice: Cents,
  totalCost: Cents,
  targetMargin: BasisPoints,
): boolean {
  assertPositivePrice(salePrice);
  assertTargetMargin(targetMargin);
  const profit = calculateGrossProfit(salePrice, totalCost);
  return profit * BASIS_POINTS_PER_UNIT >= targetMargin * salePrice;
}

/**
 * Precio mínimo para alcanzar el margen objetivo:
 *   precio = costo / (1 − margen)
 * Se redondea HACIA ARRIBA al centavo para garantizar que el margen se cumpla.
 */
export function calculateMinimumPrice(totalCost: Cents, targetMargin: BasisPoints): Cents {
  assertCents(totalCost, 'costo total');
  assertTargetMargin(targetMargin);
  const divisor = BASIS_POINTS_PER_UNIT - targetMargin; // > 0 garantizado por assertTargetMargin
  return Math.ceil((totalCost * BASIS_POINTS_PER_UNIT) / divisor);
}
