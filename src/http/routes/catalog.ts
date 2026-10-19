import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { CatalogContext } from '../../application/context.js';
import { storeKeyOf } from '../../application/context.js';
import { ApplicationError } from '../../application/errors.js';
import type { OverviewFilter } from '../../application/ports/persistence.js';
import { CatalogQueries } from '../../application/use-cases/catalog-queries.js';
import { CreateStoreDraftUseCase } from '../../application/use-cases/create-store-draft.js';
import { EvaluateCatalogUseCase } from '../../application/use-cases/evaluate-catalog.js';
import { ImportProductsUseCase } from '../../application/use-cases/import-products.js';
import { RecordDecisionUseCase } from '../../application/use-cases/record-decision.js';
import type { AuthGuard } from '../auth.js';
import { zodIssues } from '../errors.js';
import { withIdempotency } from '../idempotency.js';
import {
  fromSupplierProductDto,
  toApprovalDto,
  toDraftResultDto,
  toEvaluateResultDto,
  toOverviewDto,
  toSupplierSummaryDto,
} from '../presenters/catalog-presenter.js';
import {
  approveBodySchema,
  candidatesQuerySchema,
  draftBodySchema,
  idParamsSchema,
  importBodySchema,
  persistentEvaluateBodySchema,
  supplierParamsSchema,
  supplierProductsQuerySchema,
} from '../schemas/catalog-schemas.js';

export interface CatalogRouteOptions {
  ctx: CatalogContext;
  auth: AuthGuard;
}

function parse<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApplicationError(
      'validation',
      'VALIDATION_ERROR',
      `${label} no válido`,
      zodIssues(result.error),
    );
  }
  return result.data;
}

const pagination = (page: {
  page: number;
  pageSize: number;
  total: number | null;
  hasMore: boolean;
}) => ({
  page: page.page,
  pageSize: page.pageSize,
  total: page.total,
  hasMore: page.hasMore,
});

/** Evaluación persistente (Fase 2) de POST /products/evaluate cuando el cuerpo no trae "product". */
export function createCatalogEvaluateHandler(ctx: CatalogContext, auth: AuthGuard) {
  const evaluate = new EvaluateCatalogUseCase(ctx);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!auth.authorize(request, reply, ['admin'])) return reply;
    const body = parse(persistentEvaluateBodySchema, request.body, 'Cuerpo');
    return withIdempotency(
      request,
      reply,
      ctx.persistence,
      { scope: 'products.evaluate', required: false, now: ctx.clock },
      async () => {
        const result = await evaluate.execute({
          productIds: body.productIds,
          limit: body.limit,
          force: body.force,
        });
        return { status: 200, body: { data: toEvaluateResultDto(result) } };
      },
    );
  };
}

export const catalogRoutes: FastifyPluginAsync<CatalogRouteOptions> = (app, { ctx, auth }) => {
  const queries = new CatalogQueries(ctx);
  const importer = new ImportProductsUseCase(ctx);
  const decisions = new RecordDecisionUseCase(ctx);
  const drafts = new CreateStoreDraftUseCase(ctx);
  const readers = auth.require(['admin', 'approver']);
  const admins = auth.require(['admin']);
  const approvers = auth.require(['approver']);

  app.get('/suppliers', { preHandler: readers }, () => ({ data: queries.listSuppliers() }));

  app.get('/store', { preHandler: readers }, () => ({
    data: { ...ctx.store.info, key: storeKeyOf(ctx.store.info), rulesVersion: ctx.rules.version },
  }));

  app.get('/suppliers/:supplierId/products', { preHandler: admins }, async (request) => {
    const { supplierId } = parse(supplierParamsSchema, request.params, 'Parámetros');
    const query = parse(supplierProductsQuerySchema, request.query, 'Query');
    const page = await queries.listSupplierProducts(supplierId, {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      shipsFromCountry: query.shipsFrom,
      categoryId: query.categoryId,
    });
    return {
      data: page.items.map(toSupplierSummaryDto),
      pagination: pagination(page),
      meta: { supplierId },
    };
  });

  app.post('/products/import', { preHandler: admins }, async (request, reply) => {
    const body = parse(importBodySchema, request.body, 'Cuerpo');
    return withIdempotency(
      request,
      reply,
      ctx.persistence,
      { scope: 'products.import', required: true, now: ctx.clock },
      async () => {
        const result = await importer.execute(
          'products' in body
            ? {
                supplierId: body.supplierId,
                products: body.products.map((p) => fromSupplierProductDto(p, body.supplierId)),
                trigger: 'api:products',
              }
            : {
                supplierId: body.supplierId,
                externalProductIds: body.externalProductIds,
                trigger: 'api:ids',
              },
        );
        return { status: 200, body: { data: result } };
      },
    );
  });

  app.get('/products/candidates', { preHandler: readers }, async (request) => {
    const q = parse(candidatesQuerySchema, request.query, 'Query');
    const filter: OverviewFilter = {
      ...(q.supplierId && { supplierId: q.supplierId }),
      ...(q.evaluation && { evaluationState: q.evaluation }),
      ...(q.approval && { approvalStates: q.approval }),
      ...(q.publication && { publicationStatuses: q.publication }),
    };
    // Por defecto, "candidatos" = evaluados vigentes que no fueron rechazados por el motor.
    if (q.classification) filter.classifications = q.classification;
    else if (!q.evaluation) filter.classifications = ['APPROVED', 'REVIEW_REQUIRED'];
    const page = await queries.listCandidates(filter, { page: q.page, pageSize: q.pageSize });
    return {
      data: page.items.map((o) => toOverviewDto(o, q.includeDetails ? 'full' : 'summary')),
      pagination: pagination(page),
      meta: { rulesVersion: ctx.rules.version, store: storeKeyOf(ctx.store.info), filter },
    };
  });

  app.get('/products/:id', { preHandler: readers }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'Parámetros');
    return { data: toOverviewDto(await queries.getProduct(id), 'full') };
  });

  app.post('/products/:id/approve', { preHandler: approvers }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'Parámetros');
    const body = parse(approveBodySchema, request.body, 'Cuerpo');
    const { approval, approvalState } = await decisions.execute({
      productId: id,
      decision: body.decision,
      evaluationId: body.evaluationId,
      reviewer: body.reviewer,
      notes: body.notes,
    });
    return { data: { approval: toApprovalDto(approval), approvalState } };
  });

  app.post('/products/:id/shopify/draft', { preHandler: admins }, async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, 'Parámetros');
    const body = parse(draftBodySchema, request.body, 'Cuerpo');
    return withIdempotency(
      request,
      reply,
      ctx.persistence,
      // La escritura exige Idempotency-Key; el dry-run no la necesita.
      { scope: `products.draft:${id}`, required: !body.dryRun, now: ctx.clock },
      async () => {
        const result = await drafts.execute({
          productId: id,
          dryRun: body.dryRun,
          confirm: body.confirm,
        });
        return {
          status: result.outcome === 'CREATED' ? 201 : 200,
          body: { data: toDraftResultDto(result) },
        };
      },
    );
  });

  return Promise.resolve();
};
