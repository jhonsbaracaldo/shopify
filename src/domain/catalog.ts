import type { ValidationIssue } from './errors.js';
import type { Cents } from './money.js';
import { hashOf, normalizeForMatching } from './text.js';

/**
 * Modelo común de catálogo. Los adaptadores de proveedores traducen sus respuestas a
 * `SupplierProduct`; `normalizeSupplierProduct` lo valida y lo convierte en datos listos
 * para persistir. Todos los importes en centavos de USD.
 */

/** Existencias de una variante en una bodega concreta. El país es el de la BODEGA, no el del proveedor. */
export interface WarehouseStock {
  warehouseId: string;
  warehouseName: string | null;
  /** ISO 3166-1 alfa-2 del país de la bodega; `null` si el proveedor no lo informa. */
  countryCode: string | null;
  /** Unidades disponibles; `null` si el proveedor no informa cantidad. */
  quantity: number | null;
}

/** Cotización de envío desde una bodega hasta el país del cliente. */
export interface ShippingQuote {
  method: string;
  originCountry: string;
  destinationCountry: string;
  costCents: Cents;
  /** Días de tránsito informados por el proveedor (sin tiempo de preparación). */
  minDays: number | null;
  maxDays: number | null;
}

export interface SupplierVariant {
  externalId: string;
  sku: string | null;
  name: string | null;
  /** Opciones de la variante, p. ej. { Color: "Black", Size: "XL" }. */
  options: Record<string, string>;
  barcode: string | null;
  /** Costo de adquisición por unidad; `null` si el proveedor no lo informó. */
  costCents: Cents | null;
  /** Precio de venta sugerido por el proveedor (referencia de mercado, opcional). */
  suggestedRetailCents: Cents | null;
  weightGrams: number | null;
  imageUrl: string | null;
  /** `null` = el proveedor no informó inventario (desconocido), `[]` = sin bodegas. */
  inventory: WarehouseStock[] | null;
  /** `null` = no se pudo cotizar envío. */
  shippingQuotes: ShippingQuote[] | null;
}

export interface SupplierProduct {
  supplierId: string;
  externalId: string;
  sku: string | null;
  name: string;
  /** Puede contener HTML del proveedor: se trata como contenido no confiable. */
  description: string | null;
  category: string | null;
  images: string[];
  currency: string;
  variants: SupplierVariant[];
}

export const VALIDATION_STATUSES = ['VALID', 'INCOMPLETE', 'INVALID'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export interface CatalogIssue extends ValidationIssue {
  severity: 'error' | 'warning';
}

/** Producto normalizado, aún sin identificador interno. */
export interface NormalizedProduct extends SupplierProduct {
  validation: { status: ValidationStatus; issues: CatalogIssue[] };
  /** Hash del contenido normalizado: detecta cambios y hace idempotente la importación. */
  contentHash: string;
  /** Huella del nombre para detectar posibles duplicados entre proveedores. */
  dedupeKey: string;
}

export interface CatalogVariant extends SupplierVariant {
  id: string;
}

/** Producto persistido con identificador interno. */
export interface CatalogProduct extends Omit<NormalizedProduct, 'variants'> {
  id: string;
  variants: CatalogVariant[];
  version: number;
  firstSeenAt: Date;
  lastSyncedAt: Date;
}

const COUNTRY_RE = /^[A-Z]{2}$/;

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeCountry(value: string | null): string | null {
  const upper = value?.trim().toUpperCase() ?? null;
  return upper !== null && COUNTRY_RE.test(upper) ? upper : null;
}

/** Palabras vacías que no aportan a la huella de duplicados. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'for',
  'with',
  'of',
  'de',
  'la',
  'el',
  'y',
  'con',
  'para',
]);

/** "Portable Blender USB-C, 380ml" y "380ML portable blender usb c" producen la misma huella. */
export function buildDedupeKey(name: string): string {
  const tokens = normalizeForMatching(name)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Valida y normaliza un producto de proveedor:
 * - recorta textos, normaliza países e imágenes (solo https), elimina variantes duplicadas;
 * - clasifica la calidad de los datos: INVALID (no utilizable), INCOMPLETE (falta información),
 *   VALID (completo).
 */
export function normalizeSupplierProduct(input: SupplierProduct): NormalizedProduct {
  const issues: CatalogIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) =>
    issues.push({ path, message, severity: 'warning' });

  const externalId = cleanText(input.externalId) ?? '';
  const supplierId = cleanText(input.supplierId) ?? '';
  const name = cleanText(input.name) ?? '';
  if (!supplierId) error('supplierId', 'es obligatorio');
  if (!externalId) error('externalId', 'es obligatorio');
  if (!name) error('name', 'es obligatorio');

  const currency = (cleanText(input.currency) ?? '').toUpperCase();
  if (currency !== 'USD') {
    error(
      'currency',
      `moneda ${currency || '(vacía)'} no soportada: solo USD (sin conversión en esta fase)`,
    );
  }

  const description = cleanText(input.description);
  if (!description) warn('description', 'sin descripción');
  const category = cleanText(input.category);
  if (!category) warn('category', 'sin categoría');

  const images = [...new Set(input.images.map((u) => u.trim()).filter(isHttpsUrl))];
  if (images.length < input.images.length)
    warn('images', 'se descartaron imágenes no https o repetidas');
  if (images.length === 0) warn('images', 'sin imágenes válidas');

  const seen = new Set<string>();
  const variants: SupplierVariant[] = [];
  input.variants.forEach((raw, index) => {
    const path = `variants[${index}]`;
    const variantId = cleanText(raw.externalId);
    if (!variantId) {
      error(`${path}.externalId`, 'variante sin identificador: descartada');
      return;
    }
    if (seen.has(variantId)) {
      warn(`${path}.externalId`, `variante ${variantId} repetida: se conserva la primera`);
      return;
    }
    seen.add(variantId);

    const costCents = isNonNegativeInt(raw.costCents) ? raw.costCents : null;
    if (costCents === null) warn(`${path}.costCents`, `variante ${variantId} sin costo válido`);
    const weightGrams =
      isNonNegativeInt(raw.weightGrams) && raw.weightGrams > 0 ? raw.weightGrams : null;
    if (weightGrams === null) warn(`${path}.weightGrams`, `variante ${variantId} sin peso`);

    const inventory =
      raw.inventory === null
        ? null
        : raw.inventory.map((stock) => ({
            warehouseId: stock.warehouseId.trim(),
            warehouseName: cleanText(stock.warehouseName),
            countryCode: normalizeCountry(stock.countryCode),
            quantity: isNonNegativeInt(stock.quantity) ? stock.quantity : null,
          }));
    if (inventory === null)
      warn(`${path}.inventory`, `variante ${variantId} sin información de inventario`);
    else if (inventory.some((s) => s.countryCode === null)) {
      warn(`${path}.inventory`, `variante ${variantId} tiene bodegas sin país informado`);
    }

    const shippingQuotes =
      raw.shippingQuotes === null
        ? null
        : raw.shippingQuotes
            .filter((q) => isNonNegativeInt(q.costCents))
            .map((q) => ({
              method: q.method.trim() || 'desconocido',
              originCountry: normalizeCountry(q.originCountry) ?? 'ZZ',
              destinationCountry: normalizeCountry(q.destinationCountry) ?? 'ZZ',
              costCents: q.costCents,
              minDays: isNonNegativeInt(q.minDays) ? q.minDays : null,
              maxDays: isNonNegativeInt(q.maxDays) ? q.maxDays : null,
            }));

    const options = Object.fromEntries(
      Object.entries(raw.options)
        .map(([k, v]) => [k.trim(), String(v).trim()] as const)
        .filter(([k, v]) => k.length > 0 && v.length > 0),
    );

    const imageUrl = raw.imageUrl && isHttpsUrl(raw.imageUrl.trim()) ? raw.imageUrl.trim() : null;

    variants.push({
      externalId: variantId,
      sku: cleanText(raw.sku),
      name: cleanText(raw.name),
      options,
      barcode: cleanText(raw.barcode),
      costCents,
      suggestedRetailCents: isNonNegativeInt(raw.suggestedRetailCents)
        ? raw.suggestedRetailCents
        : null,
      weightGrams,
      imageUrl,
      inventory,
      shippingQuotes,
    });
  });

  if (variants.length === 0) error('variants', 'el producto no tiene variantes utilizables');

  const status: ValidationStatus = issues.some((i) => i.severity === 'error')
    ? 'INVALID'
    : issues.length > 0
      ? 'INCOMPLETE'
      : 'VALID';

  const content = {
    supplierId,
    externalId,
    sku: cleanText(input.sku),
    name,
    description,
    category,
    images,
    currency,
    variants,
  };

  return {
    ...content,
    validation: { status, issues },
    contentHash: hashOf(content),
    dedupeKey: buildDedupeKey(name),
  };
}

/** Unidades disponibles en bodegas de los países indicados. `null` si no hay datos suficientes. */
export function stockInCountries(
  variant: SupplierVariant,
  countries: readonly string[],
): number | null {
  if (variant.inventory === null) return null;
  const relevant = variant.inventory.filter(
    (s) => s.countryCode !== null && countries.includes(s.countryCode),
  );
  if (relevant.length === 0) return 0;
  if (relevant.every((s) => s.quantity === null)) return null;
  return relevant.reduce((sum, s) => sum + (s.quantity ?? 0), 0);
}
