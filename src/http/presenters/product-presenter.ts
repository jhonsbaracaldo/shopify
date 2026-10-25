import type { EvaluationOverrides } from '../../application/use-cases/evaluate-product.js';
import type { ProductEvaluation } from '../../domain/evaluation.js';
import {
  basisPointsToPercent,
  centsToUsd,
  percentToBasisPoints,
  usdToCents,
} from '../../domain/money.js';
import type { Product } from '../../domain/product.js';
import type { EvaluationParametersDto, ProductDto } from '../schemas/product-schemas.js';

/**
 * Traducción entre el formato HTTP (USD con decimales, porcentajes) y el dominio
 * (centavos y puntos básicos enteros).
 */

export function toProductDto(product: Product): ProductDto {
  return {
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    supplier: { ...product.supplier },
    productCost: centsToUsd(product.productCostCents),
    shippingCost: centsToUsd(product.shippingCostCents),
    suggestedPrice: centsToUsd(product.suggestedPriceCents),
    currency: product.currency,
    estimatedDeliveryDays: {
      min: product.estimatedDelivery.minDays,
      max: product.estimatedDelivery.maxDays,
    },
    availability: { ...product.availability },
  };
}

export function fromProductDto(dto: ProductDto): Product {
  return {
    sku: dto.sku,
    name: dto.name,
    description: dto.description,
    category: dto.category,
    supplier: { ...dto.supplier },
    productCostCents: usdToCents(dto.productCost, 'productCost'),
    shippingCostCents: usdToCents(dto.shippingCost, 'shippingCost'),
    suggestedPriceCents: usdToCents(dto.suggestedPrice, 'suggestedPrice'),
    currency: dto.currency,
    estimatedDelivery: {
      minDays: dto.estimatedDeliveryDays.min,
      maxDays: dto.estimatedDeliveryDays.max,
    },
    availability: { ...dto.availability },
  };
}

export function toEvaluationOverrides(params: EvaluationParametersDto = {}): EvaluationOverrides {
  const overrides: EvaluationOverrides = {};
  if (params.targetMarginPercent !== undefined) {
    overrides.targetMarginBp = percentToBasisPoints(
      params.targetMarginPercent,
      'targetMarginPercent',
    );
  }
  if (params.salePrice !== undefined) {
    overrides.salePriceCents = usdToCents(params.salePrice, 'salePrice');
  }
  if (params.maxDeliveryDays !== undefined) overrides.maxDeliveryDays = params.maxDeliveryDays;
  if (params.requiredOriginCountry !== undefined) {
    overrides.requiredOriginCountry = params.requiredOriginCountry;
  }
  if (params.additionalCosts !== undefined) {
    overrides.additionalCosts = params.additionalCosts.map((cost) =>
      cost.type === 'fixed'
        ? { name: cost.name, type: 'fixed', amountCents: usdToCents(cost.amount, cost.name) }
        : {
            name: cost.name,
            type: 'percent_of_price',
            basisPoints: percentToBasisPoints(cost.percent, cost.name),
          },
    );
  }
  return overrides;
}

export function toEvaluationDto(evaluation: ProductEvaluation) {
  return {
    sku: evaluation.sku,
    name: evaluation.name,
    currency: 'USD' as const,
    pricing: {
      salePrice: centsToUsd(evaluation.salePriceCents),
      priceSource: evaluation.priceSource,
      productCost: centsToUsd(evaluation.productCostCents),
      shippingCost: centsToUsd(evaluation.shippingCostCents),
      totalCost: centsToUsd(evaluation.totalCostCents),
    },
    gross: {
      profit: centsToUsd(evaluation.grossProfitCents),
      marginPercent: basisPointsToPercent(evaluation.grossMarginBp),
    },
    net:
      evaluation.net === null
        ? null
        : {
            additionalCosts: centsToUsd(evaluation.net.additionalCostsCents),
            breakdown: evaluation.net.breakdown.map((item) => ({
              name: item.name,
              amount: centsToUsd(item.amountCents),
            })),
            profit: centsToUsd(evaluation.net.netProfitCents),
            marginPercent: basisPointsToPercent(evaluation.net.netMarginBp),
          },
    targetMarginPercent: basisPointsToPercent(evaluation.targetMarginBp),
    minimumRecommendedPrice: centsToUsd(evaluation.minimumPriceCents),
    eligible: evaluation.eligible,
    recommendation: evaluation.recommendation,
    checks: evaluation.checks,
    warnings: evaluation.warnings,
    notes: evaluation.notes,
  };
}
