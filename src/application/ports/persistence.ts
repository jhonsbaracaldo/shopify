import type { Approval, StoredEvaluation } from '../../domain/approval.js';
import type { CatalogProduct, NormalizedProduct } from '../../domain/catalog.js';
import type {
  Classification,
  DuplicateMatch,
  ProductEvaluationResult,
} from '../../domain/classification.js';
import type { Page } from './supplier-port.js';

export type UpsertChange = 'created' | 'updated' | 'unchanged';

export type SyncRunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface SyncRunItemError {
  externalId: string;
  code: string;
  message: string;
}

export interface SyncRun {
  id: string;
  supplierId: string;
  trigger: string;
  status: SyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  stats: Record<string, number> | null;
  errors: SyncRunItemError[];
}

/** Estado derivado de la evaluación: PENDING si no existe o quedó obsoleta (producto o reglas cambiaron). */
export const EVALUATION_STATES = ['PENDING', 'CURRENT'] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];

/** Estado derivado de la decisión humana. STALE = la aprobación ya no corresponde a la evaluación vigente. */
export const APPROVAL_STATES = ['NONE', 'APPROVED', 'REJECTED', 'STALE'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const PUBLICATION_STATUSES = [
  'IN_PROGRESS',
  'PRODUCT_CREATED',
  'COMPLETED',
  'FAILED',
  'CONFLICT',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export type PublicationFilterStatus = PublicationStatus | 'NONE';

export interface Publication {
  id: string;
  productId: string;
  store: string;
  status: PublicationStatus;
  handle: string;
  externalProductId: string | null;
  approvalId: string;
  evaluationId: string;
  draftHash: string;
  attempts: number;
  /** Etapa en la que quedó el último intento: permite reanudar sin duplicar. */
  stage: 'CREATE_PRODUCT' | 'ADD_VARIANTS' | 'DONE' | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductOverview {
  product: CatalogProduct;
  latestEvaluation: StoredEvaluation | null;
  latestApproval: Approval | null;
  publication: Publication | null;
  evaluationState: EvaluationState;
  approvalState: ApprovalState;
}

export interface OverviewFilter {
  supplierId?: string;
  productIds?: string[];
  /** Solo coincide con evaluaciones vigentes (CURRENT). */
  classifications?: Classification[];
  evaluationState?: EvaluationState;
  approvalStates?: ApprovalState[];
  publicationStatuses?: PublicationFilterStatus[];
}

/** Contexto para derivar estados: reglas vigentes y tienda destino (las publicaciones son por tienda). */
export interface OverviewContext {
  rulesHash: string;
  storeKey: string;
}

export interface CatalogRepository {
  ensureSupplier(supplier: { id: string; name: string; kind: string }): Promise<void>;
  /** Inserta o actualiza por (proveedor, id externo) y variantes por (producto, id externo). */
  upsertProduct(
    data: NormalizedProduct,
    syncRunId: string | null,
    now: Date,
  ): Promise<{ product: CatalogProduct; change: UpsertChange }>;
  getProduct(id: string): Promise<CatalogProduct | null>;
  findDuplicates(product: CatalogProduct): Promise<DuplicateMatch[]>;
  getOverview(id: string, ctx: OverviewContext): Promise<ProductOverview | null>;
  listOverviews(
    filter: OverviewFilter,
    page: { page: number; pageSize: number },
    ctx: OverviewContext,
  ): Promise<Page<ProductOverview>>;
}

export interface SyncRunRepository {
  startSyncRun(supplierId: string, trigger: string, now: Date): Promise<SyncRun>;
  finishSyncRun(
    id: string,
    result: { status: SyncRunStatus; stats: Record<string, number>; errors: SyncRunItemError[] },
    now: Date,
  ): Promise<SyncRun>;
}

export interface EvaluationRepository {
  saveEvaluation(result: ProductEvaluationResult, now: Date): Promise<StoredEvaluation>;
  getLatestEvaluation(productId: string): Promise<StoredEvaluation | null>;
}

export interface ApprovalRepository {
  saveApproval(approval: Omit<Approval, 'id' | 'createdAt'>, now: Date): Promise<Approval>;
  getLatestApproval(productId: string): Promise<Approval | null>;
}

export type ClaimResult =
  { claimed: true; publication: Publication } | { claimed: false; publication: Publication };

export interface PublicationRepository {
  /**
   * Reserva atómica de la publicación (producto, tienda). Solo un proceso obtiene `claimed: true`;
   * los intentos concurrentes o repetidos reciben la publicación existente.
   */
  claimPublication(
    input: {
      productId: string;
      store: string;
      handle: string;
      approvalId: string;
      evaluationId: string;
      draftHash: string;
    },
    now: Date,
    staleAfterMs: number,
  ): Promise<ClaimResult>;
  updatePublication(
    id: string,
    patch: Partial<Pick<Publication, 'status' | 'externalProductId' | 'stage' | 'lastError'>>,
    now: Date,
  ): Promise<Publication>;
  getPublication(productId: string, store: string): Promise<Publication | null>;
}

export type IdempotencyBegin =
  | { state: 'new' }
  | { state: 'in_progress' }
  | { state: 'mismatch' }
  | { state: 'completed'; responseStatus: number; responseBody: unknown };

export interface IdempotencyRepository {
  beginIdempotent(
    scope: string,
    key: string,
    requestHash: string,
    now: Date,
    ttlMs: number,
  ): Promise<IdempotencyBegin>;
  completeIdempotent(
    scope: string,
    key: string,
    status: number,
    body: unknown,
    now: Date,
  ): Promise<void>;
  /** Libera la clave si la operación falló de forma reintentable. */
  releaseIdempotent(scope: string, key: string): Promise<void>;
}

export interface Persistence
  extends
    CatalogRepository,
    SyncRunRepository,
    EvaluationRepository,
    ApprovalRepository,
    PublicationRepository,
    IdempotencyRepository {
  readonly kind: 'memory' | 'postgres';
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
