import {
  normalizeSupplierProduct,
  type SupplierProduct,
  type ValidationStatus,
} from '../../domain/catalog.js';
import type { CatalogContext } from '../context.js';
import { ApplicationError, ExternalServiceError } from '../errors.js';
import type { SyncRunItemError, SyncRunStatus, UpsertChange } from '../ports/persistence.js';

export const MAX_IMPORT_BATCH = 50;

export type ImportItemStatus = UpsertChange | 'not_found' | 'failed' | 'skipped';

export interface ImportItemResult {
  externalId: string;
  status: ImportItemStatus;
  productId: string | null;
  validationStatus: ValidationStatus | null;
  issues: { path: string; message: string; severity: string }[];
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface ImportResult {
  syncRunId: string;
  supplierId: string;
  status: SyncRunStatus;
  summary: Record<ImportItemStatus | 'requested', number>;
  items: ImportItemResult[];
}

export type ImportInput =
  | { supplierId: string; externalProductIds: string[]; trigger: string }
  | { supplierId: string; products: SupplierProduct[]; trigger: string };

/**
 * Importa productos de un proveedor al catálogo normalizado.
 * - Idempotente: la identidad es (proveedor, id externo) y el hash de contenido detecta cambios;
 *   reimportar lo mismo devuelve `unchanged` sin crear versiones nuevas.
 * - Errores parciales explícitos: un producto que falla no detiene el lote (salvo límite de
 *   frecuencia agotado o proveedor no configurado), y cada ítem informa su resultado.
 */
export class ImportProductsUseCase {
  constructor(private readonly ctx: CatalogContext) {}

  async execute(input: ImportInput): Promise<ImportResult> {
    const supplier = this.ctx.suppliers.require(input.supplierId);
    const ids =
      'externalProductIds' in input
        ? input.externalProductIds
        : input.products.map((p) => p.externalId);
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0)
      throw new ApplicationError('validation', 'EMPTY_IMPORT', 'No hay productos para importar');
    if (uniqueIds.length > MAX_IMPORT_BATCH) {
      throw new ApplicationError(
        'validation',
        'IMPORT_BATCH_TOO_LARGE',
        `Máximo ${MAX_IMPORT_BATCH} productos por solicitud`,
      );
    }
    if ('products' in input) {
      const foreign = input.products.find((p) => p.supplierId !== input.supplierId);
      if (foreign) {
        throw new ApplicationError(
          'validation',
          'SUPPLIER_MISMATCH',
          `El producto ${foreign.externalId} pertenece a ${foreign.supplierId}, no a ${input.supplierId}`,
        );
      }
    }

    const { persistence, clock, logger } = this.ctx;
    await persistence.ensureSupplier({
      id: supplier.info.id,
      name: supplier.info.name,
      kind: supplier.info.kind,
    });
    const run = await persistence.startSyncRun(supplier.info.id, input.trigger, clock());
    const provided =
      'products' in input ? new Map(input.products.map((p) => [p.externalId.trim(), p])) : null;

    const items: ImportItemResult[] = [];
    let stopReason: ExternalServiceError | null = null;

    for (const externalId of uniqueIds) {
      const base: ImportItemResult = {
        externalId,
        status: 'failed',
        productId: null,
        validationStatus: null,
        issues: [],
        error: null,
      };
      if (stopReason) {
        items.push({
          ...base,
          status: 'skipped',
          error: {
            code: stopReason.code,
            message: 'omitido: el lote se detuvo por un error previo del proveedor',
            retryable: true,
          },
        });
        continue;
      }
      try {
        const raw = provided ? provided.get(externalId)! : await supplier.getProduct(externalId);
        if (raw === null) {
          items.push({
            ...base,
            status: 'not_found',
            error: {
              code: 'SUPPLIER_PRODUCT_NOT_FOUND',
              message: 'el proveedor no devolvió el producto',
              retryable: false,
            },
          });
          continue;
        }
        const normalized = normalizeSupplierProduct({ ...raw, supplierId: supplier.info.id });
        const { product, change } = await persistence.upsertProduct(normalized, run.id, clock());
        items.push({
          ...base,
          status: change,
          productId: product.id,
          validationStatus: product.validation.status,
          issues: product.validation.issues,
        });
      } catch (error) {
        if (error instanceof ExternalServiceError) {
          items.push({
            ...base,
            error: { code: error.code, message: error.message, retryable: error.retryable },
          });
          // Límite de frecuencia agotado o proveedor caído: no tiene sentido seguir golpeando la API.
          if (
            error.kind === 'rate_limited' ||
            error.code === 'SUPPLIER_NOT_CONFIGURED' ||
            error.code === 'SUPPLIER_AUTH_FAILED'
          ) {
            stopReason = error;
          }
          continue;
        }
        logger.warn(
          { externalId, error: (error as Error).message },
          'Error inesperado importando producto',
        );
        items.push({
          ...base,
          error: {
            code: 'IMPORT_ERROR',
            message: 'error interno al importar el producto',
            retryable: true,
          },
        });
      }
    }

    const summary: ImportResult['summary'] = {
      requested: uniqueIds.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      not_found: 0,
      failed: 0,
      skipped: 0,
    };
    for (const item of items) summary[item.status] += 1;
    const succeeded = summary.created + summary.updated + summary.unchanged;
    const status: SyncRunStatus =
      succeeded === uniqueIds.length ? 'COMPLETED' : succeeded === 0 ? 'FAILED' : 'PARTIAL';
    const errors: SyncRunItemError[] = items
      .filter((i) => i.error !== null)
      .map((i) => ({ externalId: i.externalId, code: i.error!.code, message: i.error!.message }));
    await persistence.finishSyncRun(run.id, { status, stats: summary, errors }, clock());

    return { syncRunId: run.id, supplierId: supplier.info.id, status, summary, items };
  }
}
