import type { StoredEvaluation } from '../../domain/approval.js';
import { classifyProduct, type Classification } from '../../domain/classification.js';
import { overviewContext, type CatalogContext } from '../context.js';
import { ApplicationError } from '../errors.js';

export const MAX_EVALUATION_BATCH = 100;

export interface EvaluateCatalogInput {
  /** IDs internos a evaluar. Si se omite, se evalúan los productos con evaluación PENDING. */
  productIds?: string[];
  limit: number;
  /** Fuerza una nueva evaluación aunque la vigente siga siendo válida (invalida aprobaciones). */
  force: boolean;
}

export interface EvaluateItemResult {
  productId: string;
  status: 'evaluated' | 'unchanged' | 'not_found';
  evaluation: StoredEvaluation | null;
}

export interface EvaluateCatalogResult {
  rulesVersion: string;
  summary: Record<Classification | 'evaluated' | 'unchanged' | 'not_found', number>;
  items: EvaluateItemResult[];
}

/**
 * Evalúa productos del catálogo con las reglas vigentes y guarda el resultado.
 * Idempotente: si la evaluación vigente corresponde al mismo contenido y reglas, no se crea otra
 * (crear otra invalidaría aprobaciones humanas sin motivo), salvo `force: true`.
 */
export class EvaluateCatalogUseCase {
  constructor(private readonly ctx: CatalogContext) {}

  async execute(input: EvaluateCatalogInput): Promise<EvaluateCatalogResult> {
    const { persistence, rules, clock } = this.ctx;
    const octx = overviewContext(this.ctx);
    const limit = Math.min(Math.max(input.limit, 1), MAX_EVALUATION_BATCH);

    let ids: string[];
    if (input.productIds) {
      ids = [...new Set(input.productIds)];
      if (ids.length > MAX_EVALUATION_BATCH) {
        throw new ApplicationError(
          'validation',
          'EVALUATION_BATCH_TOO_LARGE',
          `Máximo ${MAX_EVALUATION_BATCH} productos por solicitud`,
        );
      }
    } else {
      const pending = await persistence.listOverviews(
        { evaluationState: 'PENDING' },
        { page: 1, pageSize: limit },
        octx,
      );
      ids = pending.items.map((o) => o.product.id);
    }

    const items: EvaluateItemResult[] = [];
    for (const id of ids) {
      const overview = await persistence.getOverview(id, octx);
      if (!overview) {
        items.push({ productId: id, status: 'not_found', evaluation: null });
        continue;
      }
      if (overview.evaluationState === 'CURRENT' && !input.force) {
        items.push({ productId: id, status: 'unchanged', evaluation: overview.latestEvaluation });
        continue;
      }
      const duplicates = await persistence.findDuplicates(overview.product);
      const result = classifyProduct(overview.product, rules, { duplicates });
      const evaluation = await persistence.saveEvaluation(result, clock());
      items.push({ productId: id, status: 'evaluated', evaluation });
    }

    const summary: EvaluateCatalogResult['summary'] = {
      evaluated: 0,
      unchanged: 0,
      not_found: 0,
      APPROVED: 0,
      REVIEW_REQUIRED: 0,
      REJECTED: 0,
    };
    for (const item of items) {
      summary[item.status] += 1;
      if (item.evaluation) summary[item.evaluation.classification] += 1;
    }
    return { rulesVersion: rules.version, summary, items };
  }
}
