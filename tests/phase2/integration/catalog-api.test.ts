import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockStore } from '../../../src/adapters/store/mock-store.js';
import { MockSupplierCatalog } from '../../../src/adapters/suppliers/mock-supplier-catalog.js';
import { silentLogger } from '../../../src/application/ports/logger.js';
import { createSuppliers } from '../../../src/composition.js';
import { loadConfig } from '../../../src/config/env.js';
import { buildApp } from '../../../src/http/app.js';
import { ADMIN_KEY, APPROVER_KEY, createTestContext } from '../helpers.js';
import { makeProductDto } from '../../fixtures.js';

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ADMIN_API_KEY: ADMIN_KEY,
  APPROVER_API_KEY: APPROVER_KEY,
});
const admin = { 'x-api-key': ADMIN_KEY };
const approver = { 'x-api-key': APPROVER_KEY };

let app: FastifyInstance;
let store: MockStore;

beforeEach(async () => {
  store = new MockStore();
  const ctx = createTestContext({ store, suppliers: createSuppliers(config, silentLogger) });
  app = await buildApp({ config, catalog: new MockSupplierCatalog(), catalogContext: ctx });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

type Body = { data: any; pagination?: any; error?: any };
const body = (res: LightMyRequestResponse) => res.json<Body>();

async function importAll(key = 'import-key-0001') {
  const list = body(
    await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers/mock-us/products?shipsFrom=US&pageSize=100',
      headers: admin,
    }),
  );
  return app.inject({
    method: 'POST',
    url: '/api/v1/products/import',
    headers: { ...admin, 'idempotency-key': key },
    payload: {
      supplierId: 'mock-us',
      externalProductIds: list.data.map((p: { externalId: string }) => p.externalId),
    },
  });
}

async function importAndEvaluate() {
  await importAll();
  return app.inject({
    method: 'POST',
    url: '/api/v1/products/evaluate',
    headers: admin,
    payload: {},
  });
}

async function findCandidate(externalId: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/products/candidates?classification=APPROVED,REVIEW_REQUIRED,REJECTED&pageSize=100',
    headers: admin,
  });
  return body(res).data.find((p: { externalId: string }) => p.externalId === externalId);
}

describe('Autenticación y roles', () => {
  it('401 sin clave o con clave inválida; 403 con la clave de otro rol', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/suppliers' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/suppliers',
          headers: { 'x-api-key': 'x'.repeat(40) },
        })
      ).statusCode,
    ).toBe(401);
    const asApprover = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: { ...approver, 'idempotency-key': 'k-00000001' },
      payload: { supplierId: 'mock-us', externalProductIds: ['MUS-1001'] },
    });
    expect(asApprover.statusCode).toBe(403);
    const asAdmin = await app.inject({
      method: 'POST',
      url: '/api/v1/products/00000000-0000-4000-8000-000000000000/approve',
      headers: admin,
      payload: {},
    });
    expect(asAdmin.statusCode).toBe(403);
    expect(body(asAdmin).error.code).toBe('FORBIDDEN');
  });

  it('503 si las claves no están configuradas (falla cerrado)', async () => {
    const noKeys = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const closed = await buildApp({
      config: noKeys,
      catalog: new MockSupplierCatalog(),
      catalogContext: createTestContext(),
    });
    const res = await closed.inject({
      method: 'GET',
      url: '/api/v1/products/candidates',
      headers: admin,
    });
    expect(res.statusCode).toBe(503);
    expect(body(res).error.code).toBe('AUTH_NOT_CONFIGURED');
    await closed.close();
  });

  it('los endpoints de la Fase 1 siguen funcionando sin clave', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/products' })).statusCode).toBe(200);
    const legacy = await app.inject({
      method: 'POST',
      url: '/api/v1/products/evaluate',
      payload: { product: makeProductDto() },
    });
    expect(legacy.statusCode).toBe(200);
    expect(body(legacy).data.eligible).toBe(true);
  });
});

describe('Proveedores', () => {
  it('lista proveedores con su estado sin exponer credenciales', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/suppliers', headers: approver });
    expect(res.statusCode).toBe(200);
    const suppliers = body(res).data;
    expect(
      suppliers.map((s: { id: string; configured: boolean; enabled: boolean }) => [
        s.id,
        s.enabled,
        s.configured,
      ]),
    ).toEqual([
      ['mock-us', true, true],
      ['cj', false, false],
    ]);
    expect(res.body).not.toMatch(/apiKey|token|secret/i);
  });

  it('lista productos del proveedor con paginación y filtro de país de despacho', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers/mock-us/products?shipsFrom=us&page=2&pageSize=4',
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).pagination).toEqual({ page: 2, pageSize: 4, total: 10, hasMore: true });
    expect(body(res).data[0]).toMatchObject({ externalId: 'MUS-1005', listCost: 11 });
  });

  it('proveedor deshabilitado → 503; inexistente → 404; query inválida → 400', async () => {
    const cj = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers/cj/products',
      headers: admin,
    });
    expect(cj.statusCode).toBe(503);
    expect(body(cj).error.code).toBe('SUPPLIER_DISABLED');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/suppliers/nope/products', headers: admin }))
        .statusCode,
    ).toBe(404);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers/mock-us/products?pageSize=500',
      headers: admin,
    });
    expect(bad.statusCode).toBe(400);
    expect(body(bad).error.details[0].path).toBe('pageSize');
  });
});

describe('Importación con idempotencia', () => {
  it('exige Idempotency-Key, repite la respuesta original y rechaza reusar la clave con otro cuerpo', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: admin,
      payload: { supplierId: 'mock-us', externalProductIds: ['MUS-1001'] },
    });
    expect(missing.statusCode).toBe(400);
    expect(body(missing).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await importAll('import-key-abc1');
    expect(first.statusCode).toBe(200);
    expect(body(first).data.summary).toMatchObject({ requested: 10, created: 10 });

    const replay = await importAll('import-key-abc1');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(body(replay).data.syncRunId).toBe(body(first).data.syncRunId);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: { ...admin, 'idempotency-key': 'import-key-abc1' },
      payload: { supplierId: 'mock-us', externalProductIds: ['MUS-1001'] },
    });
    expect(reused.statusCode).toBe(422);
    expect(body(reused).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Una clave nueva reimporta, pero los datos no cambian: todo "unchanged".
    const again = await importAll('import-key-abc2');
    expect(body(again).data.summary).toMatchObject({ unchanged: 10, created: 0 });
  });

  it('acepta productos ya normalizados (USD) y valida su forma', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: { ...admin, 'idempotency-key': 'import-key-prod1' },
      payload: {
        supplierId: 'mock-us',
        products: [
          {
            externalId: 'EXT-1',
            name: 'Producto externo',
            currency: 'USD',
            variants: [
              {
                externalId: 'V1',
                cost: 5.5,
                inventory: [{ warehouseId: 'w', countryCode: 'US', quantity: 50 }],
              },
            ],
          },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(body(ok).data.items[0]).toMatchObject({
      status: 'created',
      validationStatus: 'INCOMPLETE',
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: { ...admin, 'idempotency-key': 'import-key-prod2' },
      payload: {
        supplierId: 'mock-us',
        products: [
          {
            externalId: 'X',
            name: 'X',
            currency: 'USD',
            variants: [{ externalId: 'V', cost: -1, inventory: null }],
          },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('Evaluación persistente y candidatos', () => {
  it('evalúa pendientes y resume por clasificación', async () => {
    const res = await importAndEvaluate();
    expect(res.statusCode).toBe(200);
    expect(body(res).data.summary).toEqual({
      evaluated: 10,
      unchanged: 0,
      not_found: 0,
      APPROVED: 2,
      REVIEW_REQUIRED: 4,
      REJECTED: 4,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/products/evaluate',
      headers: admin,
      payload: {},
    });
    expect(body(again).data.summary.evaluated).toBe(0);
  });

  it('la evaluación persistente requiere la clave admin', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/products/evaluate', payload: {} }))
        .statusCode,
    ).toBe(401);
  });

  it('candidatos: por defecto APPROVED+REVIEW_REQUIRED, con filtros y paginación', async () => {
    await importAndEvaluate();
    const def = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates',
      headers: approver,
    });
    expect(body(def).pagination.total).toBe(6);
    expect(
      body(def).data.every((p: { classification: string }) => p.classification !== 'REJECTED'),
    ).toBe(true);
    expect(body(def).data[0]).toMatchObject({
      evaluationState: 'CURRENT',
      approvalState: 'NONE',
      publicationStatus: 'NONE',
    });
    expect(body(def).data[0].product).toBeUndefined();

    const approved = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates?classification=APPROVED&includeDetails=true',
      headers: admin,
    });
    expect(
      body(approved)
        .data.map((p: { externalId: string }) => p.externalId)
        .sort(),
    ).toEqual(['MUS-1001', 'MUS-1002']);
    expect(body(approved).data[0].product.variants.length).toBeGreaterThan(0);

    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates?classification=REJECTED&pageSize=3&page=2',
      headers: admin,
    });
    expect(body(page).pagination).toEqual({ page: 2, pageSize: 3, total: 4, hasMore: false });

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates?evaluation=PENDING',
      headers: admin,
    });
    expect(body(pending).pagination.total).toBe(0);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates?classification=MAYBE',
      headers: admin,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('detalle de producto con evaluación completa (USD) y errores 400/404', async () => {
    await importAndEvaluate();
    const candidate = await findCandidate('MUS-1006');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${candidate.id}`,
      headers: admin,
    });
    const data = body(res).data;
    expect(data.classification).toBe('REVIEW_REQUIRED');
    expect(data.latestEvaluation.variants[0]).toMatchObject({
      recommendedPrice: 82.99,
      proposedSalePrice: 79.99,
      priceCapped: true,
    });
    expect(data.latestEvaluation.variants[0].economics).toMatchObject({
      customerAcquisitionCost: 6,
      estimatedProfit: 14.42,
      estimatedProfitMarginPercent: 18.03,
    });
    expect(data.latestEvaluation.notes.join(' ')).toMatch(/no son ganancias netas definitivas/);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/products/no-uuid', headers: admin }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/products/00000000-0000-4000-8000-000000000000',
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('Aprobación humana y borrador en tienda', () => {
  it('flujo completo: aprobar (approver) → dry-run → crear borrador (admin) → idempotencia', async () => {
    await importAndEvaluate();
    const candidate = await findCandidate('MUS-1001');

    const noApproval = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers: admin,
      payload: {},
    });
    expect(noApproval.statusCode).toBe(409);
    expect(body(noApproval).error.code).toBe('APPROVAL_REQUIRED');

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/approve`,
      headers: approver,
      payload: { evaluationId: candidate.latestEvaluation.id, reviewer: 'Ana Revisora' },
    });
    expect(approve.statusCode).toBe(200);
    expect(body(approve).data).toMatchObject({
      approvalState: 'APPROVED',
      approval: { decision: 'APPROVED', reviewer: 'Ana Revisora' },
    });

    const dry = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers: admin,
      payload: {},
    });
    expect(dry.statusCode).toBe(200);
    expect(body(dry).data).toMatchObject({
      outcome: 'DRY_RUN',
      store: { key: 'shopify:mock', mode: 'mock' },
      draft: { status: 'DRAFT', variants: [{ price: 29.99 }, { price: 29.99 }] },
    });
    expect(store.snapshot()).toHaveLength(0);

    const noKey = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers: admin,
      payload: { dryRun: false, confirm: true },
    });
    expect(body(noKey).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const headers = { ...admin, 'idempotency-key': `draft-${candidate.id}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers,
      payload: { dryRun: false, confirm: true },
    });
    expect(created.statusCode).toBe(201);
    expect(body(created).data).toMatchObject({
      outcome: 'CREATED',
      storeProduct: { status: 'DRAFT' },
      publication: { status: 'COMPLETED' },
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers,
      payload: { dryRun: false, confirm: true },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const otherKey = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${candidate.id}/shopify/draft`,
      headers: { ...admin, 'idempotency-key': 'otra-clave-123' },
      payload: { dryRun: false, confirm: true },
    });
    expect(body(otherKey).data.outcome).toBe('ALREADY_EXISTS');
    expect(store.snapshot()).toHaveLength(1);

    const published = await app.inject({
      method: 'GET',
      url: '/api/v1/products/candidates?approval=APPROVED&publication=COMPLETED',
      headers: admin,
    });
    expect(body(published).data.map((p: { externalId: string }) => p.externalId)).toEqual([
      'MUS-1001',
    ]);
  });

  it('errores de aprobación: REJECTED → 422, evaluación equivocada → 409, cuerpo inválido → 400', async () => {
    await importAndEvaluate();
    const rejected = await findCandidate('MUS-1004');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${rejected.id}/approve`,
      headers: approver,
      payload: { evaluationId: rejected.latestEvaluation.id, reviewer: 'Ana' },
    });
    expect(res.statusCode).toBe(422);
    expect(body(res).error.code).toBe('NOT_APPROVABLE');

    const ok = await findCandidate('MUS-1001');
    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${ok.id}/approve`,
      headers: approver,
      payload: { evaluationId: rejected.latestEvaluation.id, reviewer: 'Ana' },
    });
    expect(mismatch.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${ok.id}/approve`,
      headers: approver,
      payload: { reviewer: 'A' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('health informa componentes sin secretos', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(body(res as never) as unknown).toMatchObject({
      status: 'ok',
      components: {
        persistence: { kind: 'memory', ok: true },
        store: { mode: 'mock' },
        auth: { adminKeyConfigured: true },
      },
    });
    expect(res.body).not.toContain(ADMIN_KEY);
  });
});
