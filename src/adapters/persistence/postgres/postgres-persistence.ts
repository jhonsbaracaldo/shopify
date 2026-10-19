import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ApplicationError } from '../../../application/errors.js';
import { deriveApprovalState, deriveEvaluationState } from '../../../application/overview-state.js';
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
} from '../../../application/ports/persistence.js';
import type { Page } from '../../../application/ports/supplier-port.js';
import type { Approval, StoredEvaluation } from '../../../domain/approval.js';
import type {
  CatalogProduct,
  CatalogVariant,
  NormalizedProduct,
  ValidationStatus,
} from '../../../domain/catalog.js';
import type { DuplicateMatch, ProductEvaluationResult } from '../../../domain/classification.js';

type Queryable = pg.Pool | pg.PoolClient;

interface ProductRow {
  id: string;
  supplier_id: string;
  external_id: string;
  sku: string | null;
  name: string;
  description: string | null;
  category: string | null;
  images: string[];
  currency: string;
  validation_status: ValidationStatus;
  validation_issues: CatalogProduct['validation']['issues'];
  content_hash: string;
  dedupe_key: string;
  version: number;
  first_seen_at: Date;
  last_synced_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  external_id: string;
  sku: string | null;
  name: string | null;
  options: Record<string, string>;
  barcode: string | null;
  cost_cents: number | null;
  suggested_retail_cents: number | null;
  weight_grams: number | null;
  image_url: string | null;
  inventory: CatalogVariant['inventory'];
  shipping_quotes: CatalogVariant['shippingQuotes'];
}

interface PublicationRow {
  id: string;
  product_id: string;
  store: string;
  status: Publication['status'];
  handle: string;
  external_product_id: string | null;
  approval_id: string;
  evaluation_id: string;
  draft_hash: string;
  attempts: number;
  stage: Publication['stage'];
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ApprovalRow {
  id: string;
  product_id: string;
  evaluation_id: string;
  decision: Approval['decision'];
  reviewer: string;
  notes: string | null;
  product_content_hash: string;
  rules_hash: string;
  created_at: Date;
}

const toProduct = (row: ProductRow, variants: VariantRow[]): CatalogProduct => ({
  id: row.id,
  supplierId: row.supplier_id,
  externalId: row.external_id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  category: row.category,
  images: row.images,
  currency: row.currency,
  validation: { status: row.validation_status, issues: row.validation_issues },
  contentHash: row.content_hash,
  dedupeKey: row.dedupe_key,
  version: row.version,
  firstSeenAt: row.first_seen_at,
  lastSyncedAt: row.last_synced_at,
  variants: variants.map((v) => ({
    id: v.id,
    externalId: v.external_id,
    sku: v.sku,
    name: v.name,
    options: v.options,
    barcode: v.barcode,
    costCents: v.cost_cents,
    suggestedRetailCents: v.suggested_retail_cents,
    weightGrams: v.weight_grams,
    imageUrl: v.image_url,
    inventory: v.inventory,
    shippingQuotes: v.shipping_quotes,
  })),
});

const toPublication = (r: PublicationRow): Publication => ({
  id: r.id,
  productId: r.product_id,
  store: r.store,
  status: r.status,
  handle: r.handle,
  externalProductId: r.external_product_id,
  approvalId: r.approval_id,
  evaluationId: r.evaluation_id,
  draftHash: r.draft_hash,
  attempts: r.attempts,
  stage: r.stage,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  productId: r.product_id,
  evaluationId: r.evaluation_id,
  decision: r.decision,
  reviewer: r.reviewer,
  notes: r.notes,
  productContentHash: r.product_content_hash,
  rulesHash: r.rules_hash,
  createdAt: r.created_at,
});

const toEvaluation = (r: {
  id: string;
  result: ProductEvaluationResult;
  created_at: Date;
}): StoredEvaluation => ({
  ...r.result,
  id: r.id,
  createdAt: r.created_at,
});

const json = (value: unknown) => JSON.stringify(value);

/** Persistencia PostgreSQL. Las operaciones de varias sentencias se ejecutan en transacción. */
export class PostgresPersistence implements Persistence {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(connectionString: string): PostgresPersistence {
    const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
    return new PostgresPersistence(pool);
  }

  get rawPool(): pg.Pool {
    return this.pool;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureSupplier(supplier: { id: string; name: string; kind: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO suppliers (id, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`,
      [supplier.id, supplier.name, supplier.kind],
    );
  }

  async upsertProduct(
    data: NormalizedProduct,
    syncRunId: string | null,
    now: Date,
  ): Promise<{ product: CatalogProduct; change: UpsertChange }> {
    return this.transaction(async (client) => {
      const selectExisting = () =>
        client.query<{ id: string; content_hash: string }>(
          'SELECT id, content_hash FROM products WHERE supplier_id = $1 AND external_id = $2 FOR UPDATE',
          [data.supplierId, data.externalId],
        );

      let existing = (await selectExisting()).rows[0];
      let change: UpsertChange;
      let productId: string;

      if (!existing) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO products (id, supplier_id, external_id, sku, name, description, category, images, currency,
             validation_status, validation_issues, content_hash, dedupe_key, version, first_seen_at, last_synced_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$14,$14)
           ON CONFLICT (supplier_id, external_id) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            data.supplierId,
            data.externalId,
            data.sku,
            data.name,
            data.description,
            data.category,
            json(data.images),
            data.currency,
            data.validation.status,
            json(data.validation.issues),
            data.contentHash,
            data.dedupeKey,
            now,
          ],
        );
        if (inserted.rows[0]) {
          productId = inserted.rows[0].id;
          change = 'created';
          await this.replaceVariants(client, productId, data);
          await this.recordHistory(
            client,
            productId,
            syncRunId,
            change,
            null,
            data.contentHash,
            now,
          );
          return { product: (await this.loadProducts(client, [productId]))[0]!, change };
        }
        // Otra transacción lo insertó en paralelo: se continúa como actualización.
        existing = (await selectExisting()).rows[0]!;
      }

      productId = existing.id;
      if (existing.content_hash === data.contentHash) {
        change = 'unchanged';
        await client.query('UPDATE products SET last_synced_at = $2 WHERE id = $1', [
          productId,
          now,
        ]);
      } else {
        change = 'updated';
        await client.query(
          `UPDATE products SET sku=$2, name=$3, description=$4, category=$5, images=$6, currency=$7,
             validation_status=$8, validation_issues=$9, content_hash=$10, dedupe_key=$11,
             version = version + 1, last_synced_at=$12, updated_at=$12
           WHERE id = $1`,
          [
            productId,
            data.sku,
            data.name,
            data.description,
            data.category,
            json(data.images),
            data.currency,
            data.validation.status,
            json(data.validation.issues),
            data.contentHash,
            data.dedupeKey,
            now,
          ],
        );
        await this.replaceVariants(client, productId, data);
      }
      await this.recordHistory(
        client,
        productId,
        syncRunId,
        change,
        existing.content_hash,
        data.contentHash,
        now,
      );
      return { product: (await this.loadProducts(client, [productId]))[0]!, change };
    });
  }

  /** Inserta/actualiza variantes por (producto, id externo) conservando su id; elimina las retiradas. */
  private async replaceVariants(client: pg.PoolClient, productId: string, data: NormalizedProduct) {
    for (const [position, v] of data.variants.entries()) {
      await client.query(
        `INSERT INTO product_variants (id, product_id, position, external_id, sku, name, options, barcode, cost_cents,
           suggested_retail_cents, weight_grams, image_url, inventory, shipping_quotes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (product_id, external_id) DO UPDATE SET
           position=EXCLUDED.position, sku=EXCLUDED.sku, name=EXCLUDED.name, options=EXCLUDED.options,
           barcode=EXCLUDED.barcode, cost_cents=EXCLUDED.cost_cents,
           suggested_retail_cents=EXCLUDED.suggested_retail_cents, weight_grams=EXCLUDED.weight_grams,
           image_url=EXCLUDED.image_url, inventory=EXCLUDED.inventory, shipping_quotes=EXCLUDED.shipping_quotes`,
        [
          randomUUID(),
          productId,
          position,
          v.externalId,
          v.sku,
          v.name,
          json(v.options),
          v.barcode,
          v.costCents,
          v.suggestedRetailCents,
          v.weightGrams,
          v.imageUrl,
          v.inventory === null ? null : json(v.inventory),
          v.shippingQuotes === null ? null : json(v.shippingQuotes),
        ],
      );
    }
    await client.query(
      'DELETE FROM product_variants WHERE product_id = $1 AND NOT (external_id = ANY($2))',
      [productId, data.variants.map((v) => v.externalId)],
    );
  }

  private async recordHistory(
    client: pg.PoolClient,
    productId: string,
    syncRunId: string | null,
    change: UpsertChange,
    previousHash: string | null,
    newHash: string,
    now: Date,
  ) {
    await client.query(
      `INSERT INTO product_sync_history (product_id, sync_run_id, change_type, previous_hash, new_hash, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [productId, syncRunId, change, previousHash, newHash, now],
    );
  }

  private async loadProducts(db: Queryable, ids: string[]): Promise<CatalogProduct[]> {
    if (ids.length === 0) return [];
    const products = await db.query<ProductRow>(
      'SELECT * FROM products WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const variants = await db.query<VariantRow>(
      'SELECT * FROM product_variants WHERE product_id = ANY($1::uuid[]) ORDER BY product_id, position',
      [ids],
    );
    const byProduct = new Map<string, VariantRow[]>();
    for (const v of variants.rows)
      byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
    const map = new Map(products.rows.map((r) => [r.id, toProduct(r, byProduct.get(r.id) ?? [])]));
    return ids.map((id) => map.get(id)).filter((p): p is CatalogProduct => p !== undefined);
  }

  async getProduct(id: string): Promise<CatalogProduct | null> {
    return (await this.loadProducts(this.pool, [id]))[0] ?? null;
  }

  async findDuplicates(product: CatalogProduct): Promise<DuplicateMatch[]> {
    const barcodes = product.variants.map((v) => v.barcode).filter((b): b is string => b !== null);
    const skus = product.variants.map((v) => v.sku).filter((s): s is string => s !== null);
    const { rows } = await this.pool.query<{
      id: string;
      supplier_id: string;
      external_id: string;
      name: string;
      reason: DuplicateMatch['reason'];
    }>(
      `SELECT p.id, p.supplier_id, p.external_id, p.name,
         CASE WHEN p.dedupe_key = $2 AND $2 <> '' THEN 'SAME_NAME_FINGERPRINT'
              WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.barcode = ANY($3)) THEN 'SAME_BARCODE'
              ELSE 'SAME_SKU' END AS reason
       FROM products p
       WHERE p.id <> $1 AND (
         (p.dedupe_key = $2 AND $2 <> '')
         OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.barcode = ANY($3))
         OR (p.supplier_id = $4 AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku = ANY($5)))
       )
       ORDER BY p.id`,
      [product.id, product.dedupeKey, barcodes, product.supplierId, skus],
    );
    return rows.map((r) => ({
      productId: r.id,
      supplierId: r.supplier_id,
      externalId: r.external_id,
      name: r.name,
      reason: r.reason,
    }));
  }

  private async loadOverviews(ids: string[], ctx: OverviewContext): Promise<ProductOverview[]> {
    if (ids.length === 0) return [];
    const products = await this.loadProducts(this.pool, ids);
    const evaluations = await this.pool.query<{
      product_id: string;
      id: string;
      result: ProductEvaluationResult;
      created_at: Date;
    }>(
      `SELECT DISTINCT ON (product_id) product_id, id, result, created_at
       FROM evaluations WHERE product_id = ANY($1::uuid[]) ORDER BY product_id, seq DESC`,
      [ids],
    );
    const approvals = await this.pool.query<ApprovalRow>(
      `SELECT DISTINCT ON (product_id) * FROM approvals WHERE product_id = ANY($1::uuid[]) ORDER BY product_id, seq DESC`,
      [ids],
    );
    const publications = await this.pool.query<PublicationRow>(
      'SELECT * FROM store_publications WHERE product_id = ANY($1::uuid[]) AND store = $2',
      [ids, ctx.storeKey],
    );
    const evalBy = new Map(evaluations.rows.map((r) => [r.product_id, toEvaluation(r)]));
    const apprBy = new Map(approvals.rows.map((r) => [r.product_id, toApproval(r)]));
    const pubBy = new Map(publications.rows.map((r) => [r.product_id, toPublication(r)]));
    return products.map((product) => {
      const latestEvaluation = evalBy.get(product.id) ?? null;
      const latestApproval = apprBy.get(product.id) ?? null;
      return {
        product,
        latestEvaluation,
        latestApproval,
        publication: pubBy.get(product.id) ?? null,
        evaluationState: deriveEvaluationState(product, latestEvaluation, ctx.rulesHash),
        approvalState: deriveApprovalState(
          product,
          latestEvaluation,
          latestApproval,
          ctx.rulesHash,
        ),
      };
    });
  }

  async getOverview(id: string, ctx: OverviewContext): Promise<ProductOverview | null> {
    return (await this.loadOverviews([id], ctx))[0] ?? null;
  }

  async listOverviews(
    filter: OverviewFilter,
    page: { page: number; pageSize: number },
    ctx: OverviewContext,
  ): Promise<Page<ProductOverview>> {
    const { rows } = await this.pool.query<{ id: string; total: string }>(
      `WITH base AS (
         SELECT p.id, p.supplier_id, p.last_synced_at, e.classification,
           CASE WHEN e.id IS NOT NULL AND e.product_content_hash = p.content_hash AND e.rules_hash = $1
                THEN 'CURRENT' ELSE 'PENDING' END AS evaluation_state,
           CASE WHEN a.id IS NULL THEN 'NONE'
                WHEN e.id IS NULL OR a.evaluation_id <> e.id OR a.product_content_hash <> p.content_hash
                     OR e.product_content_hash <> p.content_hash OR e.rules_hash <> $1 THEN 'STALE'
                ELSE a.decision END AS approval_state,
           COALESCE(sp.status, 'NONE') AS publication_status
         FROM products p
         LEFT JOIN LATERAL (SELECT id, classification, product_content_hash, rules_hash FROM evaluations
                            WHERE product_id = p.id ORDER BY seq DESC LIMIT 1) e ON true
         LEFT JOIN LATERAL (SELECT id, evaluation_id, decision, product_content_hash FROM approvals
                            WHERE product_id = p.id ORDER BY seq DESC LIMIT 1) a ON true
         LEFT JOIN store_publications sp ON sp.product_id = p.id AND sp.store = $10
       )
       SELECT id, COUNT(*) OVER () AS total FROM base
       WHERE ($2::text IS NULL OR supplier_id = $2)
         AND ($3::uuid[] IS NULL OR id = ANY($3))
         AND ($4::text[] IS NULL OR (evaluation_state = 'CURRENT' AND classification = ANY($4)))
         AND ($5::text IS NULL OR evaluation_state = $5)
         AND ($6::text[] IS NULL OR approval_state = ANY($6))
         AND ($7::text[] IS NULL OR publication_status = ANY($7))
       ORDER BY last_synced_at DESC, id
       LIMIT $8 OFFSET $9`,
      [
        ctx.rulesHash,
        filter.supplierId ?? null,
        filter.productIds ?? null,
        filter.classifications ?? null,
        filter.evaluationState ?? null,
        filter.approvalStates ?? null,
        filter.publicationStatuses ?? null,
        page.pageSize,
        (page.page - 1) * page.pageSize,
        ctx.storeKey,
      ],
    );
    let total = rows[0] ? Number(rows[0].total) : 0;
    if (rows.length === 0 && page.page > 1) {
      // Página fuera de rango: se calcula el total igualmente para informar al cliente.
      const count = await this.listOverviews(filter, { page: 1, pageSize: 1 }, ctx);
      total = count.total ?? 0;
    }
    const items = await this.loadOverviews(
      rows.map((r) => r.id),
      ctx,
    );
    const start = (page.page - 1) * page.pageSize;
    return {
      items,
      page: page.page,
      pageSize: page.pageSize,
      total,
      hasMore: start + items.length < total,
    };
  }

  async startSyncRun(supplierId: string, trigger: string, now: Date): Promise<SyncRun> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO sync_runs (id, supplier_id, trigger, status, started_at) VALUES ($1,$2,$3,'RUNNING',$4)`,
      [id, supplierId, trigger, now],
    );
    return {
      id,
      supplierId,
      trigger,
      status: 'RUNNING',
      startedAt: now,
      finishedAt: null,
      stats: null,
      errors: [],
    };
  }

  async finishSyncRun(
    id: string,
    result: { status: SyncRunStatus; stats: Record<string, number>; errors: SyncRunItemError[] },
    now: Date,
  ): Promise<SyncRun> {
    const { rows } = await this.pool.query<{
      id: string;
      supplier_id: string;
      trigger: string;
      status: SyncRunStatus;
      started_at: Date;
      finished_at: Date;
      stats: Record<string, number>;
      errors: SyncRunItemError[];
    }>(
      `UPDATE sync_runs SET status=$2, stats=$3, errors=$4, finished_at=$5 WHERE id=$1 RETURNING *`,
      [id, result.status, json(result.stats), json(result.errors), now],
    );
    const r = rows[0];
    if (!r) throw new Error(`Sync run no encontrado: ${id}`);
    return {
      id: r.id,
      supplierId: r.supplier_id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      stats: r.stats,
      errors: r.errors,
    };
  }

  async saveEvaluation(result: ProductEvaluationResult, now: Date): Promise<StoredEvaluation> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO evaluations (id, product_id, product_content_hash, rules_version, rules_hash, classification, result, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        result.productId,
        result.productContentHash,
        result.rulesVersion,
        result.rulesHash,
        result.classification,
        json(result),
        now,
      ],
    );
    return { ...structuredClone(result), id, createdAt: now };
  }

  async getLatestEvaluation(productId: string): Promise<StoredEvaluation | null> {
    const { rows } = await this.pool.query<{
      id: string;
      result: ProductEvaluationResult;
      created_at: Date;
    }>(
      'SELECT id, result, created_at FROM evaluations WHERE product_id = $1 ORDER BY seq DESC LIMIT 1',
      [productId],
    );
    return rows[0] ? toEvaluation(rows[0]) : null;
  }

  async saveApproval(approval: Omit<Approval, 'id' | 'createdAt'>, now: Date): Promise<Approval> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `INSERT INTO approvals (id, product_id, evaluation_id, decision, reviewer, notes, product_content_hash, rules_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        randomUUID(),
        approval.productId,
        approval.evaluationId,
        approval.decision,
        approval.reviewer,
        approval.notes,
        approval.productContentHash,
        approval.rulesHash,
        now,
      ],
    );
    return toApproval(rows[0]!);
  }

  async getLatestApproval(productId: string): Promise<Approval | null> {
    const { rows } = await this.pool.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE product_id = $1 ORDER BY seq DESC LIMIT 1',
      [productId],
    );
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async claimPublication(
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
    try {
      const inserted = await this.pool.query<PublicationRow>(
        `INSERT INTO store_publications (id, product_id, store, status, handle, approval_id, evaluation_id, draft_hash,
           attempts, created_at, updated_at)
         VALUES ($1,$2,$3,'IN_PROGRESS',$4,$5,$6,$7,1,$8,$8)
         ON CONFLICT (product_id, store) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          input.productId,
          input.store,
          input.handle,
          input.approvalId,
          input.evaluationId,
          input.draftHash,
          now,
        ],
      );
      if (inserted.rows[0]) return { claimed: true, publication: toPublication(inserted.rows[0]) };
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      // Con inserciones concurrentes del MISMO producto, PostgreSQL puede reportar la violación en
      // el índice único (store, handle), que no es el árbitro del ON CONFLICT. Si ya existe la
      // fila de este producto en esta tienda, es una reserva concurrente: se continúa abajo.
      const own = await this.pool.query(
        'SELECT 1 FROM store_publications WHERE product_id = $1 AND store = $2',
        [input.productId, input.store],
      );
      if (own.rowCount === 0) {
        throw new ApplicationError(
          'conflict',
          'STORE_HANDLE_CONFLICT',
          `El handle ${input.handle} ya está reservado por otro producto`,
        );
      }
    }

    const reclaimed = await this.pool.query<PublicationRow>(
      `UPDATE store_publications
       SET status='IN_PROGRESS', approval_id=$3, evaluation_id=$4, draft_hash=$5, attempts=attempts+1, updated_at=$6
       WHERE product_id=$1 AND store=$2
         AND (status IN ('FAILED','PRODUCT_CREATED')
              OR (status='IN_PROGRESS' AND updated_at < $6::timestamptz - make_interval(secs => $7::double precision / 1000)))
       RETURNING *`,
      [
        input.productId,
        input.store,
        input.approvalId,
        input.evaluationId,
        input.draftHash,
        now,
        staleAfterMs,
      ],
    );
    if (reclaimed.rows[0]) return { claimed: true, publication: toPublication(reclaimed.rows[0]) };

    const current = await this.pool.query<PublicationRow>(
      'SELECT * FROM store_publications WHERE product_id=$1 AND store=$2',
      [input.productId, input.store],
    );
    return { claimed: false, publication: toPublication(current.rows[0]!) };
  }

  async updatePublication(
    id: string,
    patch: Partial<Pick<Publication, 'status' | 'externalProductId' | 'stage' | 'lastError'>>,
    now: Date,
  ): Promise<Publication> {
    const { rows } = await this.pool.query<PublicationRow>(
      `UPDATE store_publications SET
         status = COALESCE($2, status),
         external_product_id = CASE WHEN $3::boolean THEN $4 ELSE external_product_id END,
         stage = CASE WHEN $5::boolean THEN $6 ELSE stage END,
         last_error = CASE WHEN $7::boolean THEN $8 ELSE last_error END,
         updated_at = $9
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.status ?? null,
        'externalProductId' in patch,
        patch.externalProductId ?? null,
        'stage' in patch,
        patch.stage ?? null,
        'lastError' in patch,
        patch.lastError ?? null,
        now,
      ],
    );
    if (!rows[0]) throw new Error(`Publicación no encontrada: ${id}`);
    return toPublication(rows[0]);
  }

  async getPublication(productId: string, store: string): Promise<Publication | null> {
    const { rows } = await this.pool.query<PublicationRow>(
      'SELECT * FROM store_publications WHERE product_id=$1 AND store=$2',
      [productId, store],
    );
    return rows[0] ? toPublication(rows[0]) : null;
  }

  async beginIdempotent(
    scope: string,
    key: string,
    requestHash: string,
    now: Date,
    ttlMs: number,
  ): Promise<IdempotencyBegin> {
    await this.pool.query(
      'DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2 AND expires_at <= $3',
      [scope, key, now],
    );
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at, expires_at)
       VALUES ($1,$2,$3,'IN_PROGRESS',$4,$5) ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
      [scope, key, requestHash, now, new Date(now.getTime() + ttlMs)],
    );
    if (inserted.rowCount === 1) return { state: 'new' };
    const { rows } = await this.pool.query<{
      request_hash: string;
      status: 'IN_PROGRESS' | 'COMPLETED';
      response_status: number | null;
      response_body: unknown;
    }>(
      'SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE scope=$1 AND key=$2',
      [scope, key],
    );
    const row = rows[0];
    if (!row) return this.beginIdempotent(scope, key, requestHash, now, ttlMs);
    if (row.request_hash !== requestHash) return { state: 'mismatch' };
    if (row.status === 'IN_PROGRESS') return { state: 'in_progress' };
    return {
      state: 'completed',
      responseStatus: row.response_status!,
      responseBody: row.response_body,
    };
  }

  async completeIdempotent(
    scope: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET status='COMPLETED', response_status=$3, response_body=$4 WHERE scope=$1 AND key=$2`,
      [scope, key, status, json(body)],
    );
  }

  async releaseIdempotent(scope: string, key: string): Promise<void> {
    await this.pool.query('DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]);
  }
}
