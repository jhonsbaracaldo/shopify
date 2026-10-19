import { DomainValidationError } from './errors.js';
import {
  applyBasisPoints,
  assertCents,
  basisPointsToPercent,
  formatUsd,
  roundHalfAwayFromZero,
  BASIS_POINTS_PER_UNIT,
  type BasisPoints,
  type Cents,
} from './money.js';
import {
  assertTargetMargin,
  calculateGrossMargin,
  calculateGrossProfit,
  calculateMinimumPrice,
  calculateTotalCost,
  meetsTargetMargin,
} from './pricing.js';
import { assertValidProduct, isAvailable, type Product } from './product.js';

/** Costo adicional opcional (publicidad, comisiones, impuestos, reserva de devoluciones...). */
export type AdditionalCost =
  | { name: string; type: 'fixed'; amountCents: Cents }
  | { name: string; type: 'percent_of_price'; basisPoints: BasisPoints };

export interface EvaluationCriteria {
  targetMarginBp: BasisPoints;
  maxDeliveryDays: number;
  /** País de bodega exigido (ISO alfa-2) o `null` para no exigir ninguno. */
  requiredOriginCountry: string | null;
  /** Precio de venta a evaluar. Si se omite se usa el precio sugerido del producto. */
  salePriceCents?: Cents;
  additionalCosts: AdditionalCost[];
}

export type CheckRule =
  | 'MIN_GROSS_MARGIN'
  | 'AVAILABILITY'
  | 'DELIVERY_TIME'
  | 'WAREHOUSE_ORIGIN'
  | 'POSITIVE_NET_PROFIT';

export interface EligibilityCheck {
  rule: CheckRule;
  passed: boolean;
  detail: string;
}

export interface NetEstimate {
  additionalCostsCents: Cents;
  breakdown: { name: string; amountCents: Cents }[];
  netProfitCents: Cents;
  netMarginBp: BasisPoints;
}

export interface ProductEvaluation {
  sku: string;
  name: string;
  salePriceCents: Cents;
  priceSource: 'suggested' | 'override';
  productCostCents: Cents;
  shippingCostCents: Cents;
  totalCostCents: Cents;
  grossProfitCents: Cents;
  grossMarginBp: BasisPoints;
  targetMarginBp: BasisPoints;
  minimumPriceCents: Cents;
  /** `null` cuando no se proporcionaron costos adicionales: no se puede estimar la ganancia neta. */
  net: NetEstimate | null;
  checks: EligibilityCheck[];
  eligible: boolean;
  recommendation: string;
  warnings: string[];
  notes: string[];
}

function computeNet(
  salePrice: Cents,
  grossProfit: Cents,
  additionalCosts: AdditionalCost[],
): NetEstimate | null {
  if (additionalCosts.length === 0) return null;

  const breakdown = additionalCosts.map((cost) => {
    if (cost.type === 'fixed') {
      assertCents(cost.amountCents, `costo adicional "${cost.name}"`);
      return { name: cost.name, amountCents: cost.amountCents };
    }
    if (
      !Number.isInteger(cost.basisPoints) ||
      cost.basisPoints < 0 ||
      cost.basisPoints > BASIS_POINTS_PER_UNIT
    ) {
      throw new DomainValidationError(`costo adicional "${cost.name}": porcentaje no válido`, [
        { path: 'additionalCosts', message: 'el porcentaje debe estar entre 0 y 100' },
      ]);
    }
    return { name: cost.name, amountCents: applyBasisPoints(salePrice, cost.basisPoints) };
  });

  const additionalCostsCents = breakdown.reduce((sum, item) => sum + item.amountCents, 0);
  const netProfitCents = grossProfit - additionalCostsCents;
  const netMarginBp = roundHalfAwayFromZero((netProfitCents * BASIS_POINTS_PER_UNIT) / salePrice);
  return { additionalCostsCents, breakdown, netProfitCents, netMarginBp };
}

const pct = (bp: BasisPoints) => `${basisPointsToPercent(bp).toFixed(2)} %`;

/**
 * Evalúa preliminarmente un producto: costos, ganancia y margen brutos, precio mínimo
 * recomendado y reglas de elegibilidad (margen, disponibilidad, plazo y origen de bodega).
 */
export function evaluateProduct(product: Product, criteria: EvaluationCriteria): ProductEvaluation {
  assertValidProduct(product);
  assertTargetMargin(criteria.targetMarginBp);

  const priceSource = criteria.salePriceCents === undefined ? 'suggested' : 'override';
  const salePrice = criteria.salePriceCents ?? product.suggestedPriceCents;

  const totalCost = calculateTotalCost(product.productCostCents, product.shippingCostCents);
  const grossProfit = calculateGrossProfit(salePrice, totalCost);
  const grossMargin = calculateGrossMargin(salePrice, totalCost);
  const minimumPrice = calculateMinimumPrice(totalCost, criteria.targetMarginBp);
  const net = computeNet(salePrice, grossProfit, criteria.additionalCosts);

  const checks: EligibilityCheck[] = [];
  const warnings: string[] = [];

  const marginOk = meetsTargetMargin(salePrice, totalCost, criteria.targetMarginBp);
  checks.push({
    rule: 'MIN_GROSS_MARGIN',
    passed: marginOk,
    detail: `Margen bruto ${pct(grossMargin)} ${marginOk ? '≥' : '<'} objetivo ${pct(criteria.targetMarginBp)}`,
  });

  const available = isAvailable(product.availability);
  checks.push({
    rule: 'AVAILABILITY',
    passed: available,
    detail: available
      ? `Disponible (${product.availability.quantity} unidades, estado ${product.availability.status})`
      : 'Sin inventario disponible en el proveedor',
  });

  const deliveryOk = product.estimatedDelivery.maxDays <= criteria.maxDeliveryDays;
  checks.push({
    rule: 'DELIVERY_TIME',
    passed: deliveryOk,
    detail: `Entrega estimada ${product.estimatedDelivery.minDays}-${product.estimatedDelivery.maxDays} días; máximo permitido ${criteria.maxDeliveryDays}`,
  });

  if (criteria.requiredOriginCountry !== null) {
    const originOk = product.supplier.warehouseCountry === criteria.requiredOriginCountry;
    checks.push({
      rule: 'WAREHOUSE_ORIGIN',
      passed: originOk,
      detail: `Bodega en ${product.supplier.warehouseCountry}; se exige ${criteria.requiredOriginCountry}`,
    });
  }

  if (net !== null) {
    const netOk = net.netProfitCents > 0;
    checks.push({
      rule: 'POSITIVE_NET_PROFIT',
      passed: netOk,
      detail: `Ganancia neta estimada ${formatUsd(net.netProfitCents)} tras costos adicionales de ${formatUsd(net.additionalCostsCents)}`,
    });
  }

  if (!marginOk) {
    warnings.push(
      `Para alcanzar el margen objetivo el precio debería ser al menos ${formatUsd(minimumPrice)}`,
    );
  }
  if (grossProfit < 0) {
    warnings.push('El precio de venta no cubre el costo total: pérdida por unidad');
  }
  if (product.availability.status === 'low_stock' && available) {
    warnings.push('Inventario bajo en el proveedor: verificar antes de publicar');
  }

  const notes = [
    'La ganancia y el margen brutos solo descuentan costo del producto y envío.',
    net === null
      ? 'Ganancia neta no calculada: no se proporcionaron costos de publicidad, comisiones de Shopify o pasarela, impuestos ni devoluciones.'
      : 'La ganancia neta es una estimación limitada a los costos adicionales proporcionados.',
  ];

  const failed = checks.filter((c) => !c.passed);
  const eligible = failed.length === 0;
  const recommendation = eligible
    ? 'Elegible preliminarmente: cumple todas las reglas configuradas. Validar costos reales antes de publicar.'
    : `Descartar por ahora: no cumple ${failed.map((c) => c.rule).join(', ')}`;

  return {
    sku: product.sku,
    name: product.name,
    salePriceCents: salePrice,
    priceSource,
    productCostCents: product.productCostCents,
    shippingCostCents: product.shippingCostCents,
    totalCostCents: totalCost,
    grossProfitCents: grossProfit,
    grossMarginBp: grossMargin,
    targetMarginBp: criteria.targetMarginBp,
    minimumPriceCents: minimumPrice,
    net,
    checks,
    eligible,
    recommendation,
    warnings,
    notes,
  };
}
