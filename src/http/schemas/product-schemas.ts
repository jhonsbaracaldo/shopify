import { z } from 'zod';
import { hasAtMostDecimals, MAX_AMOUNT_CENTS } from '../../domain/money.js';
import { AVAILABILITY_STATUSES, MAX_DELIVERY_DAYS_LIMIT } from '../../domain/product.js';

// Mensajes de validación genéricos de Zod en español (los específicos se definen abajo).
z.config(z.locales.es());

const MAX_USD = MAX_AMOUNT_CENTS / 100;

/** Importe en USD: número no negativo con máximo 2 decimales. */
const usdAmount = z
  .number()
  .nonnegative('no puede ser negativo')
  .max(MAX_USD, `no puede superar ${MAX_USD} USD`)
  .refine((v) => hasAtMostDecimals(v, 2), 'admite como máximo 2 decimales');

const positiveUsdAmount = usdAmount.refine((v) => v > 0, 'debe ser mayor que cero');

const percent = (max: number) =>
  z
    .number()
    .min(0, 'no puede ser negativo')
    .max(max, `no puede ser mayor que ${max}`)
    .refine((v) => hasAtMostDecimals(v, 2), 'admite como máximo 2 decimales');

const days = z
  .number()
  .int('debe ser un número entero')
  .min(0, 'no puede ser negativo')
  .max(MAX_DELIVERY_DAYS_LIMIT, `no puede superar ${MAX_DELIVERY_DAYS_LIMIT}`);

const requiredText = (max: number) => z.string().trim().min(1, 'es obligatorio').max(max);

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'debe ser un código ISO alfa-2 (p. ej. US)');

export const productDtoSchema = z.object({
  sku: requiredText(64),
  name: requiredText(200),
  description: requiredText(2000),
  category: requiredText(100),
  supplier: z.object({
    id: requiredText(64),
    name: requiredText(200),
    warehouseCountry: countryCode,
  }),
  productCost: usdAmount,
  shippingCost: usdAmount,
  suggestedPrice: positiveUsdAmount,
  currency: z.literal('USD', 'solo se admite USD'),
  estimatedDeliveryDays: z
    .object({ min: days, max: days })
    .refine((d) => d.min <= d.max, { message: 'min no puede ser mayor que max', path: ['min'] }),
  availability: z.object({
    status: z.enum(AVAILABILITY_STATUSES),
    quantity: z.number().int('debe ser un número entero').min(0, 'no puede ser negativo'),
  }),
});

export type ProductDto = z.infer<typeof productDtoSchema>;

const additionalCostSchema = z.discriminatedUnion('type', [
  z.object({ name: requiredText(100), type: z.literal('fixed'), amount: usdAmount }).strict(),
  z
    .object({ name: requiredText(100), type: z.literal('percent_of_price'), percent: percent(100) })
    .strict(),
]);

export const evaluationParametersSchema = z
  .object({
    targetMarginPercent: percent(99.99).optional(),
    salePrice: positiveUsdAmount.optional(),
    maxDeliveryDays: days.min(1, 'debe ser al menos 1').optional(),
    requiredOriginCountry: countryCode.nullable().optional(),
    additionalCosts: z.array(additionalCostSchema).max(20).optional(),
  })
  .strict();

export const evaluateRequestSchema = z
  .object({
    product: productDtoSchema,
    parameters: evaluationParametersSchema.optional(),
  })
  .strict();

export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;
export type EvaluationParametersDto = z.infer<typeof evaluationParametersSchema>;
