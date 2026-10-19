import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../application/errors.js';
import {
  deriveApprovalState,
  deriveEvaluationState,
  matchesOverviewFilter,
} from '../../application/overview-state.js';
import type {
  ClaimResult,
  IdempotencyBegin,
  OverviewContext,
  OverviewFilter,
  Persistence,
  ProductOverview,
  Publication,
  SyncRun,
  SyncRunItemError,
  SyncRunStatus,
  UpsertChange,
} from '../../application/ports/persistence.js';
import type { Page } from '../../application/ports/supplier-port.js';
import type { Approval, StoredEvaluation } from '../../domain/approval.js';
import type { CatalogProduct, NormalizedProduct } from '../../domain/catalog.js';
import type { DuplicateMatch, ProductEvaluationResult } from '../../domain/classification.js';

interface IdempotencyEntry {
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  responseStatus: number | null;
  responseBody: unknown;
  expiresAt: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Mismo orden que PostgreSQL para UUID (comparación binaria de la representación hexadecimal). */
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Persistencia en memoria: misma semántica que PostgreSQL (verificada por la suite de contrato),
 * pensada para pruebas y desarrollo sin Docker. Los datos se pierden al reiniciar.
 */
export class MemoryPersistence implements Persistence {
  readonly kind = 'memory' as const;
  private suppliers = new Map<string, { id: string; name: string; kind: string }>();
  private products = new Map<string, CatalogProduct>();
  private syncRuns = new Map<string, SyncRun>();
  private evaluations: StoredEvaluation[] = [];
  private approvals: Approval[] = [];
  private publications = new Map<string, Publication>();
  private idempotency = new Map<string, IdempotencyEntry>();

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  ensureSupplier(supplier: { id: string; name: string; kind: string }): Promise<void> {
    this.suppliers.set(supplier.id, { ...supplier });
    return Promise.resolve();
  }

  upsertProduct(
    data: NormalizedProduct,
    _syncRunId: string | null,
    now: Date,
  ): Promise<{ product: CatalogProduct; change: UpsertChange }> {
    if (!this.suppliers.has(data.supplierId)) {
      return Promise.reject(new Error(`Proveedor no registrado: ${data.supplierId}`));
    }
    const existing = [...this.products.values()].find(
      (p) => p.supplierId === data.supplierId && p.externalId === data.externalId,
    );

    if (existing && existing.contentHash === data.contentHash) {
      existing.lastSyncedAt = now;
      return Promise.resolve({ product: clone(existing), change: 'unchanged' });
    }

    const previousVariants = new Map(existing?.variants.map((v) => [v.externalId, v.id]) ?? []);
    const product: CatalogProduct = {
      ...clone(data),
      id: existing?.id ?? randomUUID(),
      variants: data.variants.map((v) => ({
        ...clone(v),
        id: previousVariants.get(v.externalId) ?? randomUUID(),
      })),
      version: (existing?.version ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSyncedAt: now,
    };
    this.products.set(product.id, product);
    return Promise.resolve({ product: clone(product), change: existing ? 'updated' : 'created' });
  }

  getProduct(id: string): Promise<CatalogProduct | null> {
    const product = this.products.get(id);
    return Promise.resolve(product ? clone(product) : null);
  }

  findDuplicates(product: CatalogProduct): Promise<DuplicateMatch[]> {
    const barcodes = new Set(product.variants.map((v) => v.barcode).filter((b) => b !== null));
    const skus = new Set(product.variants.map((v) => v.sku).filter((s) => s !== null));
    const matches: DuplicateMatch[] = [];
    for (const other of this.products.values()) {
      if (other.id === product.id) continue;
      const base = {
        productId: other.id,
        supplierId: other.supplierId,
        externalId: other.externalId,
        name: other.name,
      };
      if (other.dedupeKey === product.dedupeKey && product.dedupeKey !== '') {
        matches.push({ ...base, reason: 'SAME_NAME_FINGERPRINT' });
      } else if (other.variants.some((v) => v.barcode !== null && barcodes.has(v.barcode))) {
        matches.push({ ...base, reason: 'SAME_BARCODE' });
      } else if (
        other.supplierId === product.supplierId &&
        other.variants.some((v) => v.sku !== null && skus.has(v.sku))
      ) {
        matches.push({ ...base, reason: 'SAME_SKU' });
      }
    }
    return Promise.resolve(matches.sort((a, b) => compareIds(a.productId, b.productId)));
  }

  private overview(product: CatalogProduct, ctx: OverviewContext): ProductOverview {
    const latestEvaluation = this.latest(this.evaluations, product.id);
    const latestApproval = this.latest(this.approvals, product.id);
    const publication = this.publications.get(`${product.id}|${ctx.storeKey}`) ?? null;
    return clone({
      product,
      latestEvaluation,
      latestApproval,
      publication,
      evaluationState: deriveEvaluationState(product, latestEvaluation, ctx.rulesHash),
      approvalState: deriveApprovalState(product, latestEvaluation, latestApproval, ctx.rulesHash),
    });
  }

  getOverview(id: string, ctx: OverviewContext): Promise<ProductOverview | null> {
    const product = this.products.get(id);
    return Promise.resolve(product ? this.overview(product, ctx) : null);
  }

  listOverviews(
    filter: OverviewFilter,
    page: { page: number; pageSize: number },
    ctx: OverviewContext,
  ): Promise<Page<ProductOverview>> {
    const all = [...this.products.values()]
      .sort((a, b) => b.lastSyncedAt.getTime() - a.lastSyncedAt.getTime() || compareIds(a.id, b.id))
      .map((p) => this.overview(p, ctx))
      .filter((o) => matchesOverviewFilter(o, filter));
    const start = (page.page - 1) * page.pageSize;
    const items = all.slice(start, start + page.pageSize);
    return Promise.resolve({
      items,
      page: page.page,
      pageSize: page.pageSize,
      total: all.length,
      hasMore: start + items.length < all.length,
    });
  }

  startSyncRun(supplierId: string, trigger: string, now: Date): Promise<SyncRun> {
    const run: SyncRun = {
      id: randomUUID(),
      supplierId,
      trigger,
      status: 'RUNNING',
      startedAt: now,
      finishedAt: null,
      stats: null,
      errors: [],
    };
    this.syncRuns.set(run.id, run);
    return Promise.resolve(clone(run));
  }

  finishSyncRun(
    id: string,
    result: { status: SyncRunStatus; stats: Record<string, number>; errors: SyncRunItemError[] },
    now: Date,
  ): Promise<SyncRun> {
    const run = this.syncRuns.get(id);
    if (!run) return Promise.reject(new Error(`Sync run no encontrado: ${id}`));
    Object.assign(run, { ...result, finishedAt: now });
    return Promise.resolve(clone(run));
  }

  saveEvaluation(result: ProductEvaluationResult, now: Date): Promise<StoredEvaluation> {
    const stored: StoredEvaluation = { ...clone(result), id: randomUUID(), createdAt: now };
    this.evaluations.push(stored);
    return Promise.resolve(clone(stored));
  }

  getLatestEvaluation(productId: string): Promise<StoredEvaluation | null> {
    return Promise.resolve(clone(this.latest(this.evaluations, productId)));
  }

  saveApproval(approval: Omit<Approval, 'id' | 'createdAt'>, now: Date): Promise<Approval> {
    const stored: Approval = { ...approval, id: randomUUID(), createdAt: now };
    this.approvals.push(stored);
    return Promise.resolve(clone(stored));
  }

  getLatestApproval(productId: string): Promise<Approval | null> {
    return Promise.resolve(clone(this.latest(this.approvals, productId)));
  }

  /** Último registro insertado para el producto (orden de inserción, desempate estable). */
  private latest<T extends { productId: string }>(items: T[], productId: string): T | null {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]!.productId === productId) return items[i]!;
    }
    return null;
  }

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
  ): Promise<ClaimResult> {
    const key = `${input.productId}|${input.store}`;
    const existing = this.publications.get(key);
    const handleOwner = [...this.publications.values()].find(
      (p) =>
        p.store === input.store && p.handle === input.handle && p.productId !== input.productId,
    );
    if (handleOwner) {
      return Promise.reject(
        new ApplicationError(
          'conflict',
          'STORE_HANDLE_CONFLICT',
          `El handle ${input.handle} ya está reservado por otro producto`,
        ),
      );
    }
    if (!existing) {
      const publication: Publication = {
        id: randomUUID(),
        ...input,
        status: 'IN_PROGRESS',
        externalProductId: null,
        attempts: 1,
        stage: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.publications.set(key, publication);
      return Promise.resolve({ claimed: true, publication: clone(publication) });
    }
    const inProgressFresh =
      existing.status === 'IN_PROGRESS' &&
      now.getTime() - existing.updatedAt.getTime() < staleAfterMs;
    if (existing.status === 'COMPLETED' || existing.status === 'CONFLICT' || inProgressFresh) {
      return Promise.resolve({ claimed: false, publication: clone(existing) });
    }
    Object.assign(existing, {
      status: 'IN_PROGRESS',
      approvalId: input.approvalId,
      evaluationId: input.evaluationId,
      draftHash: input.draftHash,
      attempts: existing.attempts + 1,
      updatedAt: now,
    });
    return Promise.resolve({ claimed: true, publication: clone(existing) });
  }

  updatePublication(
    id: string,
    patch: Partial<Pick<Publication, 'status' | 'externalProductId' | 'stage' | 'lastError'>>,
    now: Date,
  ): Promise<Publication> {
    const publication = [...this.publications.values()].find((p) => p.id === id);
    if (!publication) return Promise.reject(new Error(`Publicación no encontrada: ${id}`));
    Object.assign(publication, patch, { updatedAt: now });
    return Promise.resolve(clone(publication));
  }

  getPublication(productId: string, store: string): Promise<Publication | null> {
    return Promise.resolve(clone(this.publications.get(`${productId}|${store}`) ?? null));
  }

  beginIdempotent(
    scope: string,
    key: string,
    requestHash: string,
    now: Date,
    ttlMs: number,
  ): Promise<IdempotencyBegin> {
    const id = `${scope}|${key}`;
    const entry = this.idempotency.get(id);
    if (!entry || entry.expiresAt <= now.getTime()) {
      this.idempotency.set(id, {
        requestHash,
        status: 'IN_PROGRESS',
        responseStatus: null,
        responseBody: null,
        expiresAt: now.getTime() + ttlMs,
      });
      return Promise.resolve({ state: 'new' });
    }
    if (entry.requestHash !== requestHash) return Promise.resolve({ state: 'mismatch' });
    if (entry.status === 'IN_PROGRESS') return Promise.resolve({ state: 'in_progress' });
    return Promise.resolve({
      state: 'completed',
      responseStatus: entry.responseStatus!,
      responseBody: clone(entry.responseBody),
    });
  }

  completeIdempotent(scope: string, key: string, status: number, body: unknown): Promise<void> {
    const entry = this.idempotency.get(`${scope}|${key}`);
    if (entry)
      Object.assign(entry, {
        status: 'COMPLETED',
        responseStatus: status,
        responseBody: clone(body),
      });
    return Promise.resolve();
  }

  releaseIdempotent(scope: string, key: string): Promise<void> {
    this.idempotency.delete(`${scope}|${key}`);
    return Promise.resolve();
  }
}
