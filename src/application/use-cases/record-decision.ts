import { checkDecision, type Approval, type ApprovalDecision } from '../../domain/approval.js';
import { overviewContext, type CatalogContext } from '../context.js';
import { ApplicationError, notFound } from '../errors.js';
import type { ApprovalState } from '../ports/persistence.js';

export interface DecisionInput {
  productId: string;
  decision: ApprovalDecision;
  /** La evaluación que la persona revisó: evita aprobar algo distinto a lo que vio. */
  evaluationId: string;
  reviewer: string;
  notes: string | null;
}

/**
 * Registra la decisión HUMANA sobre un producto. Es independiente de la clasificación del motor:
 * APPROVED del motor no publica nada; solo esta decisión (con la clave de aprobador) habilita
 * la creación del borrador.
 */
export class RecordDecisionUseCase {
  constructor(private readonly ctx: CatalogContext) {}

  async execute(
    input: DecisionInput,
  ): Promise<{ approval: Approval; approvalState: ApprovalState }> {
    const { persistence, rules, clock } = this.ctx;
    const overview = await persistence.getOverview(input.productId, overviewContext(this.ctx));
    if (!overview) throw notFound('Producto', input.productId);

    const check = checkDecision(input, overview.product, overview.latestEvaluation, rules.hash);
    if (!check.ok) {
      const kind =
        check.code === 'NOT_APPROVABLE' || check.code === 'REVIEW_NOTES_REQUIRED'
          ? 'unprocessable'
          : 'conflict';
      throw new ApplicationError(kind, check.code, check.message);
    }

    const approval = await persistence.saveApproval(
      {
        productId: overview.product.id,
        evaluationId: input.evaluationId,
        decision: input.decision,
        reviewer: input.reviewer.trim(),
        notes: input.notes?.trim() || null,
        productContentHash: overview.product.contentHash,
        rulesHash: rules.hash,
      },
      clock(),
    );
    this.ctx.logger.info(
      {
        productId: approval.productId,
        decision: approval.decision,
        reviewer: approval.reviewer,
        evaluationId: approval.evaluationId,
      },
      'Decisión humana registrada',
    );
    return { approval, approvalState: approval.decision };
  }
}
