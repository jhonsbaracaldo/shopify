import { checkPublicationAuthorization } from '../../domain/approval.js';
import { buildStoreDraft, type StoreDraft } from '../../domain/store-draft.js';
import { overviewContext, storeKeyOf, type CatalogContext } from '../context.js';
import { ApplicationError, notFound } from '../errors.js';
import type { Publication } from '../ports/persistence.js';
import type { PreparedStoreProduct, StoreProductRef } from '../ports/store-port.js';

/** Tiempo tras el cual un intento IN_PROGRESS sin actualizar se considera abandonado. */
export const PUBLICATION_STALE_AFTER_MS = 10 * 60 * 1000;

export interface DraftInput {
  productId: string;
  /** true (por defecto): solo valida y prepara; no escribe nada en la tienda. */
  dryRun: boolean;
  /** Confirmación explícita requerida para escribir. */
  confirm: boolean;
}

export type DraftOutcome = 'DRY_RUN' | 'CREATED' | 'ALREADY_EXISTS';

export interface DraftResult {
  outcome: DraftOutcome;
  productId: string;
  store: { key: string; mode: string; writeEnabled: boolean };
  checks: { name: string; passed: boolean; detail: string }[];
  draft: StoreDraft;
  prepared: PreparedStoreProduct | null;
  equivalentStoreProduct: StoreProductRef | null;
  storeProduct: StoreProductRef | null;
  publication: Publication | null;
}

/**
 * Prepara y, solo si todo está autorizado, crea un producto BORRADOR en la tienda.
 * Barreras (todas obligatorias para escribir):
 *   1. Aprobación humana vigente sobre la evaluación vigente.
 *   2. Contenido válido (variantes elegibles, opciones coherentes).
 *   3. Sin producto equivalente previo en la tienda (por handle determinista).
 *   4. dryRun=false + confirm=true en la solicitud.
 *   5. Tienda habilitada; en modo live además SHOPIFY_WRITE_ENABLED=true.
 * Idempotencia: una publicación por (producto, tienda) reservada atómicamente; los reintentos
 * reanudan la etapa pendiente en lugar de crear duplicados.
 */
export class CreateStoreDraftUseCase {
  constructor(private readonly ctx: CatalogContext) {}

  async execute(input: DraftInput): Promise<DraftResult> {
    const { persistence, rules, store, clock, logger } = this.ctx;
    const storeKey = storeKeyOf(store.info);
    const overview = await persistence.getOverview(input.productId, overviewContext(this.ctx));
    if (!overview) throw notFound('Producto', input.productId);
    const { product, latestEvaluation, latestApproval } = overview;

    const auth = checkPublicationAuthorization(
      product,
      latestEvaluation,
      latestApproval,
      rules.hash,
    );
    if (!auth.ok) throw new ApplicationError('conflict', auth.code, auth.message);
    const evaluation = latestEvaluation!;
    const approval = latestApproval!;

    const { draft, issues } = buildStoreDraft(product, evaluation, { vendor: this.ctx.vendorName });
    if (!draft) {
      throw new ApplicationError(
        'unprocessable',
        'DRAFT_NOT_READY',
        'El producto no tiene la información requerida para un borrador',
        issues,
      );
    }

    const storeInfo = {
      key: storeKey,
      mode: store.info.mode,
      writeEnabled: store.info.writeEnabled,
    };
    const checks: DraftResult['checks'] = [
      {
        name: 'HUMAN_APPROVAL',
        passed: true,
        detail: `aprobado por ${approval.reviewer} sobre la evaluación ${evaluation.id}`,
      },
      {
        name: 'CONTENT_READY',
        passed: true,
        detail: `${draft.variants.length} variante(s) elegible(s), estado DRAFT`,
      },
    ];

    const existing = overview.publication;
    if (existing?.status === 'COMPLETED') {
      return {
        outcome: 'ALREADY_EXISTS',
        productId: product.id,
        store: storeInfo,
        checks,
        draft,
        prepared: null,
        equivalentStoreProduct: null,
        storeProduct: existing.externalProductId
          ? {
              id: existing.externalProductId,
              handle: existing.handle,
              title: draft.title,
              status: 'DRAFT',
              variantsCount: null,
              adminUrl: null,
            }
          : null,
        publication: existing,
      };
    }

    const equivalent =
      store.info.mode === 'disabled' ? null : await store.findProductByHandle(draft.handle);
    // Un intento previo con resultado desconocido (timeout al crear) pudo dejar el borrador creado.
    const adoptable =
      equivalent !== null &&
      existing !== null &&
      existing.externalProductId === null &&
      existing.stage === 'CREATE_PRODUCT' &&
      equivalent.status === 'DRAFT';
    const ours =
      equivalent !== null && (existing?.externalProductId === equivalent.id || adoptable);
    checks.push({
      name: 'NO_EQUIVALENT_IN_STORE',
      passed: equivalent === null || ours,
      detail:
        store.info.mode === 'disabled'
          ? 'no verificado: tienda deshabilitada'
          : equivalent === null
            ? `no existe un producto con handle ${draft.handle}`
            : ours
              ? `existe el borrador de un intento previo de este backend (${equivalent.id}): se reanudará`
              : `ya existe ${equivalent.id} (${equivalent.status}) con handle ${draft.handle}`,
    });

    if (input.dryRun) {
      return {
        outcome: 'DRY_RUN',
        productId: product.id,
        store: storeInfo,
        checks,
        draft,
        prepared: store.prepareProduct(draft),
        equivalentStoreProduct: equivalent,
        storeProduct: null,
        publication: existing,
      };
    }

    // --- A partir de aquí se escribe: todas las barreras deben cumplirse. ---
    if (store.info.mode === 'disabled') {
      throw new ApplicationError(
        'forbidden',
        'STORE_DISABLED',
        'La tienda está deshabilitada (SHOPIFY_MODE=disabled)',
      );
    }
    if (!store.info.writeEnabled) {
      throw new ApplicationError(
        'forbidden',
        'STORE_WRITE_DISABLED',
        'Escritura deshabilitada: active SHOPIFY_WRITE_ENABLED=true explícitamente para crear borradores',
      );
    }
    if (!input.confirm) {
      throw new ApplicationError(
        'unprocessable',
        'CONFIRMATION_REQUIRED',
        'Para escribir en la tienda envíe dryRun=false y confirm=true',
      );
    }
    if (equivalent !== null && !ours) {
      throw new ApplicationError(
        'conflict',
        'STORE_PRODUCT_EXISTS',
        `Ya existe un producto con handle ${draft.handle} en la tienda (${equivalent.id}); no se crea un duplicado`,
      ).withContext({ storeProductId: equivalent.id });
    }

    const claim = await persistence.claimPublication(
      {
        productId: product.id,
        store: storeKey,
        handle: draft.handle,
        approvalId: approval.id,
        evaluationId: evaluation.id,
        draftHash: draft.draftHash,
      },
      clock(),
      PUBLICATION_STALE_AFTER_MS,
    );
    if (!claim.claimed) {
      if (claim.publication.status === 'COMPLETED') {
        return {
          outcome: 'ALREADY_EXISTS',
          productId: product.id,
          store: storeInfo,
          checks,
          draft,
          prepared: null,
          equivalentStoreProduct: equivalent,
          storeProduct: null,
          publication: claim.publication,
        };
      }
      throw new ApplicationError(
        'conflict',
        claim.publication.status === 'CONFLICT'
          ? 'STORE_PRODUCT_CONFLICT'
          : 'PUBLICATION_IN_PROGRESS',
        `La publicación está en estado ${claim.publication.status}`,
      ).withContext({ publicationId: claim.publication.id });
    }

    let publication = claim.publication;
    const fail = async (
      stage: 'CREATE_PRODUCT' | 'ADD_VARIANTS',
      error: unknown,
    ): Promise<never> => {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'error desconocido';
      publication = await persistence.updatePublication(
        publication.id,
        { status: 'FAILED', stage, lastError: message },
        clock(),
      );
      logger.warn(
        { productId: product.id, publicationId: publication.id, stage, error: message },
        'Falló la creación del borrador',
      );
      const base =
        error instanceof ApplicationError
          ? error
          : new ApplicationError(
              'bad_gateway',
              'STORE_ERROR',
              'Error al crear el borrador en la tienda',
            );
      throw base.withContext({
        publicationId: publication.id,
        stage,
        externalProductId: publication.externalProductId,
        partial: stage === 'ADD_VARIANTS',
        hint: 'Reintente la misma solicitud: se reanudará la etapa pendiente sin duplicar el producto',
      });
    };

    let storeProduct: StoreProductRef | null = null;
    if (publication.externalProductId) {
      storeProduct = await store.getProduct(publication.externalProductId);
    }
    if (!storeProduct) {
      // Revalidación tras la reserva: un intento previo con resultado desconocido pudo crearlo.
      const found = await store.findProductByHandle(draft.handle);
      if (found) {
        const previousUnknown =
          publication.attempts > 1 &&
          publication.stage === 'CREATE_PRODUCT' &&
          found.status === 'DRAFT';
        if (!previousUnknown) {
          publication = await persistence.updatePublication(
            publication.id,
            { status: 'CONFLICT', lastError: `handle ocupado por ${found.id}` },
            clock(),
          );
          throw new ApplicationError(
            'conflict',
            'STORE_PRODUCT_EXISTS',
            `Ya existe ${found.id} con handle ${draft.handle}`,
          ).withContext({ publicationId: publication.id });
        }
        storeProduct = found;
        logger.info(
          { productId: product.id, storeProductId: found.id },
          'Se adopta el borrador creado por un intento previo con resultado desconocido',
        );
      } else {
        publication = await persistence.updatePublication(
          publication.id,
          { stage: 'CREATE_PRODUCT', lastError: null },
          clock(),
        );
        try {
          storeProduct = await store.createDraftProduct(draft);
        } catch (error) {
          return fail('CREATE_PRODUCT', error);
        }
      }
      publication = await persistence.updatePublication(
        publication.id,
        { status: 'PRODUCT_CREATED', externalProductId: storeProduct.id, stage: 'ADD_VARIANTS' },
        clock(),
      );
    }

    try {
      await store.addVariants(storeProduct, draft);
    } catch (error) {
      return fail('ADD_VARIANTS', error);
    }
    publication = await persistence.updatePublication(
      publication.id,
      { status: 'COMPLETED', stage: 'DONE', lastError: null },
      clock(),
    );
    // Estado final real (p. ej. número de variantes). Si la lectura falla, el borrador ya existe:
    // se informa la referencia obtenida al crearlo.
    const createdRef = storeProduct;
    storeProduct = (await store.getProduct(createdRef.id).catch(() => null)) ?? createdRef;
    logger.info(
      { productId: product.id, storeProductId: storeProduct.id, store: storeKey },
      'Borrador creado en la tienda',
    );

    return {
      outcome: 'CREATED',
      productId: product.id,
      store: storeInfo,
      checks,
      draft,
      prepared: null,
      equivalentStoreProduct: null,
      storeProduct,
      publication,
    };
  }
}
