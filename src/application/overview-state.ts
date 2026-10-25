import { isEvaluationCurrent, type Approval, type StoredEvaluation } from '../domain/approval.js';
import type { CatalogProduct } from '../domain/catalog.js';
import type {
  ApprovalState,
  EvaluationState,
  OverviewFilter,
  ProductOverview,
} from './ports/persistence.js';

export function deriveEvaluationState(
  product: CatalogProduct,
  evaluation: StoredEvaluation | null,
  rulesHash: string,
): EvaluationState {
  return evaluation !== null && isEvaluationCurrent(evaluation, product, rulesHash)
    ? 'CURRENT'
    : 'PENDING';
}

export function deriveApprovalState(
  product: CatalogProduct,
  evaluation: StoredEvaluation | null,
  approval: Approval | null,
  rulesHash: string,
): ApprovalState {
  if (approval === null) return 'NONE';
  if (
    evaluation === null ||
    approval.evaluationId !== evaluation.id ||
    approval.productContentHash !== product.contentHash ||
    !isEvaluationCurrent(evaluation, product, rulesHash)
  ) {
    return 'STALE';
  }
  return approval.decision;
}

/** Filtro en memoria equivalente al SQL de la implementación PostgreSQL. */
export function matchesOverviewFilter(overview: ProductOverview, filter: OverviewFilter): boolean {
  const { product, latestEvaluation, publication } = overview;
  if (filter.supplierId && product.supplierId !== filter.supplierId) return false;
  if (filter.productIds && !filter.productIds.includes(product.id)) return false;
  if (filter.evaluationState && overview.evaluationState !== filter.evaluationState) return false;
  if (filter.classifications) {
    if (overview.evaluationState !== 'CURRENT' || latestEvaluation === null) return false;
    if (!filter.classifications.includes(latestEvaluation.classification)) return false;
  }
  if (filter.approvalStates && !filter.approvalStates.includes(overview.approvalState))
    return false;
  if (
    filter.publicationStatuses &&
    !filter.publicationStatuses.includes(publication?.status ?? 'NONE')
  ) {
    return false;
  }
  return true;
}
