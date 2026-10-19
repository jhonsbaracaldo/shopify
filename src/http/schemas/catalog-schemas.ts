import { z } from 'zod';
import { CLASSIFICATIONS } from '../../domain/classification.js';
import { hasAtMostDecimals } from '../../domain/money.js';
import {
  APPROVAL_STATES,
  EVALUATION_STATES,
  PUBLICATION_STATUSES,
} from '../../application/ports/persistence.js';
import { MAX_IMPORT_BATCH } from '../../application/use-cases/import-products.js';
import { MAX_EVALUATION_BATCH } from '../../application/use-cases/evaluate-catalog.js';

// Mensajes de validación de Zod en español (también se configura en product-schemas.ts).
z.config(z.locales.es());

const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'código ISO alfa-2');
const uuid = z.uuid('debe ser un UUID');
const page = z.coerce.number().int().min(1).max(1000).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const usd = z
  .number()
  .nonnegative('no puede ser negativo')
  .max(1_000_000)
  .refine((v) => hasAtMostDecimals(v, 2), 'admite como máximo 2 decimales');

/** "A,B" → ["A","B"] validando cada valor contra el enum. */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1));

const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const idParamsSchema = z.object({ id: uuid });
export const supplierParamsSchema = z.object({ supplierId: z.string().min(1).max(40) });

export const supplierProductsQuerySchema = z.object({
  page,
  pageSize,
  keyword: z.string().trim().min(1).max(100).optional(),
  shipsFrom: country.optional(),
  categoryId: z.string().trim().min(1).max(100).optional(),
});

const warehouseStockSchema = z.object({
  warehouseId: z.string().min(1).max(100),
  warehouseName: z.string().max(200).nullable().default(null),
  countryCode: country.nullable(),
  quantity: z.number().int().min(0).nullable(),
});

const shippingQuoteSchema = z.object({
  method: z.string().min(1).max(200),
  originCountry: country,
  destinationCountry: country,
  cost: usd,
  minDays: z.number().int().min(0).max(120).nullable(),
  maxDays: z.number().int().min(0).max(120).nullable(),
});

const supplierVariantSchema = z.object({
  externalId: z.string().min(1).max(100),
  sku: z.string().max(100).nullable().default(null),
  name: z.string().max(300).nullable().default(null),
  options: z.record(z.string().max(60), z.string().max(120)).default({}),
  barcode: z.string().max(60).nullable().default(null),
  cost: usd.nullable(),
  suggestedRetailPrice: usd.nullable().default(null),
  weightGrams: z.number().int().positive().nullable().default(null),
  imageUrl: z.string().max(2000).nullable().default(null),
  inventory: z.array(warehouseStockSchema).max(100).nullable(),
  shippingQuotes: z.array(shippingQuoteSchema).max(50).nullable().default(null),
});

/** Producto en el formato común (USD con decimales), para importar datos ya obtenidos fuera del backend. */
export const supplierProductSchema = z.object({
  externalId: z.string().min(1).max(100),
  sku: z.string().max(100).nullable().default(null),
  name: z.string().max(500),
  description: z.string().max(50_000).nullable().default(null),
  category: z.string().max(300).nullable().default(null),
  images: z.array(z.string().max(2000)).max(50).default([]),
  currency: z.string().length(3),
  variants: z.array(supplierVariantSchema).max(500),
});

export const importBodySchema = z.union([
  z
    .object({
      supplierId: z.string().min(1).max(40),
      externalProductIds: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_IMPORT_BATCH),
    })
    .strict(),
  z
    .object({
      supplierId: z.string().min(1).max(40),
      products: z.array(supplierProductSchema).min(1).max(MAX_IMPORT_BATCH),
    })
    .strict(),
]);

export const persistentEvaluateBodySchema = z
  .object({
    productIds: z.array(uuid).min(1).max(MAX_EVALUATION_BATCH).optional(),
    limit: z.number().int().min(1).max(MAX_EVALUATION_BATCH).default(50),
    force: z.boolean().default(false),
  })
  .strict();

export const candidatesQuerySchema = z.object({
  page,
  pageSize,
  supplierId: z.string().min(1).max(40).optional(),
  classification: csvEnum(CLASSIFICATIONS).optional(),
  evaluation: z.enum(EVALUATION_STATES).optional(),
  approval: csvEnum(APPROVAL_STATES).optional(),
  publication: csvEnum([...PUBLICATION_STATUSES, 'NONE'] as const).optional(),
  includeDetails: booleanQuery.default(false),
});

export const approveBodySchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'),
    evaluationId: uuid,
    reviewer: z.string().trim().min(2).max(100),
    notes: z.string().trim().max(2000).nullable().default(null),
  })
  .strict();

export const draftBodySchema = z
  .object({
    dryRun: z.boolean().default(true),
    confirm: z.boolean().default(false),
  })
  .strict();
