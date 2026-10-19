import { describe, expect, it } from 'vitest';
import { DisabledStore } from '../../../src/adapters/store/disabled-store.js';
import { MockStore } from '../../../src/adapters/store/mock-store.js';
import {
  MOCK_US_PRODUCTS,
  MockUsSupplier,
} from '../../../src/adapters/suppliers/mock-us-supplier.js';
import { overviewContext } from '../../../src/application/context.js';
import type { ApplicationError } from '../../../src/application/errors.js';
import { ExternalServiceError } from '../../../src/application/errors.js';
import type { SupplierPort } from '../../../src/application/ports/supplier-port.js';
import { CreateStoreDraftUseCase } from '../../../src/application/use-cases/create-store-draft.js';
import { EvaluateCatalogUseCase } from '../../../src/application/use-cases/evaluate-catalog.js';
import { ImportProductsUseCase } from '../../../src/application/use-cases/import-products.js';
import { RecordDecisionUseCase } from '../../../src/application/use-cases/record-decision.js';
import { createTestContext, makeSupplierProduct } from '../helpers.js';

const ALL_IDS = MOCK_US_PRODUCTS.map((p) => p.externalId);

async function seededContext(store = new MockStore()) {
  const ctx = createTestContext({ store });
  await new ImportProductsUseCase(ctx).execute({
    supplierId: 'mock-us',
    externalProductIds: ALL_IDS,
    trigger: 'test',
  });
  const evaluation = await new EvaluateCatalogUseCase(ctx).execute({ limit: 100, force: false });
  const byExternal = async (externalId: string) => {
    const page = await ctx.persistence.listOverviews(
      {},
      { page: 1, pageSize: 100 },
      overviewContext(ctx),
    );
    return page.items.find((o) => o.product.externalId === externalId)!;
  };
  return { ctx, store, evaluation, byExternal };
}

async function approve(
  ctx: ReturnType<typeof createTestContext>,
  productId: string,
  notes: string | null = null,
) {
  const overview = (await ctx.persistence.getOverview(productId, overviewContext(ctx)))!;
  return new RecordDecisionUseCase(ctx).execute({
    productId,
    decision: 'APPROVED',
    evaluationId: overview.latestEvaluation!.id,
    reviewer: 'Ana Revisora',
    notes,
  });
}

describe('Importación', () => {
  it('importa por IDs externos e informa estado de validación por ítem', async () => {
    const ctx = createTestContext();
    const result = await new ImportProductsUseCase(ctx).execute({
      supplierId: 'mock-us',
      externalProductIds: ['MUS-1001', 'MUS-1010'],
      trigger: 'test',
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.summary).toMatchObject({ requested: 2, created: 2, failed: 0 });
    expect(result.items.map((i) => [i.externalId, i.validationStatus])).toEqual([
      ['MUS-1001', 'VALID'],
      ['MUS-1010', 'INCOMPLETE'],
    ]);
  });

  it('es idempotente: reimportar lo mismo no crea versiones ni duplicados', async () => {
    const ctx = createTestContext();
    const importer = new ImportProductsUseCase(ctx);
    await importer.execute({
      supplierId: 'mock-us',
      externalProductIds: ['MUS-1001', 'MUS-1001', ' MUS-1001 '],
      trigger: 'test',
    });
    const again = await importer.execute({
      supplierId: 'mock-us',
      externalProductIds: ['MUS-1001'],
      trigger: 'test',
    });
    expect(again.summary).toMatchObject({ requested: 1, unchanged: 1, created: 0 });
    const page = await ctx.persistence.listOverviews(
      {},
      { page: 1, pageSize: 10 },
      overviewContext(ctx),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]!.product.version).toBe(1);
  });

  it('reporta errores parciales explícitos (no encontrado) sin detener el lote', async () => {
    const ctx = createTestContext();
    const result = await new ImportProductsUseCase(ctx).execute({
      supplierId: 'mock-us',
      externalProductIds: ['MUS-1001', 'NO-EXISTE'],
      trigger: 'test',
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.items[1]).toMatchObject({
      status: 'not_found',
      error: { code: 'SUPPLIER_PRODUCT_NOT_FOUND' },
    });
  });

  it('errores del proveedor: falla el ítem; si es límite de frecuencia, omite el resto para reintentar luego', async () => {
    const mock = new MockUsSupplier();
    let calls = 0;
    const flaky: SupplierPort = {
      info: mock.info,
      listProducts: (q) => mock.listProducts(q),
      getVariants: (id) => mock.getVariants(id),
      getInventory: (id) => mock.getInventory(id),
      getShippingQuotes: (r) => mock.getShippingQuotes(r),
      getProduct: (id) => {
        calls += 1;
        if (id === 'MUS-1002')
          return Promise.reject(
            new ExternalServiceError('mock', 'bad_gateway', 'SUPPLIER_ERROR_X', 'falló', false),
          );
        if (id === 'MUS-1003')
          return Promise.reject(
            new ExternalServiceError(
              'mock',
              'rate_limited',
              'SUPPLIER_RATE_LIMITED',
              'límite',
              true,
              30,
            ),
          );
        return mock.getProduct(id);
      },
    };
    const ctx = createTestContext({ suppliers: [flaky] });
    const result = await new ImportProductsUseCase(ctx).execute({
      supplierId: 'mock-us',
      externalProductIds: ['MUS-1001', 'MUS-1002', 'MUS-1003', 'MUS-1004'],
      trigger: 'test',
    });
    expect(result.items.map((i) => i.status)).toEqual(['created', 'failed', 'failed', 'skipped']);
    expect(result.items[2]!.error).toMatchObject({
      code: 'SUPPLIER_RATE_LIMITED',
      retryable: true,
    });
    expect(result.status).toBe('PARTIAL');
    expect(calls).toBe(3);
  });

  it('rechaza proveedores no configurados o deshabilitados y lotes inválidos', async () => {
    const mock = new MockUsSupplier();
    const unconfigured: SupplierPort = Object.assign(Object.create(mock) as SupplierPort, {
      info: { ...mock.info, id: 'cj', configured: false },
    });
    const ctx = createTestContext({ suppliers: [mock, unconfigured] });
    const importer = new ImportProductsUseCase(ctx);
    await expect(
      importer.execute({ supplierId: 'cj', externalProductIds: ['X'], trigger: 't' }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_NOT_CONFIGURED' });
    await expect(
      importer.execute({ supplierId: 'nope', externalProductIds: ['X'], trigger: 't' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      importer.execute({
        supplierId: 'mock-us',
        externalProductIds: Array.from({ length: 51 }, (_, i) => `id-${i}`),
        trigger: 't',
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_BATCH_TOO_LARGE' });
    await expect(
      importer.execute({
        supplierId: 'mock-us',
        products: [makeSupplierProduct({ supplierId: 'otro' })],
        trigger: 't',
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_MISMATCH' });
  });
});

describe('Evaluación', () => {
  it('clasifica el catálogo mock completo, incluyendo el duplicado detectado en la base', async () => {
    const { evaluation } = await seededContext();
    expect(evaluation.summary).toEqual({
      evaluated: 10,
      unchanged: 0,
      not_found: 0,
      APPROVED: 2,
      REVIEW_REQUIRED: 4,
      REJECTED: 4,
    });
  });

  it('no reevalúa lo vigente (no invalida aprobaciones), salvo force', async () => {
    const { ctx, byExternal } = await seededContext();
    const product = await byExternal('MUS-1001');
    await approve(ctx, product.product.id);
    const evaluator = new EvaluateCatalogUseCase(ctx);
    expect((await evaluator.execute({ limit: 100, force: false })).summary.evaluated).toBe(0);
    expect(
      (await evaluator.execute({ productIds: [product.product.id], limit: 100, force: false }))
        .items[0]!.status,
    ).toBe('unchanged');
    expect((await byExternal('MUS-1001')).approvalState).toBe('APPROVED');
    await evaluator.execute({ productIds: [product.product.id], limit: 100, force: true });
    expect((await byExternal('MUS-1001')).approvalState).toBe('STALE');
  });
});

describe('Aprobación humana', () => {
  it('registra la aprobación vinculada a la evaluación vigente', async () => {
    const { ctx, byExternal } = await seededContext();
    const { product } = await byExternal('MUS-1001');
    const { approval } = await approve(ctx, product.id);
    expect(approval).toMatchObject({
      decision: 'APPROVED',
      reviewer: 'Ana Revisora',
      productContentHash: product.contentHash,
    });
    expect((await byExternal('MUS-1001')).approvalState).toBe('APPROVED');
  });

  it('no aprueba productos REJECTED y exige notas para REVIEW_REQUIRED', async () => {
    const { ctx, byExternal } = await seededContext();
    await expect(approve(ctx, (await byExternal('MUS-1004')).product.id)).rejects.toMatchObject({
      code: 'NOT_APPROVABLE',
      kind: 'unprocessable',
    });
    const review = (await byExternal('MUS-1005')).product.id;
    await expect(approve(ctx, review)).rejects.toMatchObject({ code: 'REVIEW_NOTES_REQUIRED' });
    await expect(
      approve(ctx, review, 'Verificado cumplimiento CPSC para productos infantiles'),
    ).resolves.toBeDefined();
  });

  it('rechaza decisiones sobre una evaluación que no es la vigente', async () => {
    const { ctx, byExternal } = await seededContext();
    const { product } = await byExternal('MUS-1001');
    await expect(
      new RecordDecisionUseCase(ctx).execute({
        productId: product.id,
        decision: 'APPROVED',
        evaluationId: '00000000-0000-4000-8000-000000000000',
        reviewer: 'Ana',
        notes: null,
      }),
    ).rejects.toMatchObject({ code: 'EVALUATION_MISMATCH', kind: 'conflict' });
  });
});

describe('Publicación de borradores', () => {
  async function approvedProduct(store = new MockStore()) {
    const seeded = await seededContext(store);
    const { product } = await seeded.byExternal('MUS-1001');
    await approve(seeded.ctx, product.id);
    return { ...seeded, productId: product.id, drafts: new CreateStoreDraftUseCase(seeded.ctx) };
  }

  it('sin aprobación humana no se prepara ni se publica, aunque el motor diga APPROVED', async () => {
    const { ctx, byExternal } = await seededContext();
    const product = await byExternal('MUS-1002');
    expect(product.latestEvaluation!.classification).toBe('APPROVED');
    await expect(
      new CreateStoreDraftUseCase(ctx).execute({
        productId: product.product.id,
        dryRun: true,
        confirm: false,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('dry-run: valida, verifica equivalentes y devuelve la carga útil sin escribir', async () => {
    const { drafts, productId, store } = await approvedProduct();
    const result = await drafts.execute({ productId, dryRun: true, confirm: false });
    expect(result.outcome).toBe('DRY_RUN');
    expect(result.draft).toMatchObject({ status: 'DRAFT', handle: 'dsp-mock-us-mus-1001' });
    expect(result.draft.variants.map((v) => v.priceCents)).toEqual([2999, 2999]);
    expect(result.checks.map((c) => [c.name, c.passed])).toEqual([
      ['HUMAN_APPROVAL', true],
      ['CONTENT_READY', true],
      ['NO_EQUIVALENT_IN_STORE', true],
    ]);
    expect(result.prepared).not.toBeNull();
    expect(store.calls.filter((c) => c.startsWith('createDraftProduct'))).toEqual([]);
  });

  it('escribir exige confirm=true, y crea el borrador una sola vez (idempotente)', async () => {
    const { drafts, productId, store } = await approvedProduct();
    await expect(
      drafts.execute({ productId, dryRun: false, confirm: false }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const created = await drafts.execute({ productId, dryRun: false, confirm: true });
    expect(created.outcome).toBe('CREATED');
    expect(created.storeProduct).toMatchObject({
      status: 'DRAFT',
      handle: 'dsp-mock-us-mus-1001',
      variantsCount: 2,
    });
    expect(created.publication).toMatchObject({ status: 'COMPLETED', stage: 'DONE', attempts: 1 });

    const again = await drafts.execute({ productId, dryRun: false, confirm: true });
    expect(again.outcome).toBe('ALREADY_EXISTS');
    expect(store.snapshot()).toHaveLength(1);
    expect(store.snapshot()[0]).toMatchObject({ status: 'DRAFT', variants: 2 });
  });

  it('solicitudes concurrentes crean un único borrador', async () => {
    const { drafts, productId, store } = await approvedProduct();
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => drafts.execute({ productId, dryRun: false, confirm: true })),
    );
    expect(store.calls.filter((c) => c.startsWith('createDraftProduct'))).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'CREATED'),
    ).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected')
        expect((r.reason as ApplicationError).code).toBe('PUBLICATION_IN_PROGRESS');
    }
  });

  it('error parcial al asociar variantes: queda registrado y el reintento reanuda sin duplicar el producto', async () => {
    const store = new MockStore();
    store.failures.addVariants = [MockStore.transientError('fallo al crear variantes')];
    const { drafts, productId } = await approvedProduct(store);
    const error = (await drafts
      .execute({ productId, dryRun: false, confirm: true })
      .catch((e: unknown) => e)) as ApplicationError;
    expect(error.context).toMatchObject({
      stage: 'ADD_VARIANTS',
      partial: true,
      externalProductId: 'gid://mock-shopify/Product/1',
    });

    const retry = await drafts.execute({ productId, dryRun: false, confirm: true });
    expect(retry.outcome).toBe('CREATED');
    expect(retry.publication).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(store.calls.filter((c) => c.startsWith('createDraftProduct'))).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('resultado desconocido al crear (timeout): el reintento adopta el borrador en lugar de duplicarlo', async () => {
    const store = new MockStore();
    store.failures.createDraftProduct = [MockStore.transientError()];
    const { drafts, productId } = await approvedProduct(store);
    await expect(drafts.execute({ productId, dryRun: false, confirm: true })).rejects.toMatchObject(
      { code: 'STORE_OUTCOME_UNKNOWN' },
    );
    // Simula que Shopify sí lo creó antes del timeout.
    store.seedExisting('dsp-mock-us-mus-1001', 'DRAFT');
    const retry = await drafts.execute({ productId, dryRun: false, confirm: true });
    expect(retry.outcome).toBe('CREATED');
    expect(store.snapshot()).toHaveLength(1);
  });

  it('si ya existe un producto equivalente creado por otra vía, no crea un duplicado (409)', async () => {
    const store = new MockStore();
    store.seedExisting('dsp-mock-us-mus-1001', 'ACTIVE');
    const { drafts, productId } = await approvedProduct(store);
    const dry = await drafts.execute({ productId, dryRun: true, confirm: false });
    expect(dry.checks.find((c) => c.name === 'NO_EQUIVALENT_IN_STORE')!.passed).toBe(false);
    await expect(drafts.execute({ productId, dryRun: false, confirm: true })).rejects.toMatchObject(
      { code: 'STORE_PRODUCT_EXISTS', kind: 'conflict' },
    );
    expect(store.calls.filter((c) => c.startsWith('createDraftProduct'))).toHaveLength(0);
  });

  it('escritura deshabilitada o tienda deshabilitada bloquean la creación', async () => {
    const store = new MockStore();
    store.info.writeEnabled = false;
    const { drafts, productId } = await approvedProduct(store);
    await expect(drafts.execute({ productId, dryRun: false, confirm: true })).rejects.toMatchObject(
      { code: 'STORE_WRITE_DISABLED', kind: 'forbidden' },
    );

    const disabled = await approvedProduct(new DisabledStore() as unknown as MockStore);
    expect(
      (
        await disabled.drafts.execute({
          productId: disabled.productId,
          dryRun: true,
          confirm: false,
        })
      ).outcome,
    ).toBe('DRY_RUN');
    await expect(
      disabled.drafts.execute({ productId: disabled.productId, dryRun: false, confirm: true }),
    ).rejects.toMatchObject({ code: 'STORE_DISABLED' });
  });

  it('si el producto cambia tras la aprobación, la aprobación deja de ser válida', async () => {
    const { ctx, drafts, productId } = await approvedProduct();
    const changed = structuredClone(MOCK_US_PRODUCTS[0]!);
    changed.variants[0]!.costCents = 1500;
    await new ImportProductsUseCase(ctx).execute({
      supplierId: 'mock-us',
      products: [changed],
      trigger: 'test',
    });
    await expect(drafts.execute({ productId, dryRun: true, confirm: false })).rejects.toMatchObject(
      { code: 'EVALUATION_STALE' },
    );
    await new EvaluateCatalogUseCase(ctx).execute({
      productIds: [productId],
      limit: 10,
      force: false,
    });
    await expect(drafts.execute({ productId, dryRun: true, confirm: false })).rejects.toMatchObject(
      { code: 'APPROVAL_STALE' },
    );
  });
});
