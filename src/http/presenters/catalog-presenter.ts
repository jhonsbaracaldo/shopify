import type { ProductOverview, Publication } from '../../application/ports/persistence.js';
import type { SupplierProductSummary } from '../../application/ports/supplier-port.js';
import type { ImportResult } from '../../application/use-cases/import-products.js';
import type { EvaluateCatalogResult } from '../../application/use-cases/evaluate-catalog.js';
import type { DraftResult } from '../../application/use-cases/create-store-draft.js';
import type { Approval, StoredEvaluation } from '../../domain/approval.js';
import type { CatalogProduct, SupplierProduct } from '../../domain/catalog.js';
import type { VariantEvaluation } from '../../domain/classification.js';
import { basisPointsToPercent, centsToUsd, usdToCents } from '../../domain/money.js';
import type { UnitEconomics } from '../../domain/profitability.js';
import type { StoreDraft } from '../../domain/store-draft.js';
import type { z } from 'zod';
import type { supplierProductSchema } from '../schemas/catalog-schemas.js';

/** Traducción dominio (centavos, puntos básicos) ⇄ API (USD con decimales, porcentajes). */
const usd = (cents: number | null) => (cents === null ? null : centsToUsd(cents));
const pct = (bp: number | null) => (bp === null ? null : basisPointsToPercent(bp));

export function fromSupplierProductDto(
  dto: z.infer<typeof supplierProductSchema>,
  supplierId: string,
): SupplierProduct {
  return {
    supplierId,
    externalId: dto.externalId,
    sku: dto.sku,
    name: dto.name,
    description: dto.description,
    category: dto.category,
    images: dto.images,
    currency: dto.currency,
    variants: dto.variants.map((v) => ({
      externalId: v.externalId,
      sku: v.sku,
      name: v.name,
      options: v.options,
      barcode: v.barcode,
      costCents: v.cost === null ? null : usdToCents(v.cost, 'cost'),
      suggestedRetailCents:
        v.suggestedRetailPrice === null
          ? null
          : usdToCents(v.suggestedRetailPrice, 'suggestedRetailPrice'),
      weightGrams: v.weightGrams,
      imageUrl: v.imageUrl,
      inventory: v.inventory,
      shippingQuotes:
        v.shippingQuotes === null
          ? null
          : v.shippingQuotes.map((q) => ({
              method: q.method,
              originCountry: q.originCountry,
              destinationCountry: q.destinationCountry,
              costCents: usdToCents(q.cost, 'shippingQuotes.cost'),
              minDays: q.minDays,
              maxDays: q.maxDays,
            })),
    })),
  };
}

export function toSupplierSummaryDto(item: SupplierProductSummary) {
  return { ...item, listCostCents: undefined, listCost: usd(item.listCostCents) };
}

export function toCatalogProductDto(product: CatalogProduct) {
  return {
    id: product.id,
    supplierId: product.supplierId,
    externalId: product.externalId,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    images: product.images,
    currency: product.currency,
    validation: product.validation,
    version: product.version,
    firstSeenAt: product.firstSeenAt,
    lastSyncedAt: product.lastSyncedAt,
    variants: product.variants.map((v) => ({
      id: v.id,
      externalId: v.externalId,
      sku: v.sku,
      name: v.name,
      options: v.options,
      barcode: v.barcode,
      cost: usd(v.costCents),
      suggestedRetailPrice: usd(v.suggestedRetailCents),
      weightGrams: v.weightGrams,
      imageUrl: v.imageUrl,
      inventory: v.inventory,
      shippingQuotes:
        v.shippingQuotes?.map((q) => ({ ...q, costCents: undefined, cost: usd(q.costCents) })) ??
        null,
    })),
  };
}

function economicsDto(e: UnitEconomics | null) {
  if (e === null) return null;
  return {
    salePrice: usd(e.salePriceCents),
    productCost: usd(e.productCostCents),
    shippingCost: usd(e.shippingCostCents),
    landedCost: usd(e.landedCostCents),
    paymentFee: usd(e.paymentFeeCents),
    returnsReserve: usd(e.returnsReserveCents),
    otherVariableCosts: e.otherVariableCosts.map((c) => ({
      name: c.name,
      amount: usd(c.amountCents),
    })),
    totalVariableCosts: usd(e.totalVariableCostsCents),
    contribution: usd(e.contributionCents),
    contributionMarginPercent: pct(e.contributionMarginBp),
    customerAcquisitionCost: usd(e.acquisitionCostCents),
    estimatedProfit: usd(e.estimatedProfitCents),
    estimatedProfitMarginPercent: pct(e.estimatedProfitMarginBp),
  };
}

function variantEvaluationDto(v: VariantEvaluation) {
  return {
    variantId: v.variantId,
    externalId: v.externalId,
    sku: v.sku,
    options: v.options,
    status: v.status,
    reasons: v.reasons,
    originStockUnits: v.originStockUnits,
    shipping: v.shipping && {
      ...v.shipping,
      costCents: undefined,
      cost: usd(v.shipping.costCents),
    },
    recommendedPrice: usd(v.recommendedPriceCents),
    proposedSalePrice: usd(v.salePriceCents),
    priceCapped: v.priceCapped,
    economics: economicsDto(v.economics),
  };
}

export function toEvaluationDto(e: StoredEvaluation, detail: 'full' | 'summary' = 'full') {
  const base = {
    id: e.id,
    createdAt: e.createdAt,
    classification: e.classification,
    rulesVersion: e.rulesVersion,
    summary: {
      eligibleVariants: e.summary.eligibleVariants,
      reviewVariants: e.summary.reviewVariants,
      excludedVariants: e.summary.excludedVariants,
      priceRange: e.summary.priceRangeCents && {
        min: usd(e.summary.priceRangeCents.min),
        max: usd(e.summary.priceRangeCents.max),
      },
      minEstimatedProfitMarginPercent: pct(e.summary.minEstimatedProfitMarginBp),
    },
    findings: e.findings,
    warnings: e.warnings,
  };
  return detail === 'summary'
    ? base
    : { ...base, variants: e.variants.map(variantEvaluationDto), notes: e.notes };
}

export function toApprovalDto(a: Approval | null) {
  return (
    a && {
      id: a.id,
      decision: a.decision,
      reviewer: a.reviewer,
      notes: a.notes,
      evaluationId: a.evaluationId,
      createdAt: a.createdAt,
    }
  );
}

export function toPublicationDto(p: Publication | null) {
  return (
    p && {
      id: p.id,
      store: p.store,
      status: p.status,
      stage: p.stage,
      handle: p.handle,
      externalProductId: p.externalProductId,
      attempts: p.attempts,
      lastError: p.lastError,
      updatedAt: p.updatedAt,
    }
  );
}

export function toOverviewDto(o: ProductOverview, detail: 'full' | 'summary') {
  const p = o.product;
  return {
    id: p.id,
    supplierId: p.supplierId,
    externalId: p.externalId,
    sku: p.sku,
    name: p.name,
    category: p.category,
    validationStatus: p.validation.status,
    lastSyncedAt: p.lastSyncedAt,
    evaluationState: o.evaluationState,
    /** Clasificación AUTOMÁTICA (solo si la evaluación está vigente). No es una autorización. */
    classification:
      o.evaluationState === 'CURRENT' ? (o.latestEvaluation?.classification ?? null) : null,
    /** Decisión HUMANA derivada (NONE, APPROVED, REJECTED o STALE). */
    approvalState: o.approvalState,
    publicationStatus: o.publication?.status ?? 'NONE',
    latestEvaluation: o.latestEvaluation && toEvaluationDto(o.latestEvaluation, detail),
    approval: toApprovalDto(o.latestApproval),
    publication: toPublicationDto(o.publication),
    ...(detail === 'full' && { product: toCatalogProductDto(p) }),
  };
}

export function toImportResultDto(r: ImportResult) {
  return r;
}

export function toEvaluateResultDto(r: EvaluateCatalogResult) {
  return {
    rulesVersion: r.rulesVersion,
    summary: r.summary,
    items: r.items.map((item) => ({
      productId: item.productId,
      status: item.status,
      evaluation: item.evaluation && toEvaluationDto(item.evaluation, 'summary'),
    })),
  };
}

function draftDto(d: StoreDraft) {
  return {
    handle: d.handle,
    title: d.title,
    status: d.status,
    productType: d.productType,
    vendor: d.vendor,
    tags: d.tags,
    options: d.options,
    images: d.images,
    descriptionHtml: d.descriptionHtml,
    variants: d.variants.map((v) => ({
      sku: v.sku,
      price: usd(v.priceCents),
      cost: usd(v.costCents),
      optionValues: v.optionValues,
      weightGrams: v.weightGrams,
    })),
    draftHash: d.draftHash,
  };
}

export function toDraftResultDto(r: DraftResult) {
  return {
    outcome: r.outcome,
    productId: r.productId,
    store: r.store,
    checks: r.checks,
    draft: draftDto(r.draft),
    prepared: r.prepared,
    equivalentStoreProduct: r.equivalentStoreProduct,
    storeProduct: r.storeProduct,
    publication: toPublicationDto(r.publication),
  };
}
