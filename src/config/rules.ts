import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { hasAtMostDecimals, percentToBasisPoints, usdToCents } from '../domain/money.js';
import { assertFeasibleRules } from '../domain/profitability.js';
import { totalPercentCostsBp, type EvaluationRules } from '../domain/rules.js';
import { hashOf } from '../domain/text.js';

const usd = z
  .number()
  .nonnegative()
  .max(10_000)
  .refine((v) => hasAtMostDecimals(v, 2), 'admite como máximo 2 decimales');
const percent = (max = 100) =>
  z
    .number()
    .min(0)
    .max(max)
    .refine((v) => hasAtMostDecimals(v, 2), 'admite como máximo 2 decimales');
const country = z.string().regex(/^[A-Z]{2}$/, 'código ISO alfa-2 en mayúsculas');

const rulesFileSchema = z
  .object({
    $comment: z.string().optional(),
    version: z.string().min(1).max(64),
    pricing: z.object({
      targetMarginPercent: percent(95),
      minMarginPercent: percent(95),
      paymentProcessing: z.object({ percent: percent(), fixedUsd: usd }),
      returnsReservePercent: percent(),
      customerAcquisitionCostUsd: usd,
      variableCosts: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ name: z.string().min(1), type: z.literal('fixed'), amountUsd: usd }),
            z.object({
              name: z.string().min(1),
              type: z.literal('percent_of_price'),
              percent: percent(),
            }),
          ]),
        )
        .max(20),
      priceEndingCents: z.number().int().min(0).max(99).nullable(),
      maxRetailPriceUsd: usd.refine((v) => v > 0, 'debe ser mayor que cero').nullable(),
    }),
    shipping: z.object({
      destinationCountry: country,
      allowedOriginCountries: z.array(country).min(1),
      handlingDays: z.number().int().min(0).max(30),
      maxDeliveryDays: z.number().int().min(1).max(90),
      fallbackShippingCostUsd: usd.nullable(),
    }),
    inventory: z
      .object({ minStockUnits: z.number().int().min(0), lowStockUnits: z.number().int().min(0) })
      .refine((v) => v.lowStockUnits >= v.minStockUnits, 'lowStockUnits debe ser ≥ minStockUnits'),
    categories: z.object({
      blockedKeywords: z.array(z.string().min(1)),
      reviewKeywords: z.array(z.string().min(1)),
    }),
    completeness: z.object({
      requireDescription: z.boolean(),
      minImages: z.number().int().min(0).max(20),
      requireWeight: z.boolean(),
    }),
  })
  .refine((r) => r.pricing.minMarginPercent <= r.pricing.targetMarginPercent, {
    message: 'minMarginPercent no puede ser mayor que targetMarginPercent',
    path: ['pricing', 'minMarginPercent'],
  });

export type RulesFile = z.infer<typeof rulesFileSchema>;

export class RulesConfigError extends Error {}

/** Convierte el archivo de reglas (USD y %) a unidades del dominio y valida su viabilidad. */
export function parseRules(raw: unknown): EvaluationRules {
  const parsed = rulesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new RulesConfigError(`Archivo de reglas no válido:\n${details}`);
  }
  const { $comment: _comment, ...file } = parsed.data;
  const p = file.pricing;
  const pricing: EvaluationRules['pricing'] = {
    targetMarginBp: percentToBasisPoints(p.targetMarginPercent),
    minMarginBp: percentToBasisPoints(p.minMarginPercent),
    paymentFeeBp: percentToBasisPoints(p.paymentProcessing.percent),
    paymentFeeFixedCents: usdToCents(p.paymentProcessing.fixedUsd),
    returnsReserveBp: percentToBasisPoints(p.returnsReservePercent),
    acquisitionCostCents: usdToCents(p.customerAcquisitionCostUsd),
    variableCosts: p.variableCosts.map((c) =>
      c.type === 'fixed'
        ? { name: c.name, type: 'fixed' as const, amountCents: usdToCents(c.amountUsd) }
        : {
            name: c.name,
            type: 'percent_of_price' as const,
            basisPoints: percentToBasisPoints(c.percent),
          },
    ),
    priceEndingCents: p.priceEndingCents,
    maxRetailPriceCents: p.maxRetailPriceUsd === null ? null : usdToCents(p.maxRetailPriceUsd),
  };
  try {
    assertFeasibleRules(pricing);
  } catch (error) {
    throw new RulesConfigError(
      `Reglas inviables: costos porcentuales (${totalPercentCostsBp(pricing) / 100} %) + margen objetivo (${p.targetMarginPercent} %) deben sumar menos de 100 %. ${(error as Error).message}`,
    );
  }

  return {
    version: file.version,
    hash: hashOf(file),
    pricing,
    shipping: {
      destinationCountry: file.shipping.destinationCountry,
      allowedOriginCountries: file.shipping.allowedOriginCountries,
      handlingDays: file.shipping.handlingDays,
      maxDeliveryDays: file.shipping.maxDeliveryDays,
      fallbackShippingCostCents:
        file.shipping.fallbackShippingCostUsd === null
          ? null
          : usdToCents(file.shipping.fallbackShippingCostUsd),
    },
    inventory: file.inventory,
    categories: file.categories,
    completeness: file.completeness,
  };
}

export function loadRulesFile(path: string): EvaluationRules {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RulesConfigError(
      `No se pudo leer el archivo de reglas ${path}: ${(error as Error).message}`,
    );
  }
  return parseRules(raw);
}
