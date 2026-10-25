import {
  evaluateProduct,
  type AdditionalCost,
  type EvaluationCriteria,
  type ProductEvaluation,
} from '../../domain/evaluation.js';
import type { BasisPoints, Cents } from '../../domain/money.js';
import type { Product } from '../../domain/product.js';

export interface EvaluationDefaults {
  targetMarginBp: BasisPoints;
  maxDeliveryDays: number;
  requiredOriginCountry: string | null;
}

/** Parámetros enviados por el cliente; los que falten se completan con los valores por defecto. */
export interface EvaluationOverrides {
  targetMarginBp?: BasisPoints;
  maxDeliveryDays?: number;
  requiredOriginCountry?: string | null;
  salePriceCents?: Cents;
  additionalCosts?: AdditionalCost[];
}

export class EvaluateProductUseCase {
  constructor(private readonly defaults: EvaluationDefaults) {}

  execute(product: Product, overrides: EvaluationOverrides = {}): ProductEvaluation {
    const criteria: EvaluationCriteria = {
      targetMarginBp: overrides.targetMarginBp ?? this.defaults.targetMarginBp,
      maxDeliveryDays: overrides.maxDeliveryDays ?? this.defaults.maxDeliveryDays,
      requiredOriginCountry:
        overrides.requiredOriginCountry === undefined
          ? this.defaults.requiredOriginCountry
          : overrides.requiredOriginCountry,
      additionalCosts: overrides.additionalCosts ?? [],
      ...(overrides.salePriceCents !== undefined && { salePriceCents: overrides.salePriceCents }),
    };
    return evaluateProduct(product, criteria);
  }
}
