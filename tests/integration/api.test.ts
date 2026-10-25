import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSupplierCatalog } from '../../src/adapters/suppliers/mock-supplier-catalog.js';
import type { SupplierCatalog } from '../../src/application/ports/supplier-catalog.js';
import { buildApp } from '../../src/http/app.js';
import { makeProductDto, testConfig } from '../fixtures.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: testConfig, catalog: new MockSupplierCatalog() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const evaluate = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/products/evaluate', payload: payload as object });

describe('GET /health', () => {
  it('responde 200 con el estado del servicio', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', catalogSource: 'mock' });
  });
});

describe('GET /api/v1/products', () => {
  it('devuelve los cinco productos simulados en USD', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/products' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown>[]; meta: Record<string, unknown> }>();
    expect(body.meta).toEqual({ count: 5, source: 'mock', currency: 'USD' });
    expect(body.data[0]).toMatchObject({
      sku: 'DEMO-AUTO-001',
      productCost: 4.2,
      shippingCost: 3.95,
      suggestedPrice: 19.99,
      currency: 'USD',
      estimatedDeliveryDays: { min: 3, max: 5 },
    });
  });

  it('los productos devueltos se pueden reenviar tal cual a /evaluate (flujo de n8n)', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/products' });
    const products = list.json<{ data: unknown[] }>().data;
    const results = await Promise.all(products.map((product) => evaluate({ product })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const eligible = results
      .map((r) => r.json<{ data: { sku: string; eligible: boolean } }>().data)
      .filter((d) => d.eligible)
      .map((d) => d.sku);
    expect(eligible).toEqual(['DEMO-AUTO-001', 'DEMO-HLTH-002']);
  });

  it('responde 500 con formato consistente si el proveedor falla', async () => {
    const failing: SupplierCatalog = {
      source: 'failing',
      listProducts: () => Promise.reject(new Error('timeout del proveedor')),
    };
    const failingApp = await buildApp({ config: testConfig, catalog: failing });
    const res = await failingApp.inject({ method: 'GET', url: '/api/v1/products' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
    });
    await failingApp.close();
  });
});

describe('POST /api/v1/products/evaluate', () => {
  it('evalúa un producto rentable con parámetros por defecto', async () => {
    const res = await evaluate({ product: makeProductDto() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: {
        sku: 'TEST-001',
        currency: 'USD',
        pricing: { salePrice: 30, totalCost: 15, priceSource: 'suggested' },
        gross: { profit: 15, marginPercent: 50 },
        net: null,
        targetMarginPercent: 30,
        minimumRecommendedPrice: 21.43,
        eligible: true,
      },
    });
  });

  it('aplica parámetros personalizados y costos adicionales', async () => {
    const res = await evaluate({
      product: makeProductDto(),
      parameters: {
        targetMarginPercent: 60,
        salePrice: 29.99,
        additionalCosts: [
          { name: 'Comisión de pago', type: 'percent_of_price', percent: 2.9 },
          { name: 'Publicidad', type: 'fixed', amount: 8 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: Record<string, unknown> }>();
    expect(data).toMatchObject({
      pricing: { salePrice: 29.99, priceSource: 'override' },
      gross: { profit: 14.99, marginPercent: 49.98 },
      net: { additionalCosts: 8.87, profit: 6.12, marginPercent: 20.41 },
      minimumRecommendedPrice: 37.5,
      eligible: false,
    });
  });

  it('400 si falta el cuerpo', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/products/evaluate' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('400 con JSON mal formado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/evaluate',
      headers: { 'content-type': 'application/json' },
      payload: '{"product": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('415 si el Content-Type no es JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/evaluate',
      headers: { 'content-type': 'text/plain' },
      payload: 'hola',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('400 con detalle por campo ante valores negativos y faltantes', async () => {
    const product = makeProductDto({ productCost: -5, shippingCost: 1.234 });
    delete (product as Record<string, unknown>).name;
    const res = await evaluate({ product });
    expect(res.statusCode).toBe(400);
    const { error } = res.json<{ error: { details: { path: string }[] } }>();
    expect(error.details.map((d) => d.path)).toEqual(
      expect.arrayContaining(['product.productCost', 'product.shippingCost', 'product.name']),
    );
  });

  it('400 si el precio sugerido es cero (evita división por cero)', async () => {
    const res = await evaluate({ product: makeProductDto({ suggestedPrice: 0 }) });
    expect(res.statusCode).toBe(400);
  });

  it('400 si el margen objetivo es 100 %', async () => {
    const res = await evaluate({
      product: makeProductDto(),
      parameters: { targetMarginPercent: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { details: { path: string }[] } }>().error.details[0]?.path).toBe(
      'parameters.targetMarginPercent',
    );
  });

  it('400 ante parámetros desconocidos, moneda distinta o rango de entrega invertido', async () => {
    const responses = await Promise.all([
      evaluate({ product: makeProductDto(), parameters: { margen: 30 } }),
      evaluate({ product: makeProductDto({ currency: 'COP' }) }),
      evaluate({ product: makeProductDto({ estimatedDeliveryDays: { min: 9, max: 3 } }) }),
    ]);
    responses.forEach((r) => expect(r.statusCode).toBe(400));
  });

  it('404 con formato consistente para rutas inexistentes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nada' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
