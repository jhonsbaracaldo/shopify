import { z } from 'zod';
import type {
  ShippingQuote,
  SupplierProduct,
  SupplierVariant,
  WarehouseStock,
} from '../../../domain/catalog.js';
import type { SupplierProductSummary } from '../../../application/ports/supplier-port.js';

/**
 * Traducción de respuestas de CJ API 2.0 al modelo común. Los esquemas son TOLERANTES:
 * CJ mezcla números y strings, y algunos campos pueden faltar. Lo que falte se marca como
 * desconocido (`null`) para que la normalización lo reporte, en lugar de inventar valores.
 */

const numberish = z.union([z.number(), z.string()]).nullish();
const text = z.string().nullish();

export const cjListProductSchema = z
  .object({
    id: z.string(),
    nameEn: text,
    sku: text,
    bigImage: text,
    sellPrice: numberish,
    nowPrice: numberish,
    categoryId: text,
    threeCategoryName: text,
    warehouseInventoryNum: numberish,
  })
  .loose();

export const cjInventorySchema = z
  .object({
    countryCode: text,
    totalInventory: numberish,
    cjInventory: numberish,
    factoryInventory: numberish,
    verifiedWarehouse: numberish,
  })
  .loose();

export const cjVariantSchema = z
  .object({
    vid: z.string(),
    pid: text,
    variantSku: text,
    variantNameEn: text,
    variantKey: text,
    variantImage: text,
    variantWeight: numberish,
    variantSellPrice: numberish,
    variantSugSellPrice: numberish,
    barcode: text,
    inventories: z.array(cjInventorySchema).nullish(),
  })
  .loose();

export const cjProductSchema = z
  .object({
    pid: z.string(),
    productNameEn: text,
    productName: z.unknown().optional(),
    productSku: text,
    bigImage: text,
    productImageSet: z.union([z.array(z.string()), z.string()]).nullish(),
    description: text,
    categoryName: text,
    productKeyEn: text,
    sellPrice: numberish,
    variants: z.array(cjVariantSchema).nullish(),
  })
  .loose();

export const cjStockSchema = z
  .object({
    vid: text,
    areaId: numberish,
    areaEn: text,
    countryCode: text,
    totalInventoryNum: numberish,
    storageNum: numberish,
  })
  .loose();

export const cjFreightSchema = z
  .object({
    logisticName: text,
    logisticAging: text,
    logisticPrice: numberish,
    totalPostageFee: numberish,
  })
  .loose();

export type CjListProduct = z.infer<typeof cjListProductSchema>;
export type CjProduct = z.infer<typeof cjProductSchema>;
export type CjVariant = z.infer<typeof cjVariantSchema>;

/** "11.85", 11.85 o rangos "3.29 -- 5.12" (se toma el menor) → centavos; `null` si no es válido. */
export function parseUsdCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const first = typeof value === 'number' ? value : Number(String(value).split('--')[0]!.trim());
  if (!Number.isFinite(first) || first < 0) return null;
  // Datos del proveedor: se redondea al centavo (puede informar más de 2 decimales).
  return Math.round(first * 100);
}

function parseInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** "2-5" → {2,5}; "7" → {7,7}; otros formatos → nulos. */
export function parseAging(value: string | null | undefined): {
  minDays: number | null;
  maxDays: number | null;
} {
  const match = value?.match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
  if (!match) return { minDays: null, maxDays: null };
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return { minDays: Math.min(min, max), maxDays: Math.max(min, max) };
}

function parseImages(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Opciones de variante: CJ informa los nombres en `productKeyEn` ("Color-Size") y los valores en
 * `variantKey` ("Black-XXL"). Si no coinciden en cantidad, se usa una sola opción "Variante".
 */
export function mapVariantOptions(
  productKey: string | null | undefined,
  variantKey: string | null | undefined,
): Record<string, string> {
  if (!variantKey) return {};
  const names =
    productKey
      ?.split('-')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const values = variantKey.split('-').map((s) => s.trim());
  if (names.length > 0 && names.length === values.length && values.every(Boolean)) {
    return Object.fromEntries(names.map((name, i) => [name, values[i]!]));
  }
  return { Variante: variantKey.trim() };
}

export function mapCjInventories(
  inventories: z.infer<typeof cjInventorySchema>[],
): WarehouseStock[] {
  return inventories.map((inv) => ({
    // CJ agrega el inventario por país en el detalle de producto: no expone una bodega concreta.
    warehouseId: `cj-${inv.countryCode ?? 'desconocido'}`,
    warehouseName: inv.countryCode ? `CJ ${inv.countryCode}` : null,
    countryCode: inv.countryCode ?? null,
    quantity: parseInteger(inv.totalInventory),
  }));
}

export function mapCjStock(rows: z.infer<typeof cjStockSchema>[]): WarehouseStock[] {
  return rows.map((row) => ({
    warehouseId:
      row.areaId === null || row.areaId === undefined
        ? `cj-${row.countryCode ?? 'desconocido'}`
        : `cj-area-${row.areaId}`,
    warehouseName: row.areaEn ?? null,
    countryCode: row.countryCode ?? null,
    quantity: parseInteger(row.totalInventoryNum ?? row.storageNum),
  }));
}

export function mapCjFreight(
  rows: z.infer<typeof cjFreightSchema>[],
  origin: string,
  destination: string,
): ShippingQuote[] {
  return rows.flatMap((row) => {
    const cost = parseUsdCents(row.totalPostageFee ?? row.logisticPrice);
    if (cost === null) return [];
    return [
      {
        method: row.logisticName ?? 'CJ',
        originCountry: origin,
        destinationCountry: destination,
        costCents: cost,
        ...parseAging(row.logisticAging),
      },
    ];
  });
}

export function mapCjVariant(
  variant: CjVariant,
  productKey: string | null | undefined,
): SupplierVariant {
  return {
    externalId: variant.vid,
    sku: variant.variantSku ?? null,
    name: variant.variantNameEn ?? null,
    options: mapVariantOptions(productKey, variant.variantKey),
    barcode: variant.barcode ?? null,
    costCents: parseUsdCents(variant.variantSellPrice),
    suggestedRetailCents: parseUsdCents(variant.variantSugSellPrice),
    weightGrams: parseInteger(variant.variantWeight),
    imageUrl: variant.variantImage ?? null,
    inventory: variant.inventories ? mapCjInventories(variant.inventories) : null,
    shippingQuotes: null,
  };
}

export function mapCjProduct(product: CjProduct, supplierId: string): SupplierProduct {
  const images = parseImages(product.productImageSet);
  if (product.bigImage && !images.includes(product.bigImage)) images.unshift(product.bigImage);
  return {
    supplierId,
    externalId: product.pid,
    sku: product.productSku ?? null,
    name: product.productNameEn ?? '',
    description: product.description ?? null,
    category: product.categoryName ?? null,
    images,
    // CJ API 2.0 informa los precios en USD.
    currency: 'USD',
    variants: (product.variants ?? []).map((v) => mapCjVariant(v, product.productKeyEn)),
  };
}

export function mapCjListProduct(
  item: CjListProduct,
  shipsFromCountry: string | undefined,
): SupplierProductSummary {
  return {
    externalId: item.id,
    sku: item.sku ?? null,
    name: item.nameEn ?? '',
    imageUrl: item.bigImage ?? null,
    listCostCents: parseUsdCents(item.nowPrice ?? item.sellPrice),
    category: item.threeCategoryName ?? null,
    warehouseCountries: shipsFromCountry ? [shipsFromCountry] : null,
  };
}
