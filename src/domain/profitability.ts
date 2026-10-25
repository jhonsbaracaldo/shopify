import { DomainValidationError } from './errors.js';
import {
  BASIS_POINTS_PER_UNIT,
  applyBasisPoints,
  assertCents,
  roundHalfAwayFromZero,
  type BasisPoints,
  type Cents,
} from './money.js';
import { totalPercentCostsBp, type EvaluationRules } from './rules.js';

/**
 * Motor de rentabilidad por unidad (Fase 2). Extiende el cálculo bruto de la Fase 1 con
 * costos variables configurables. TODO es una ESTIMACIÓN: no incluye impuestos sobre la renta,
 * costos fijos del negocio ni variaciones reales de comisiones; no es una ganancia neta definitiva.
 *
 *   costo puesto en destino = costo del producto + envío
 *   costos variables       = comisión de pago (% + fijo) + reserva de devoluciones (%) + otros
 *   contribución           = precio − costo puesto − costos variables          (antes de marketing)
 *   beneficio estimado     = contribución − CAC (costo de adquisición de cliente por unidad)
 */

export type PricingRules = EvaluationRules['pricing'];

export interface CostLine {
  name: string;
  amountCents: Cents;
}

export interface UnitEconomics {
  salePriceCents: Cents;
  productCostCents: Cents;
  shippingCostCents: Cents;
  landedCostCents: Cents;
  paymentFeeCents: Cents;
  returnsReserveCents: Cents;
  otherVariableCosts: CostLine[];
  totalVariableCostsCents: Cents;
  contributionCents: Cents;
  contributionMarginBp: BasisPoints;
  acquisitionCostCents: Cents;
  estimatedProfitCents: Cents;
  estimatedProfitMarginBp: BasisPoints;
}

function marginBp(amount: Cents, price: Cents): BasisPoints {
  return roundHalfAwayFromZero((amount * BASIS_POINTS_PER_UNIT) / price);
}

export function computeUnitEconomics(
  salePriceCents: Cents,
  productCostCents: Cents,
  shippingCostCents: Cents,
  rules: PricingRules,
): UnitEconomics {
  assertCents(salePriceCents, 'precio de venta');
  assertCents(productCostCents, 'costo del producto');
  assertCents(shippingCostCents, 'costo de envío');
  if (salePriceCents === 0) {
    throw new DomainValidationError('precio de venta: debe ser mayor que cero', [
      { path: 'salePrice', message: 'debe ser mayor que cero (evita división por cero)' },
    ]);
  }

  const landedCostCents = productCostCents + shippingCostCents;
  const paymentFeeCents =
    applyBasisPoints(salePriceCents, rules.paymentFeeBp) + rules.paymentFeeFixedCents;
  const returnsReserveCents = applyBasisPoints(salePriceCents, rules.returnsReserveBp);
  const otherVariableCosts = rules.variableCosts.map((cost) => ({
    name: cost.name,
    amountCents:
      cost.type === 'fixed' ? cost.amountCents : applyBasisPoints(salePriceCents, cost.basisPoints),
  }));
  const totalVariableCostsCents =
    paymentFeeCents +
    returnsReserveCents +
    otherVariableCosts.reduce((sum, line) => sum + line.amountCents, 0);

  const contributionCents = salePriceCents - landedCostCents - totalVariableCostsCents;
  const estimatedProfitCents = contributionCents - rules.acquisitionCostCents;

  return {
    salePriceCents,
    productCostCents,
    shippingCostCents,
    landedCostCents,
    paymentFeeCents,
    returnsReserveCents,
    otherVariableCosts,
    totalVariableCostsCents,
    contributionCents,
    contributionMarginBp: marginBp(contributionCents, salePriceCents),
    acquisitionCostCents: rules.acquisitionCostCents,
    estimatedProfitCents,
    estimatedProfitMarginBp: marginBp(estimatedProfitCents, salePriceCents),
  };
}

/** Comparación exacta (sin redondeo del margen mostrado). */
export function meetsProfitMargin(economics: UnitEconomics, targetBp: BasisPoints): boolean {
  return (
    economics.estimatedProfitCents * BASIS_POINTS_PER_UNIT >= targetBp * economics.salePriceCents
  );
}

/** Redondea HACIA ARRIBA a la terminación comercial (99 → 21.43 pasa a 21.99). */
export function ceilToPriceEnding(price: Cents, endingCents: number | null): Cents {
  if (endingCents === null) return price;
  const candidate = Math.floor(price / 100) * 100 + endingCents;
  return candidate >= price ? candidate : candidate + 100;
}

/** Redondea HACIA ABAJO a la terminación comercial (para aplicar un precio techo). */
export function floorToPriceEnding(price: Cents, endingCents: number | null): Cents {
  if (endingCents === null) return price;
  const candidate = Math.floor(price / 100) * 100 + endingCents;
  return candidate <= price ? candidate : candidate - 100;
}

export function assertFeasibleRules(rules: PricingRules): void {
  const percent = totalPercentCostsBp(rules) + rules.targetMarginBp;
  if (percent >= BASIS_POINTS_PER_UNIT) {
    throw new DomainValidationError(
      'Reglas inviables: los costos porcentuales más el margen objetivo alcanzan o superan el 100 %',
      [{ path: 'pricing', message: 'reduzca el margen objetivo o los costos porcentuales' }],
    );
  }
}

/**
 * Precio mínimo que alcanza el margen de beneficio objetivo después de todos los costos:
 *   P ≥ (costo puesto + costos fijos + CAC) / (1 − %costos − %margen)
 * Se ajusta al centavo por los redondeos de cada componente y luego a la terminación comercial.
 */
export function recommendSalePrice(
  productCostCents: Cents,
  shippingCostCents: Cents,
  rules: PricingRules,
): Cents {
  assertFeasibleRules(rules);
  const fixed =
    productCostCents +
    shippingCostCents +
    rules.paymentFeeFixedCents +
    rules.acquisitionCostCents +
    rules.variableCosts.reduce((sum, c) => sum + (c.type === 'fixed' ? c.amountCents : 0), 0);
  const divisor = BASIS_POINTS_PER_UNIT - totalPercentCostsBp(rules) - rules.targetMarginBp;

  const closedForm = Math.ceil((fixed * BASIS_POINTS_PER_UNIT) / divisor);
  const meets = (p: Cents) =>
    meetsProfitMargin(
      computeUnitEconomics(p, productCostCents, shippingCostCents, rules),
      rules.targetMarginBp,
    );
  // Los redondeos al centavo de cada costo porcentual desplazan el umbral unos pocos centavos:
  // se busca el primer precio que cumple empezando ligeramente por debajo de la fórmula cerrada.
  let price = Math.max(1, closedForm - 5);
  for (let i = 0; i < 200 && !meets(price); i += 1) price += 1;

  price = ceilToPriceEnding(price, rules.priceEndingCents);
  // Subir el precio aumenta el margen (1 − %costos > 0); se verifica de nuevo por los redondeos.
  const step = rules.priceEndingCents === null ? 1 : 100;
  for (let i = 0; i < 100 && !meets(price); i += 1) price += step;
  return price;
}
