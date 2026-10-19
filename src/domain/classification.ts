import { stockInCountries, type CatalogProduct, type CatalogVariant } from './catalog.js';
import { basisPointsToPercent, formatUsd, type BasisPoints, type Cents } from './money.js';
import {
  computeUnitEconomics,
  floorToPriceEnding,
  meetsProfitMargin,
  recommendSalePrice,
  type UnitEconomics,
} from './profitability.js';
import type { EvaluationRules } from './rules.js';
import { normalizeForMatching } from './text.js';

/**
 * Clasificación AUTOMÁTICA del motor. `APPROVED` significa "cumple las reglas configuradas";
 * NO es una autorización para publicar: la publicación exige una aprobación humana aparte.
 */
export const CLASSIFICATIONS = ['APPROVED', 'REVIEW_REQUIRED', 'REJECTED'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export type RuleOutcome = 'PASS' | 'REVIEW' | 'REJECT' | 'SKIPPED';

export type ClassificationRule =
  | 'DATA_COMPLETENESS'
  | 'CATEGORY_RESTRICTION'
  | 'SHIPPING_ORIGIN'
  | 'AVAILABILITY'
  | 'DELIVERY_TIME'
  | 'PROFIT_MARGIN'
  | 'DUPLICATE_RISK';

export interface Finding {
  rule: ClassificationRule;
  outcome: RuleOutcome;
  detail: string;
}

export interface DuplicateMatch {
  productId: string;
  supplierId: string;
  externalId: string;
  name: string;
  reason: 'SAME_NAME_FINGERPRINT' | 'SAME_BARCODE' | 'SAME_SKU';
}

export type VariantStatus = 'ELIGIBLE' | 'REVIEW' | 'EXCLUDED';

export interface SelectedShipping {
  method: string;
  originCountry: string;
  costCents: Cents;
  /** true si es la estimación configurada y no una cotización del proveedor. */
  isEstimate: boolean;
  /** Días totales (preparación + tránsito); `null` si el plazo es desconocido. */
  deliveryDays: { min: number; max: number } | null;
}

export interface VariantEvaluation {
  variantId: string;
  externalId: string;
  sku: string | null;
  options: Record<string, string>;
  status: VariantStatus;
  reasons: string[];
  originStockUnits: number | null;
  shipping: SelectedShipping | null;
  recommendedPriceCents: Cents | null;
  /** Precio propuesto: el recomendado, o el techo configurado si el recomendado lo supera. */
  salePriceCents: Cents | null;
  priceCapped: boolean;
  economics: UnitEconomics | null;
}

export interface ProductEvaluationResult {
  productId: string;
  productContentHash: string;
  rulesVersion: string;
  rulesHash: string;
  classification: Classification;
  findings: Finding[];
  variants: VariantEvaluation[];
  summary: {
    eligibleVariants: number;
    reviewVariants: number;
    excludedVariants: number;
    priceRangeCents: { min: Cents; max: Cents } | null;
    minEstimatedProfitMarginBp: BasisPoints | null;
  };
  warnings: string[];
  notes: string[];
}

type Check = boolean | null; // null = desconocido

interface VariantChecks {
  origin: Check;
  stock: Check;
  delivery: Check;
  margin: 'PASS' | 'REVIEW' | 'REJECT' | null;
}

const pct = (bp: number) => `${basisPointsToPercent(bp).toFixed(2)} %`;

function matchKeyword(text: string, keywords: string[]): string | null {
  const haystack = ` ${normalizeForMatching(text)} `;
  for (const keyword of keywords) {
    const needle = normalizeForMatching(keyword);
    if (needle && haystack.includes(` ${needle} `)) return keyword;
  }
  return null;
}

function selectShipping(
  variant: CatalogVariant,
  rules: EvaluationRules['shipping'],
): { shipping: SelectedShipping | null; reason: string | null } {
  const quotes = (variant.shippingQuotes ?? []).filter(
    (q) =>
      rules.allowedOriginCountries.includes(q.originCountry) &&
      q.destinationCountry === rules.destinationCountry,
  );

  if (quotes.length === 0) {
    if (rules.fallbackShippingCostCents !== null) {
      return {
        shipping: {
          method: 'Estimación configurada (sin cotización del proveedor)',
          originCountry: rules.allowedOriginCountries[0] ?? 'US',
          costCents: rules.fallbackShippingCostCents,
          isEstimate: true,
          deliveryDays: null,
        },
        reason: 'envío estimado con valor configurado: confirmar con el proveedor',
      };
    }
    return { shipping: null, reason: 'sin cotización de envío desde el origen permitido' };
  }

  const withDays = quotes
    .filter((q) => q.maxDays !== null)
    .map((q) => ({
      quote: q,
      min: (q.minDays ?? q.maxDays ?? 0) + rules.handlingDays,
      max: (q.maxDays ?? 0) + rules.handlingDays,
    }));

  if (withDays.length === 0) {
    const cheapest = [...quotes].sort((a, b) => a.costCents - b.costCents)[0]!;
    return {
      shipping: {
        method: cheapest.method,
        originCountry: cheapest.originCountry,
        costCents: cheapest.costCents,
        isEstimate: false,
        deliveryDays: null,
      },
      reason: 'el proveedor no informa el plazo de entrega',
    };
  }

  const inTime = withDays.filter((q) => q.max <= rules.maxDeliveryDays);
  const pool = inTime.length > 0 ? inTime : withDays;
  // Dentro del plazo: el más barato. Si ninguno cumple: el más rápido (para informar).
  const chosen = [...pool].sort((a, b) =>
    inTime.length > 0 ? a.quote.costCents - b.quote.costCents : a.max - b.max,
  )[0]!;
  return {
    shipping: {
      method: chosen.quote.method,
      originCountry: chosen.quote.originCountry,
      costCents: chosen.quote.costCents,
      isEstimate: false,
      deliveryDays: { min: chosen.min, max: chosen.max },
    },
    reason: null,
  };
}

function evaluateVariant(
  variant: CatalogVariant,
  rules: EvaluationRules,
  warnings: string[],
): { evaluation: VariantEvaluation; checks: VariantChecks } {
  const reasons: string[] = [];
  const origins = rules.shipping.allowedOriginCountries;
  const label = variant.sku ?? variant.externalId;

  // Origen: el país de la BODEGA con existencias, nunca el país del proveedor.
  let origin: Check;
  if (variant.inventory === null) {
    origin = null;
    reasons.push('inventario por bodega desconocido');
  } else {
    origin = variant.inventory.some(
      (s) => s.countryCode !== null && origins.includes(s.countryCode),
    );
    if (!origin) reasons.push(`sin bodega en ${origins.join('/')}`);
  }

  const originStockUnits = stockInCountries(variant, origins);
  let stock: Check;
  if (origin === false) stock = false;
  else if (originStockUnits === null) {
    stock = null;
    if (origin === true) reasons.push('cantidad en bodega de origen desconocida');
  } else {
    stock = originStockUnits >= rules.inventory.minStockUnits;
    if (!stock) {
      reasons.push(
        originStockUnits === 0
          ? 'agotado en bodegas de origen permitido'
          : `existencias (${originStockUnits}) por debajo del mínimo (${rules.inventory.minStockUnits})`,
      );
    } else if (originStockUnits < rules.inventory.lowStockUnits) {
      warnings.push(`Variante ${label}: inventario bajo (${originStockUnits} unidades)`);
    }
  }

  const { shipping, reason: shippingReason } = selectShipping(variant, rules.shipping);
  if (shippingReason) reasons.push(shippingReason);
  let delivery: Check;
  if (shipping?.deliveryDays) {
    delivery = shipping.deliveryDays.max <= rules.shipping.maxDeliveryDays;
    if (!delivery) {
      reasons.push(
        `entrega estimada ${shipping.deliveryDays.max} días > máximo ${rules.shipping.maxDeliveryDays}`,
      );
    }
  } else {
    delivery = null;
  }

  let recommendedPriceCents: Cents | null = null;
  let salePriceCents: Cents | null = null;
  let priceCapped = false;
  let economics: UnitEconomics | null = null;
  let margin: VariantChecks['margin'] = null;

  if (variant.costCents === null) {
    reasons.push('sin costo de adquisición');
  } else if (shipping !== null) {
    const pricing = rules.pricing;
    recommendedPriceCents = recommendSalePrice(variant.costCents, shipping.costCents, pricing);
    salePriceCents = recommendedPriceCents;
    if (
      pricing.maxRetailPriceCents !== null &&
      recommendedPriceCents > pricing.maxRetailPriceCents
    ) {
      salePriceCents = Math.max(
        1,
        floorToPriceEnding(pricing.maxRetailPriceCents, pricing.priceEndingCents),
      );
      priceCapped = true;
    }
    economics = computeUnitEconomics(
      salePriceCents,
      variant.costCents,
      shipping.costCents,
      pricing,
    );

    if (!priceCapped) {
      margin = 'PASS';
    } else if (meetsProfitMargin(economics, pricing.minMarginBp)) {
      margin = 'REVIEW';
      reasons.push(
        `precio recomendado ${formatUsd(recommendedPriceCents)} supera el techo; con ${formatUsd(salePriceCents)} el margen es ${pct(economics.estimatedProfitMarginBp)} (entre mínimo y objetivo)`,
      );
    } else {
      margin = 'REJECT';
      reasons.push(
        `con el precio techo ${formatUsd(salePriceCents)} el margen estimado ${pct(economics.estimatedProfitMarginBp)} es menor que el mínimo ${pct(pricing.minMarginBp)}`,
      );
    }

    if (variant.suggestedRetailCents !== null && salePriceCents > variant.suggestedRetailCents) {
      warnings.push(
        `Variante ${label}: precio propuesto ${formatUsd(salePriceCents)} supera el PVP sugerido por el proveedor (${formatUsd(variant.suggestedRetailCents)}); validar competitividad`,
      );
    }
  }

  const checks: VariantChecks = { origin, stock, delivery, margin };
  const values = [origin, stock, delivery];
  const status: VariantStatus =
    values.includes(false) || margin === 'REJECT'
      ? 'EXCLUDED'
      : values.includes(null) || margin === null || margin === 'REVIEW' || shipping?.isEstimate
        ? 'REVIEW'
        : 'ELIGIBLE';

  return {
    evaluation: {
      variantId: variant.id,
      externalId: variant.externalId,
      sku: variant.sku,
      options: variant.options,
      status,
      reasons,
      originStockUnits,
      shipping,
      recommendedPriceCents,
      salePriceCents,
      priceCapped,
      economics,
    },
    checks,
  };
}

function aggregate(values: Check[], labels: { pass: string; review: string; reject: string }) {
  if (values.length === 0)
    return {
      outcome: 'SKIPPED' as const,
      detail: 'no evaluable: ninguna variante llegó a esta regla',
    };
  if (values.includes(true)) return { outcome: 'PASS' as const, detail: labels.pass };
  if (values.includes(null)) return { outcome: 'REVIEW' as const, detail: labels.review };
  return { outcome: 'REJECT' as const, detail: labels.reject };
}

export interface ClassificationContext {
  duplicates: DuplicateMatch[];
}

/** Evalúa un producto normalizado contra las reglas configuradas. Función pura. */
export function classifyProduct(
  product: CatalogProduct,
  rules: EvaluationRules,
  context: ClassificationContext,
): ProductEvaluationResult {
  const warnings: string[] = [];
  const findings: Finding[] = [];
  const results = product.variants.map((v) => evaluateVariant(v, rules, warnings));
  const variants = results.map((r) => r.evaluation);
  const checks = results.map((r) => r.checks);

  // 1. Calidad e integridad de los datos.
  const errors = product.validation.issues.filter((i) => i.severity === 'error');
  const missing: string[] = [];
  if (rules.completeness.requireDescription && !product.description) missing.push('descripción');
  if (product.images.length < rules.completeness.minImages) {
    missing.push(`imágenes (mínimo ${rules.completeness.minImages})`);
  }
  if (rules.completeness.requireWeight && product.variants.some((v) => v.weightGrams === null)) {
    missing.push('peso de variantes');
  }
  if (product.validation.status === 'INVALID') {
    findings.push({
      rule: 'DATA_COMPLETENESS',
      outcome: 'REJECT',
      detail: `datos inválidos: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    });
  } else if (missing.length > 0) {
    findings.push({
      rule: 'DATA_COMPLETENESS',
      outcome: 'REVIEW',
      detail: `información incompleta: ${missing.join(', ')}`,
    });
  } else {
    findings.push({ rule: 'DATA_COMPLETENESS', outcome: 'PASS', detail: 'datos completos' });
  }

  // 2. Restricciones de categoría (palabras clave configurables sobre categoría y nombre).
  const text = `${product.category ?? ''} ${product.name}`;
  const blocked = matchKeyword(text, rules.categories.blockedKeywords);
  const review = blocked ? null : matchKeyword(text, rules.categories.reviewKeywords);
  findings.push(
    blocked
      ? {
          rule: 'CATEGORY_RESTRICTION',
          outcome: 'REJECT',
          detail: `categoría bloqueada (coincide con "${blocked}")`,
        }
      : review
        ? {
            rule: 'CATEGORY_RESTRICTION',
            outcome: 'REVIEW',
            detail: `categoría que requiere revisión regulatoria (coincide con "${review}")`,
          }
        : {
            rule: 'CATEGORY_RESTRICTION',
            outcome: 'PASS',
            detail: 'sin restricciones de categoría',
          },
  );

  // 3-6. Reglas por variante agregadas a nivel de producto.
  const origins = rules.shipping.allowedOriginCountries.join('/');
  findings.push({
    rule: 'SHIPPING_ORIGIN',
    ...aggregate(
      checks.map((c) => c.origin),
      {
        pass: `al menos una variante con bodega en ${origins}`,
        review: `origen de despacho desconocido para algunas variantes`,
        reject: `ninguna variante se despacha desde ${origins}`,
      },
    ),
  });

  const withOrigin = checks.filter((c) => c.origin !== false);
  findings.push({
    rule: 'AVAILABILITY',
    ...aggregate(
      withOrigin.map((c) => c.stock),
      {
        pass: `existencias suficientes (≥ ${rules.inventory.minStockUnits}) en bodegas de origen`,
        review: 'cantidad disponible desconocida',
        reject: 'agotado o por debajo del mínimo de existencias en bodegas de origen',
      },
    ),
  });

  const stocked = withOrigin.filter((c) => c.stock !== false);
  findings.push({
    rule: 'DELIVERY_TIME',
    ...aggregate(
      stocked.map((c) => c.delivery),
      {
        pass: `entrega estimada ≤ ${rules.shipping.maxDeliveryDays} días (incluye ${rules.shipping.handlingDays} de preparación)`,
        review: 'plazo de entrega desconocido',
        reject: `entrega estimada supera ${rules.shipping.maxDeliveryDays} días`,
      },
    ),
  });

  const deliverable = stocked.filter((c) => c.delivery !== false);
  const marginValues = deliverable.map((c) =>
    c.margin === 'PASS' ? true : c.margin === 'REJECT' ? false : null,
  );
  findings.push({
    rule: 'PROFIT_MARGIN',
    ...aggregate(marginValues, {
      pass: `margen estimado ≥ objetivo ${pct(rules.pricing.targetMarginBp)} con el precio recomendado`,
      review: 'margen entre mínimo y objetivo, o faltan costo/envío para calcularlo',
      reject: `margen estimado < mínimo ${pct(rules.pricing.minMarginBp)} con el precio techo`,
    }),
  });

  // 7. Riesgo de duplicados con otros productos del catálogo.
  findings.push(
    context.duplicates.length > 0
      ? {
          rule: 'DUPLICATE_RISK',
          outcome: 'REVIEW',
          detail: `posible duplicado de: ${context.duplicates
            .map((d) => `${d.supplierId}/${d.externalId} (${d.reason})`)
            .join(', ')}`,
        }
      : { rule: 'DUPLICATE_RISK', outcome: 'PASS', detail: 'sin duplicados detectados' },
  );

  const eligible = variants.filter((v) => v.status === 'ELIGIBLE');
  const reviewCount = variants.filter((v) => v.status === 'REVIEW').length;
  const excluded = variants.length - eligible.length - reviewCount;
  if (eligible.length > 0 && eligible.length < variants.length) {
    warnings.push(
      `${variants.length - eligible.length} de ${variants.length} variantes no son elegibles y no se incluirán en un borrador`,
    );
  }

  const classification: Classification = findings.some((f) => f.outcome === 'REJECT')
    ? 'REJECTED'
    : findings.some((f) => f.outcome === 'REVIEW') || eligible.length === 0
      ? 'REVIEW_REQUIRED'
      : 'APPROVED';

  const prices = eligible.map((v) => v.salePriceCents!).filter((p) => p !== null);
  const margins = eligible.map((v) => v.economics!.estimatedProfitMarginBp);

  return {
    productId: product.id,
    productContentHash: product.contentHash,
    rulesVersion: rules.version,
    rulesHash: rules.hash,
    classification,
    findings,
    variants,
    summary: {
      eligibleVariants: eligible.length,
      reviewVariants: reviewCount,
      excludedVariants: excluded,
      priceRangeCents:
        prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      minEstimatedProfitMarginBp: margins.length > 0 ? Math.min(...margins) : null,
    },
    warnings,
    notes: [
      'Clasificación automática según reglas configuradas: no es una autorización para publicar.',
      'Márgenes y beneficios son ESTIMACIONES con los costos configurados; no son ganancias netas definitivas (no incluyen impuestos, costos fijos ni variaciones reales de comisiones).',
    ],
  };
}
