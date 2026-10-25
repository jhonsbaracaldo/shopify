import { beforeEach, describe, expect, it } from 'vitest';
import type { OverviewContext, Persistence } from '../../src/application/ports/persistence.js';
import { normalizeSupplierProduct } from '../../src/domain/catalog.js';
import { classifyProduct } from '../../src/domain/classification.js';
import { defaultRules, makeSupplierProduct, makeVariant } from '../phase2/helpers.js';

/**
 * Suite de contrato: toda implementación de `Persistence` debe pasarla.
 * Se ejecuta con MemoryPersistence (siempre) y con PostgresPersistence (si hay TEST_DATABASE_URL).
 */
export function persistenceContract(name: string, factory: () => Promise<Persistence>) {
  describe(`Persistence contract — ${name}`, () => {
    let db: Persistence;
    const t0 = new Date('2026-10-18T12:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const ctx: OverviewContext = { rulesHash: defaultRules.hash, storeKey: 'shopify:mock' };

    beforeEach(async () => {
      db = await factory();
      await db.ensureSupplier({ id: 'test-sup', name: 'Proveedor de prueba', kind: 'mock' });
      await db.ensureSupplier({ id: 'otro-sup', name: 'Otro proveedor', kind: 'mock' });
    });

    const upsert = (overrides: Parameters<typeof makeSupplierProduct>[0] = {}, now = t0) =>
      db.upsertProduct(normalizeSupplierProduct(makeSupplierProduct(overrides)), null, now);

    async function evaluateAndSave(productId: string, now = at(1000)) {
      const product = (await db.getProduct(productId))!;
      return db.saveEvaluation(classifyProduct(product, defaultRules, { duplicates: [] }), now);
    }

    describe('catálogo e idempotencia de importación', () => {
      it('crea, luego reconoce contenido idéntico como unchanged sin nueva versión', async () => {
        const first = await upsert();
        expect(first.change).toBe('created');
        expect(first.product.version).toBe(1);
        const again = await upsert({}, at(5000));
        expect(again.change).toBe('unchanged');
        expect(again.product.id).toBe(first.product.id);
        expect(again.product.version).toBe(1);
        expect(again.product.lastSyncedAt.toISOString()).toBe(at(5000).toISOString());
      });

      it('actualiza al cambiar el contenido, conserva IDs de variantes y elimina las retiradas', async () => {
        const first = await upsert({
          variants: [makeVariant({ externalId: 'A' }), makeVariant({ externalId: 'B' })],
        });
        const idA = first.product.variants.find((v) => v.externalId === 'A')!.id;
        const updated = await upsert(
          {
            variants: [
              makeVariant({ externalId: 'A', costCents: 1111 }),
              makeVariant({ externalId: 'C' }),
            ],
          },
          at(1),
        );
        expect(updated.change).toBe('updated');
        expect(updated.product.version).toBe(2);
        expect(updated.product.variants.map((v) => v.externalId)).toEqual(['A', 'C']);
        expect(updated.product.variants[0]!.id).toBe(idA);
        expect(updated.product.variants[0]!.costCents).toBe(1111);
      });

      it('no duplica por (proveedor, id externo) ni con importaciones concurrentes', async () => {
        const results = await Promise.all([upsert(), upsert(), upsert()]);
        expect(new Set(results.map((r) => r.product.id)).size).toBe(1);
        expect(results.filter((r) => r.change === 'created')).toHaveLength(1);
        const page = await db.listOverviews({}, { page: 1, pageSize: 10 }, ctx);
        expect(page.total).toBe(1);
      });

      it('el mismo id externo en otro proveedor es otro producto', async () => {
        const a = await upsert();
        const b = await upsert({ supplierId: 'otro-sup' });
        expect(a.product.id).not.toBe(b.product.id);
      });

      it('preserva variantes con inventario o envío desconocido (null) y datos JSON', async () => {
        const { product } = await upsert({
          variants: [
            makeVariant({ inventory: null, shippingQuotes: null, options: { Color: 'Negro' } }),
          ],
        });
        const loaded = (await db.getProduct(product.id))!;
        expect(loaded.variants[0]).toMatchObject({
          inventory: null,
          shippingQuotes: null,
          options: { Color: 'Negro' },
        });
        expect(loaded.validation.status).toBe('INCOMPLETE');
      });
    });

    describe('duplicados', () => {
      it('detecta misma huella de nombre, mismo código de barras y mismo SKU del mismo proveedor', async () => {
        const base = await upsert({
          externalId: 'BASE',
          name: 'Botella térmica de acero 1 L',
          variants: [makeVariant({ externalId: 'v', sku: 'SKU-1', barcode: '0001' })],
        });
        await upsert({
          externalId: 'NAME',
          name: 'botella termica 1 l acero',
          variants: [makeVariant({ externalId: 'v', sku: 'X1' })],
        });
        await upsert({
          externalId: 'BAR',
          supplierId: 'otro-sup',
          name: 'Otro nombre',
          variants: [makeVariant({ externalId: 'v', sku: 'X2', barcode: '0001' })],
        });
        await upsert({
          externalId: 'SKU',
          name: 'Nombre distinto',
          variants: [makeVariant({ externalId: 'v', sku: 'SKU-1' })],
        });
        await upsert({
          externalId: 'NADA',
          name: 'Algo sin relación',
          variants: [makeVariant({ externalId: 'v', sku: 'Z' })],
        });
        const matches = await db.findDuplicates(base.product);
        expect(matches.map((m) => [m.externalId, m.reason]).sort()).toEqual([
          ['BAR', 'SAME_BARCODE'],
          ['NAME', 'SAME_NAME_FINGERPRINT'],
          ['SKU', 'SAME_SKU'],
        ]);
      });
    });

    describe('evaluaciones, aprobaciones y estados derivados', () => {
      it('la evaluación queda PENDING si no existe o si cambió el producto o las reglas', async () => {
        const { product } = await upsert();
        expect((await db.getOverview(product.id, ctx))!.evaluationState).toBe('PENDING');
        const evaluation = await evaluateAndSave(product.id);
        expect((await db.getLatestEvaluation(product.id))!.id).toBe(evaluation.id);
        expect((await db.getOverview(product.id, ctx))!.evaluationState).toBe('CURRENT');
        expect(
          (await db.getOverview(product.id, { ...ctx, rulesHash: 'otras' }))!.evaluationState,
        ).toBe('PENDING');
        await upsert({ description: 'cambió' }, at(2000));
        expect((await db.getOverview(product.id, ctx))!.evaluationState).toBe('PENDING');
      });

      it('la aprobación queda STALE si hay una evaluación más nueva', async () => {
        const { product } = await upsert();
        const e1 = await evaluateAndSave(product.id);
        await db.saveApproval(
          {
            productId: product.id,
            evaluationId: e1.id,
            decision: 'APPROVED',
            reviewer: 'Ana',
            notes: null,
            productContentHash: product.contentHash,
            rulesHash: defaultRules.hash,
          },
          at(2000),
        );
        expect((await db.getOverview(product.id, ctx))!.approvalState).toBe('APPROVED');
        await evaluateAndSave(product.id, at(3000));
        const overview = (await db.getOverview(product.id, ctx))!;
        expect(overview.approvalState).toBe('STALE');
        expect(overview.latestApproval!.reviewer).toBe('Ana');
      });

      it('filtra y pagina candidatos por clasificación, aprobación y publicación', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const { product } = await upsert(
            { externalId: `P-${i}`, name: `Producto ${i}` },
            at(i * 10),
          );
          ids.push(product.id);
        }
        const rejected = (
          await upsert(
            { externalId: 'REJ', name: 'Rechazado', variants: [makeVariant({ inventory: [] })] },
            at(100),
          )
        ).product;
        for (const id of [...ids, rejected.id]) await evaluateAndSave(id);

        const approved = await db.listOverviews(
          { classifications: ['APPROVED'] },
          { page: 1, pageSize: 2 },
          ctx,
        );
        expect(approved).toMatchObject({ total: 5, hasMore: true });
        expect(approved.items).toHaveLength(2);
        // Orden: sincronizados más recientemente primero.
        expect(approved.items.map((o) => o.product.externalId)).toEqual(['P-4', 'P-3']);
        const last = await db.listOverviews(
          { classifications: ['APPROVED'] },
          { page: 3, pageSize: 2 },
          ctx,
        );
        expect(last).toMatchObject({ total: 5, hasMore: false });
        expect(last.items).toHaveLength(1);

        const rej = await db.listOverviews(
          { classifications: ['REJECTED'] },
          { page: 1, pageSize: 10 },
          ctx,
        );
        expect(rej.items.map((o) => o.product.id)).toEqual([rejected.id]);

        const none = await db.listOverviews(
          { approvalStates: ['NONE'], publicationStatuses: ['NONE'], supplierId: 'test-sup' },
          { page: 1, pageSize: 10 },
          ctx,
        );
        expect(none.total).toBe(6);
        const pending = await db.listOverviews(
          { evaluationState: 'PENDING' },
          { page: 1, pageSize: 10 },
          ctx,
        );
        expect(pending.total).toBe(0);
        const byIds = await db.listOverviews(
          { productIds: [ids[0]!] },
          { page: 1, pageSize: 10 },
          ctx,
        );
        expect(byIds.items.map((o) => o.product.id)).toEqual([ids[0]]);
        const outOfRange = await db.listOverviews({}, { page: 50, pageSize: 10 }, ctx);
        expect(outOfRange).toMatchObject({ items: [], total: 6, hasMore: false });
      });
    });

    describe('publicaciones: reserva atómica e idempotencia', () => {
      async function setupApproved() {
        const { product } = await upsert();
        const evaluation = await evaluateAndSave(product.id);
        const approval = await db.saveApproval(
          {
            productId: product.id,
            evaluationId: evaluation.id,
            decision: 'APPROVED',
            reviewer: 'Ana',
            notes: null,
            productContentHash: product.contentHash,
            rulesHash: defaultRules.hash,
          },
          at(2000),
        );
        return {
          input: {
            productId: product.id,
            store: 'shopify:mock',
            handle: 'dsp-test-sup-p-1',
            approvalId: approval.id,
            evaluationId: evaluation.id,
            draftHash: 'h1',
          },
        };
      }

      it('solo una reserva concurrente gana; las demás reciben la publicación existente', async () => {
        const { input } = await setupApproved();
        const results = await Promise.all(
          Array.from({ length: 10 }, () => db.claimPublication(input, at(3000), 600_000)),
        );
        expect(results.filter((r) => r.claimed)).toHaveLength(1);
        expect(new Set(results.map((r) => r.publication.id)).size).toBe(1);
      });

      it('permite reanudar tras FAILED o IN_PROGRESS abandonado, nunca tras COMPLETED', async () => {
        const { input } = await setupApproved();
        const first = await db.claimPublication(input, at(3000), 600_000);
        expect(first).toMatchObject({
          claimed: true,
          publication: { status: 'IN_PROGRESS', attempts: 1 },
        });
        expect((await db.claimPublication(input, at(4000), 600_000)).claimed).toBe(false);
        // Abandonado (más viejo que staleAfter) → se puede reclamar.
        const stale = await db.claimPublication(input, at(3000 + 700_000), 600_000);
        expect(stale).toMatchObject({ claimed: true, publication: { attempts: 2 } });

        await db.updatePublication(
          stale.publication.id,
          {
            status: 'FAILED',
            stage: 'ADD_VARIANTS',
            externalProductId: 'gid://x/1',
            lastError: 'boom',
          },
          at(800_000),
        );
        const retry = await db.claimPublication(input, at(900_000), 600_000);
        expect(retry).toMatchObject({
          claimed: true,
          publication: { attempts: 3, externalProductId: 'gid://x/1', stage: 'ADD_VARIANTS' },
        });

        await db.updatePublication(
          retry.publication.id,
          { status: 'COMPLETED', stage: 'DONE', lastError: null },
          at(1_000_000),
        );
        const done = await db.claimPublication(input, at(2_000_000), 600_000);
        expect(done).toMatchObject({
          claimed: false,
          publication: { status: 'COMPLETED', lastError: null },
        });
        expect((await db.getPublication(input.productId, 'shopify:mock'))!.status).toBe(
          'COMPLETED',
        );
      });

      it('un handle no puede reservarse para dos productos distintos en la misma tienda', async () => {
        const { input } = await setupApproved();
        await db.claimPublication(input, at(3000), 600_000);
        const other = (await upsert({ externalId: 'OTRO', name: 'Otro producto' })).product;
        await expect(
          db.claimPublication({ ...input, productId: other.id }, at(3000), 600_000),
        ).rejects.toMatchObject({ code: 'STORE_HANDLE_CONFLICT' });
      });

      it('las publicaciones son por tienda: una publicación mock no afecta a la tienda real', async () => {
        const { input } = await setupApproved();
        await db.claimPublication(input, at(3000), 600_000);
        const live = await db.claimPublication(
          { ...input, store: 'shopify:live:x.myshopify.com' },
          at(3000),
          600_000,
        );
        expect(live.claimed).toBe(true);
        expect((await db.getOverview(input.productId, ctx))!.publication!.store).toBe(
          'shopify:mock',
        );
        expect(
          (await db.getOverview(input.productId, { ...ctx, storeKey: 'shopify:otra' }))!
            .publication,
        ).toBeNull();
      });
    });

    describe('claves de idempotencia', () => {
      it('new → in_progress → completed (replay) / mismatch / release / expiración', async () => {
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-a', t0, 60_000)).toEqual({
          state: 'new',
        });
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-a', at(1), 60_000)).toEqual({
          state: 'in_progress',
        });
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-b', at(1), 60_000)).toEqual({
          state: 'mismatch',
        });
        await db.completeIdempotent('s', 'key-1234', 201, { data: { ok: true } }, at(2));
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-a', at(3), 60_000)).toEqual({
          state: 'completed',
          responseStatus: 201,
          responseBody: { data: { ok: true } },
        });
        // Otro scope con la misma clave es independiente.
        expect(await db.beginIdempotent('otro', 'key-1234', 'hash-a', at(3), 60_000)).toEqual({
          state: 'new',
        });
        // Expirada → se trata como nueva.
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-z', at(61_000), 60_000)).toEqual({
          state: 'new',
        });
        await db.releaseIdempotent('s', 'key-1234');
        expect(await db.beginIdempotent('s', 'key-1234', 'hash-a', at(62_000), 60_000)).toEqual({
          state: 'new',
        });
      });
    });

    describe('historial de sincronización', () => {
      it('registra inicio y fin con estadísticas y errores', async () => {
        const run = await db.startSyncRun('test-sup', 'test', t0);
        expect(run.status).toBe('RUNNING');
        const done = await db.finishSyncRun(
          run.id,
          {
            status: 'PARTIAL',
            stats: { created: 1, failed: 1 },
            errors: [{ externalId: 'X', code: 'E', message: 'm' }],
          },
          at(1000),
        );
        expect(done).toMatchObject({
          status: 'PARTIAL',
          stats: { created: 1, failed: 1 },
          errors: [{ externalId: 'X' }],
        });
        expect(done.finishedAt!.toISOString()).toBe(at(1000).toISOString());
      });
    });
  });
}
