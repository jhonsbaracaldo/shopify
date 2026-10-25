import type { CatalogProduct } from './catalog.js';
import type { ProductEvaluationResult } from './classification.js';

export interface StoredEvaluation extends ProductEvaluationResult {
  id: string;
  createdAt: Date;
}

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Decisión HUMANA, independiente de la clasificación automática del motor. */
export interface Approval {
  id: string;
  productId: string;
  evaluationId: string;
  decision: ApprovalDecision;
  reviewer: string;
  notes: string | null;
  productContentHash: string;
  rulesHash: string;
  createdAt: Date;
}

export type RuleCheck<C extends string> = { ok: true } | { ok: false; code: C; message: string };

export const MIN_REVIEW_NOTES_LENGTH = 15;

/** La evaluación sigue vigente si ni el producto ni las reglas cambiaron desde que se hizo. */
export function isEvaluationCurrent(
  evaluation: Pick<StoredEvaluation, 'productContentHash' | 'rulesHash'>,
  product: Pick<CatalogProduct, 'contentHash'>,
  currentRulesHash: string,
): boolean {
  return (
    evaluation.productContentHash === product.contentHash &&
    evaluation.rulesHash === currentRulesHash
  );
}

export type DecisionErrorCode =
  | 'EVALUATION_REQUIRED'
  | 'EVALUATION_MISMATCH'
  | 'EVALUATION_STALE'
  | 'NOT_APPROVABLE'
  | 'REVIEW_NOTES_REQUIRED';

/**
 * Reglas para registrar una decisión humana:
 * - Debe referirse a la ÚLTIMA evaluación (la que la persona revisó) y que siga vigente.
 * - Un producto REJECTED por el motor no puede aprobarse.
 * - Aprobar un producto REVIEW_REQUIRED exige notas que justifiquen la revisión manual.
 */
export function checkDecision(
  input: { decision: ApprovalDecision; evaluationId: string; notes: string | null },
  product: CatalogProduct,
  latestEvaluation: StoredEvaluation | null,
  currentRulesHash: string,
): RuleCheck<DecisionErrorCode> {
  if (latestEvaluation === null) {
    return { ok: false, code: 'EVALUATION_REQUIRED', message: 'El producto no tiene evaluaciones' };
  }
  if (input.evaluationId !== latestEvaluation.id) {
    return {
      ok: false,
      code: 'EVALUATION_MISMATCH',
      message: `La evaluación indicada no es la más reciente (${latestEvaluation.id}); revise la evaluación actual`,
    };
  }
  if (!isEvaluationCurrent(latestEvaluation, product, currentRulesHash)) {
    return {
      ok: false,
      code: 'EVALUATION_STALE',
      message: 'El producto o las reglas cambiaron después de la evaluación: vuelva a evaluar',
    };
  }
  if (input.decision === 'APPROVED') {
    if (latestEvaluation.classification === 'REJECTED') {
      return {
        ok: false,
        code: 'NOT_APPROVABLE',
        message: 'El motor clasificó el producto como REJECTED: no puede aprobarse',
      };
    }
    if (
      latestEvaluation.classification === 'REVIEW_REQUIRED' &&
      (input.notes?.trim().length ?? 0) < MIN_REVIEW_NOTES_LENGTH
    ) {
      return {
        ok: false,
        code: 'REVIEW_NOTES_REQUIRED',
        message: `Aprobar un producto REVIEW_REQUIRED exige notas de la revisión manual (mínimo ${MIN_REVIEW_NOTES_LENGTH} caracteres)`,
      };
    }
  }
  return { ok: true };
}

export type PublicationAuthErrorCode =
  | 'EVALUATION_REQUIRED'
  | 'EVALUATION_STALE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_STALE';

/** Autorización para crear un borrador: aprobación humana vigente sobre la evaluación vigente. */
export function checkPublicationAuthorization(
  product: CatalogProduct,
  latestEvaluation: StoredEvaluation | null,
  latestApproval: Approval | null,
  currentRulesHash: string,
): RuleCheck<PublicationAuthErrorCode> {
  if (latestEvaluation === null) {
    return { ok: false, code: 'EVALUATION_REQUIRED', message: 'El producto no tiene evaluaciones' };
  }
  if (!isEvaluationCurrent(latestEvaluation, product, currentRulesHash)) {
    return {
      ok: false,
      code: 'EVALUATION_STALE',
      message: 'El producto o las reglas cambiaron: se requiere una nueva evaluación y aprobación',
    };
  }
  if (latestApproval === null) {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      message: 'Falta la aprobación humana explícita',
    };
  }
  if (latestApproval.decision !== 'APPROVED') {
    return {
      ok: false,
      code: 'APPROVAL_REJECTED',
      message: 'La última decisión humana fue rechazar el producto',
    };
  }
  if (
    latestApproval.evaluationId !== latestEvaluation.id ||
    latestApproval.productContentHash !== product.contentHash
  ) {
    return {
      ok: false,
      code: 'APPROVAL_STALE',
      message: 'La aprobación corresponde a una evaluación anterior: se requiere aprobar de nuevo',
    };
  }
  return { ok: true };
}
