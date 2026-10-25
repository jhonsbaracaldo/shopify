import { describe, expect, it } from 'vitest';
import { ResilientHttpClient } from '../../../src/adapters/http/resilient-http-client.js';
import { CjClient } from '../../../src/adapters/suppliers/cj/cj-client.js';
import {
  mapVariantOptions,
  parseAging,
  parseUsdCents,
} from '../../../src/adapters/suppliers/cj/cj-mappers.js';
import { CjSupplier } from '../../../src/adapters/suppliers/cj/cj-supplier.js';
import { ExternalServiceError } from '../../../src/application/errors.js';
import { normalizeSupplierProduct } from '../../../src/domain/catalog.js';
import { createFakeFetch, json, noSleep } from '../fake-fetch.js';
import {
  CJ_FREIGHT_RESPONSE,
  CJ_GENERIC_ERROR_RESPONSE,
  CJ_INVALID_TOKEN_RESPONSE,
  CJ_LIST_V2_RESPONSE,
  CJ_PRODUCT_QUERY_RESPONSE,
  CJ_RATE_LIMIT_RESPONSE,
  CJ_STOCK_BY_VID_RESPONSE,
  CJ_TOKEN_RESPONSE,
} from './cj-contract-fixtures.js';

const BASE = 'https://cj.test/api2.0/v1';

function setup(
  routes: Parameters<typeof createFakeFetch>[0],
  apiKey: string | null = 'CJ-KEY-FICTICIA',
  now = () => Date.parse('2026-10-18T12:00:00Z'),
) {
  const fake = createFakeFetch({
    '/authentication/getAccessToken': [() => json(CJ_TOKEN_RESPONSE)],
    ...routes,
  });
  const http = new ResilientHttpClient({
    service: 'cj',
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    fetch: fake.fetch,
    sleep: noSleep,
  });
  const client = new CjClient({ baseUrl: BASE, apiKey, timeoutMs: 1000, http, now });
  const supplier = new CjSupplier(client, {
    enabled: true,
    destinationCountry: 'US',
    quoteOriginCountries: ['US'],
    maxQuotedVariants: 5,
  });
  return { supplier, calls: fake.calls };
}

describe('CjSupplier — contrato de la API 2.0 (fixtures)', () => {
  it('obtiene un token una sola vez y lo envía en CJ-Access-Token', async () => {
    const { supplier, calls } = setup({ '/product/listV2': [() => json(CJ_LIST_V2_RESPONSE)] });
    await supplier.listProducts({ page: 1, pageSize: 2, shipsFromCountry: 'US' });
    await supplier.listProducts({ page: 2, pageSize: 2, shipsFromCountry: 'US' });
    const tokenCalls = calls.filter((c) => c.url.includes('getAccessToken'));
    expect(tokenCalls).toHaveLength(1);
    expect(JSON.parse(tokenCalls[0]!.body!)).toEqual({ apiKey: 'CJ-KEY-FICTICIA' });
    const listCall = calls.find((c) => c.url.includes('listV2'))!;
    expect(listCall.headers['cj-access-token']).toBe('TOKEN-FICTICIO-DE-PRUEBA');
    expect(listCall.url).toContain('countryCode=US');
    expect(listCall.url).toContain('size=2');
  });

  it('traduce el listado (precio como string o rango) y omite elementos inválidos', async () => {
    const { supplier } = setup({ '/product/listV2': [() => json(CJ_LIST_V2_RESPONSE)] });
    const page = await supplier.listProducts({ page: 1, pageSize: 2, shipsFromCountry: 'US' });
    expect(page.items).toEqual([
      {
        externalId: 'PID-FICT-1',
        sku: 'CJFICT001',
        name: 'Fictional Laptop Stand',
        imageUrl: 'https://example.com/cj/1.jpg',
        listCostCents: 980,
        category: 'Laptop Stands',
        warehouseCountries: ['US'],
      },
      {
        externalId: 'PID-FICT-2',
        sku: 'CJFICT002',
        name: 'Fictional Bottle',
        imageUrl: 'https://example.com/cj/2.jpg',
        listCostCents: 329,
        category: 'Drinkware',
        warehouseCountries: ['US'],
      },
    ]);
    expect(page).toMatchObject({ total: 3, hasMore: true });
  });

  it('obtiene el detalle con variantes, opciones, inventario por bodega y cotizaciones desde EE. UU.', async () => {
    const { supplier, calls } = setup({
      '/product/query': [() => json(CJ_PRODUCT_QUERY_RESPONSE)],
      '/product/stock/queryByVid': [() => json(CJ_STOCK_BY_VID_RESPONSE)],
      '/logistic/freightCalculate': [() => json(CJ_FREIGHT_RESPONSE)],
    });
    const product = await supplier.getProduct('PID-FICT-1');
    expect(product).not.toBeNull();
    expect(product!.images).toEqual([
      'https://example.com/cj/1.jpg',
      'https://example.com/cj/1b.jpg',
    ]);
    const [a, b] = product!.variants;
    expect(a).toMatchObject({
      externalId: 'VID-FICT-1A',
      options: { Color: 'Silver', Size: 'L' },
      costCents: 980,
      suggestedRetailCents: 3499,
      weightGrams: 650,
      inventory: [
        { warehouseId: 'cj-US', countryCode: 'US', quantity: 340 },
        { warehouseId: 'cj-CN', countryCode: 'CN', quantity: 5000 },
      ],
    });
    expect(a!.shippingQuotes).toEqual([
      {
        method: 'Fictional US Ground',
        originCountry: 'US',
        destinationCountry: 'US',
        costCents: 495,
        minDays: 2,
        maxDays: 5,
      },
      {
        method: 'Fictional US Express',
        originCountry: 'US',
        destinationCountry: 'US',
        costCents: 1240,
        minDays: 1,
        maxDays: 2,
      },
    ]);
    // Inventario obtenido del endpoint de stock porque el detalle no lo traía.
    expect(b).toMatchObject({
      costCents: 1010,
      weightGrams: 660,
      inventory: [
        {
          warehouseId: 'cj-area-2',
          warehouseName: 'US Warehouse',
          countryCode: 'US',
          quantity: 75,
        },
      ],
    });

    const freight = calls.filter((c) => c.url.includes('freightCalculate'));
    expect(freight).toHaveLength(2);
    expect(JSON.parse(freight[0]!.body!)).toEqual({
      startCountryCode: 'US',
      endCountryCode: 'US',
      products: [{ quantity: 1, vid: 'VID-FICT-1A' }],
    });

    // El resultado es normalizable al modelo común sin errores.
    expect(normalizeSupplierProduct(product!).validation.status).toBe('VALID');
  });

  it('tolera respuestas incompletas: lo que falta queda como desconocido (null), no se inventa', async () => {
    const incomplete = {
      code: 200,
      result: true,
      data: { pid: 'PID-X', variants: [{ vid: 'VID-X' }] },
    };
    const { supplier } = setup({
      '/product/query': [() => json(incomplete)],
      '/product/stock/queryByVid': [() => json(CJ_GENERIC_ERROR_RESPONSE)],
    });
    const product = await supplier.getProduct('PID-X');
    expect(product!.name).toBe('');
    expect(product!.variants[0]).toMatchObject({
      costCents: null,
      weightGrams: null,
      inventory: null,
      shippingQuotes: null,
      options: {},
    });
    expect(normalizeSupplierProduct(product!).validation.status).toBe('INVALID');
  });

  it('una cotización fallida deja el envío como desconocido sin romper el producto', async () => {
    const { supplier } = setup({
      '/product/query': [
        () =>
          json({
            ...CJ_PRODUCT_QUERY_RESPONSE,
            data: {
              ...CJ_PRODUCT_QUERY_RESPONSE.data,
              variants: [CJ_PRODUCT_QUERY_RESPONSE.data.variants[0]],
            },
          }),
      ],
      '/logistic/freightCalculate': [() => json(CJ_GENERIC_ERROR_RESPONSE)],
    });
    const product = await supplier.getProduct('PID-FICT-1');
    expect(product!.variants[0]!.shippingQuotes).toBeNull();
  });

  it('reintenta el código de límite de frecuencia 1600200 y luego continúa', async () => {
    const { supplier, calls } = setup({
      '/product/listV2': [() => json(CJ_RATE_LIMIT_RESPONSE), () => json(CJ_LIST_V2_RESPONSE)],
    });
    const page = await supplier.listProducts({ page: 1, pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('listV2'))).toHaveLength(2);
  });

  it('renueva el token una vez si CJ lo rechaza', async () => {
    const { supplier, calls } = setup({
      '/product/listV2': [() => json(CJ_INVALID_TOKEN_RESPONSE), () => json(CJ_LIST_V2_RESPONSE)],
      '/authentication/refreshAccessToken': [() => json(CJ_TOKEN_RESPONSE)],
    });
    await supplier.listProducts({ page: 1, pageSize: 2 });
    expect(calls.filter((c) => c.url.includes('/authentication/'))).toHaveLength(2);
  });

  it('convierte errores de negocio en ExternalServiceError con requestId y sin el token', async () => {
    const { supplier } = setup({ '/product/query': [() => json(CJ_GENERIC_ERROR_RESPONSE)] });
    const error = (await supplier
      .getProduct('NOPE')
      .catch((e: unknown) => e)) as ExternalServiceError;
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({
      code: 'SUPPLIER_ERROR_1603000',
      kind: 'bad_gateway',
      externalRequestId: 'req-err',
    });
    expect(error.message).not.toContain('TOKEN-FICTICIO');
  });

  it('falla con SUPPLIER_NOT_CONFIGURED sin API key, sin llamar a la red', async () => {
    const { supplier, calls } = setup({}, null);
    expect(supplier.info.configured).toBe(false);
    await expect(supplier.listProducts({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      code: 'SUPPLIER_NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  it('respuesta no JSON → SUPPLIER_INVALID_RESPONSE', async () => {
    const { supplier } = setup({
      '/product/listV2': [() => new Response('<html>502</html>', { status: 200 })],
    });
    await expect(supplier.listProducts({ page: 1, pageSize: 2 })).rejects.toMatchObject({
      code: 'SUPPLIER_INVALID_RESPONSE',
    });
  });
});

describe('mapeadores CJ', () => {
  it('interpreta precios, plazos y opciones', () => {
    expect(parseUsdCents('11.85')).toBe(1185);
    expect(parseUsdCents('3.29 -- 5.12')).toBe(329);
    expect(parseUsdCents(-1)).toBeNull();
    expect(parseUsdCents('abc')).toBeNull();
    expect(parseAging('2-5')).toEqual({ minDays: 2, maxDays: 5 });
    expect(parseAging('7')).toEqual({ minDays: 7, maxDays: 7 });
    expect(parseAging('n/a')).toEqual({ minDays: null, maxDays: null });
    expect(mapVariantOptions('Color-Size', 'Black-XXL')).toEqual({ Color: 'Black', Size: 'XXL' });
    // Si la cantidad de nombres y valores no coincide, no se adivina: una sola opción con el valor completo.
    expect(mapVariantOptions('Color', 'T-Shirt-Black')).toEqual({ Variante: 'T-Shirt-Black' });
  });
});
