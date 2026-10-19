import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { EvaluateProductUseCase } from '../../application/use-cases/evaluate-product.js';
import type { ListProductsUseCase } from '../../application/use-cases/list-products.js';
import { errorBody, zodIssues } from '../errors.js';
import {
  fromProductDto,
  toEvaluationDto,
  toEvaluationOverrides,
  toProductDto,
} from '../presenters/product-presenter.js';
import { evaluateRequestSchema } from '../schemas/product-schemas.js';

export interface ProductRouteOptions {
  listProducts: ListProductsUseCase;
  evaluateProduct: EvaluateProductUseCase;
  /**
   * Fase 2: si el cuerpo NO trae "product", la evaluación es persistente sobre el catálogo
   * (requiere clave admin). Con "product" se mantiene el comportamiento sin estado de la Fase 1.
   */
  catalogEvaluate?: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
}

export const productRoutes: FastifyPluginAsync<ProductRouteOptions> = (app, options) => {
  app.get('/products', async () => {
    const { source, products } = await options.listProducts.execute();
    return {
      data: products.map(toProductDto),
      meta: { count: products.length, source, currency: 'USD' },
    };
  });

  app.post('/products/evaluate', async (request, reply) => {
    if (request.body === undefined || request.body === null) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', 'Se requiere un cuerpo JSON con "product"'));
    }
    const isLegacy = typeof request.body === 'object' && 'product' in request.body;
    if (!isLegacy && options.catalogEvaluate) return options.catalogEvaluate(request, reply);
    const parsed = evaluateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', 'La solicitud no es válida', zodIssues(parsed.error)));
    }

    const product = fromProductDto(parsed.data.product);
    const overrides = toEvaluationOverrides(parsed.data.parameters);
    const evaluation = options.evaluateProduct.execute(product, overrides);
    return { data: toEvaluationDto(evaluation) };
  });

  return Promise.resolve();
};
