import type { ValidationIssue } from './errors.js';
import type { CatalogProduct } from './catalog.js';
import type { StoredEvaluation } from './approval.js';
import type { Cents } from './money.js';
import { hashOf, htmlToPlainText, plainTextToSafeHtml, slugify } from './text.js';

/**
 * Contenido preparado para una tienda, independiente de Shopify. Solo incluye variantes que el
 * motor marcó como ELIGIBLE, con el precio propuesto por la evaluación vigente.
 * El estado es SIEMPRE "DRAFT": este módulo no tiene forma de expresar un producto activo.
 */
export interface StoreDraftVariant {
  variantId: string;
  externalId: string;
  sku: string | null;
  priceCents: Cents;
  costCents: Cents;
  barcode: string | null;
  weightGrams: number | null;
  optionValues: { optionName: string; name: string }[];
  imageUrl: string | null;
}

export interface StoreDraft {
  productId: string;
  evaluationId: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  status: 'DRAFT';
  options: { name: string; values: string[] }[];
  variants: StoreDraftVariant[];
  images: { url: string; alt: string }[];
  draftHash: string;
}

/** Límites documentados de Shopify Admin API (productos con opciones y variantes). */
export const STORE_LIMITS = {
  maxOptions: 3,
  maxVariants: 2048,
  maxImages: 20,
  maxTitle: 255,
} as const;

/** Handle determinista: el mismo producto de proveedor siempre produce el mismo handle. */
export function buildStoreHandle(
  product: Pick<CatalogProduct, 'supplierId' | 'externalId'>,
): string {
  return `dsp-${slugify(product.supplierId, 20)}-${slugify(product.externalId, 60)}`;
}

export function buildStoreDraft(
  product: CatalogProduct,
  evaluation: StoredEvaluation,
  options: { vendor: string | null },
): { draft: StoreDraft | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const eligible = evaluation.variants.filter((v) => v.status === 'ELIGIBLE');
  if (eligible.length === 0) {
    issues.push({ path: 'variants', message: 'no hay variantes elegibles para publicar' });
  }
  if (eligible.length > STORE_LIMITS.maxVariants) {
    issues.push({ path: 'variants', message: `más de ${STORE_LIMITS.maxVariants} variantes` });
  }
  const title = product.name.trim().slice(0, STORE_LIMITS.maxTitle);
  if (!title) issues.push({ path: 'title', message: 'título vacío' });

  const variantsById = new Map(product.variants.map((v) => [v.id, v]));
  const optionNames = [...new Set(eligible.flatMap((v) => Object.keys(v.options)))];
  const useSyntheticOption = eligible.length > 1 && optionNames.length === 0;
  const names = useSyntheticOption ? ['Variante'] : optionNames;
  if (names.length > STORE_LIMITS.maxOptions) {
    issues.push({
      path: 'options',
      message: `más de ${STORE_LIMITS.maxOptions} opciones (${names.join(', ')})`,
    });
  }

  const combos = new Set<string>();
  const variants: StoreDraftVariant[] = [];
  for (const evaluated of eligible) {
    const source = variantsById.get(evaluated.variantId);
    if (!source || source.costCents === null || evaluated.salePriceCents === null) {
      issues.push({
        path: `variants.${evaluated.externalId}`,
        message: 'faltan datos de costo o precio',
      });
      continue;
    }
    const optionValues = useSyntheticOption
      ? [{ optionName: 'Variante', name: source.name ?? source.sku ?? source.externalId }]
      : names.map((name) => ({ optionName: name, name: source.options[name] ?? '' }));
    if (optionValues.some((o) => o.name === '')) {
      issues.push({
        path: `variants.${evaluated.externalId}`,
        message: `la variante no define todas las opciones (${names.join(', ')})`,
      });
    }
    const combo = optionValues.map((o) => `${o.optionName}=${o.name}`).join('|');
    if (combos.has(combo)) {
      issues.push({
        path: `variants.${evaluated.externalId}`,
        message: `combinación de opciones repetida (${combo})`,
      });
    }
    combos.add(combo);
    variants.push({
      variantId: source.id,
      externalId: source.externalId,
      sku: source.sku,
      priceCents: evaluated.salePriceCents,
      costCents: source.costCents,
      barcode: source.barcode,
      weightGrams: source.weightGrams,
      optionValues,
      imageUrl: source.imageUrl,
    });
  }

  if (issues.length > 0) return { draft: null, issues };

  const draftOptions = names.map((name) => ({
    name,
    values: [
      ...new Set(variants.map((v) => v.optionValues.find((o) => o.optionName === name)!.name)),
    ],
  }));

  const content = {
    productId: product.id,
    evaluationId: evaluation.id,
    handle: buildStoreHandle(product),
    title,
    // La descripción del proveedor es HTML no confiable: se reduce a texto y se reconstruye escapada.
    descriptionHtml: product.description
      ? plainTextToSafeHtml(htmlToPlainText(product.description))
      : '',
    productType: product.category,
    vendor: options.vendor,
    tags: ['dropshipping', `proveedor-${slugify(product.supplierId, 30)}`],
    status: 'DRAFT' as const,
    options: draftOptions,
    variants,
    images: product.images.slice(0, STORE_LIMITS.maxImages).map((url) => ({ url, alt: title })),
  };
  return { draft: { ...content, draftHash: hashOf(content) }, issues: [] };
}
