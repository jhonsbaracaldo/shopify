import type { BasisPoints, Cents } from './money.js';

/** Costo variable configurable: fijo por unidad o porcentaje del precio de venta. */
export type VariableCostRule =
  | { name: string; type: 'fixed'; amountCents: Cents }
  | { name: string; type: 'percent_of_price'; basisPoints: BasisPoints };

/**
 * Reglas de evaluación en unidades del dominio (centavos y puntos básicos).
 * Se cargan desde un archivo JSON (ver `config/evaluation-rules.json`), no desde el código.
 */
export interface EvaluationRules {
  version: string;
  /** Hash del contenido de las reglas: permite saber con qué reglas se hizo cada evaluación. */
  hash: string;
  pricing: {
    /** Margen de beneficio estimado (después de CAC) con el que se calcula el precio recomendado. */
    targetMarginBp: BasisPoints;
    /** Margen mínimo aceptable cuando el precio queda limitado por el precio máximo. */
    minMarginBp: BasisPoints;
    paymentFeeBp: BasisPoints;
    paymentFeeFixedCents: Cents;
    returnsReserveBp: BasisPoints;
    /** Costo estimado de adquisición de cliente (CAC) por unidad vendida. */
    acquisitionCostCents: Cents;
    variableCosts: VariableCostRule[];
    /** Terminación del precio en centavos (p. ej. 99 → x.99). `null` = sin redondeo comercial. */
    priceEndingCents: number | null;
    /** Precio de venta máximo aceptable (techo competitivo). `null` = sin techo. */
    maxRetailPriceCents: Cents | null;
  };
  shipping: {
    destinationCountry: string;
    allowedOriginCountries: string[];
    /** Días de preparación que se suman al tránsito informado por el proveedor. */
    handlingDays: number;
    maxDeliveryDays: number;
    /** Envío estimado cuando el proveedor no cotiza. `null` = sin estimación (requiere revisión). */
    fallbackShippingCostCents: Cents | null;
  };
  inventory: {
    minStockUnits: number;
    lowStockUnits: number;
  };
  categories: {
    blockedKeywords: string[];
    reviewKeywords: string[];
  };
  completeness: {
    requireDescription: boolean;
    minImages: number;
    requireWeight: boolean;
  };
}

/** Suma de todos los costos expresados como porcentaje del precio. */
export function totalPercentCostsBp(pricing: EvaluationRules['pricing']): BasisPoints {
  return (
    pricing.paymentFeeBp +
    pricing.returnsReserveBp +
    pricing.variableCosts.reduce(
      (sum, c) => sum + (c.type === 'percent_of_price' ? c.basisPoints : 0),
      0,
    )
  );
}
