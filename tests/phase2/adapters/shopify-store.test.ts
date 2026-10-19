import { describe, expect, it } from 'vitest';
import { ResilientHttpClient } from '../../../src/adapters/http/resilient-http-client.js';
import {
  ClientCredentialsTokenProvider,
  StaticTokenProvider,
} from '../../../src/adapters/store/shopify/shopify-auth.js';
import { ShopifyGraphqlClient } from '../../../src/adapters/store/shopify/shopify-graphql-client.js';
import { ShopifyStore } from '../../../src/adapters/store/shopify/shopify-store.js';
import type { StoreDraft } from '../../../src/domain/store-draft.js';
import { createFakeFetch, json, noSleep, type RecordedCall } from '../fake-fetch.js';

const DOMAIN = 'tienda-prueba.myshopify.com';

function draft(overrides: Partial<StoreDraft> = {}): StoreDraft {
  return {
    productId: 'p1',
    evaluationId: 'e1',
    handle: 'dsp-mock-us-mus-1001',
    title: 'Soporte',
    descriptionHtml: '<p>Hola</p>',
    productType: 'Office',
    vendor: null,
    tags: ['dropshipping'],
    status: 'DRAFT',
    options: [{ name: 'Color', values: ['Silver', 'Gray'] }],
    variants: [
      {
        variantId: 'v1',
        externalId: 'A',
        sku: 'SKU-A',
        priceCents: 2999,
        costCents: 980,
        barcode: null,
        weightGrams: 650,
        optionValues: [{ optionName: 'Color', name: 'Silver' }],
        imageUrl: null,
      },
      {
        variantId: 'v2',
        externalId: 'B',
        sku: 'SKU-B',
        priceCents: 2999,
        costCents: 980,
        barcode: null,
        weightGrams: null,
        optionValues: [{ optionName: 'Color', name: 'Gray' }],
        imageUrl: null,
      },
    ],
    images: [{ url: 'https://example.com/a.jpg', alt: 'Soporte' }],
    draftHash: 'h',
    ...overrides,
  };
}

const gql = (call: RecordedCall) =>
  JSON.parse(call.body!) as { query: string; variables: Record<string, any> };
const created = {
  productCreate: {
    product: {
      id: 'gid://shopify/Product/101',
      handle: 'dsp-mock-us-mus-1001',
      title: 'Soporte',
      status: 'DRAFT',
      variantsCount: { count: 1 },
      variants: { nodes: [{ id: 'gid://shopify/ProductVariant/9' }] },
    },
    userErrors: [],
  },
};

function setup(
  responders: ((call: RecordedCall) => Response)[],
  options: { writeEnabled?: boolean; tokens?: 'static' | 'client' } = {},
) {
  const fake = createFakeFetch({
    '/graphql.json': responders,
    '/admin/oauth/access_token': [
      () => json({ access_token: 'TOKEN-CC', scope: 'write_products', expires_in: 86399 }),
    ],
  });
  const http = new ResilientHttpClient({
    service: 'shopify',
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    fetch: fake.fetch,
    sleep: noSleep,
  });
  const tokens =
    options.tokens === 'client'
      ? new ClientCredentialsTokenProvider({
          domain: DOMAIN,
          clientId: 'client-id-x',
          clientSecret: 'client-secret-x',
          http,
          timeoutMs: 1000,
        })
      : new StaticTokenProvider('shpat_ficticio');
  const client = new ShopifyGraphqlClient({
    domain: DOMAIN,
    apiVersion: '2026-10',
    tokens,
    http,
    timeoutMs: 1000,
  });
  const store = new ShopifyStore(client, {
    domain: DOMAIN,
    apiVersion: '2026-10',
    writeEnabled: options.writeEnabled ?? true,
  });
  return { store, calls: fake.calls };
}

describe('ShopifyStore — borradores con Admin GraphQL 2026-10', () => {
  it('crea el producto SIEMPRE en estado DRAFT con opciones y media, en la versión configurada', async () => {
    const { store, calls } = setup([() => json({ data: created })]);
    const ref = await store.createDraftProduct(draft());
    expect(ref).toMatchObject({
      id: 'gid://shopify/Product/101',
      status: 'DRAFT',
      adminUrl: 'https://admin.shopify.com/store/tienda-prueba/products/101',
    });
    expect(calls[0]!.url).toBe(`https://${DOMAIN}/admin/api/2026-10/graphql.json`);
    expect(calls[0]!.headers['x-shopify-access-token']).toBe('shpat_ficticio');
    const { query, variables } = gql(calls[0]!);
    expect(query).toContain('productCreate(product: $product, media: $media)');
    expect(variables.product).toMatchObject({
      status: 'DRAFT',
      handle: 'dsp-mock-us-mus-1001',
      productOptions: [{ name: 'Color', values: [{ name: 'Silver' }, { name: 'Gray' }] }],
    });
    expect(variables.media).toEqual([
      { originalSource: 'https://example.com/a.jpg', mediaContentType: 'IMAGE', alt: 'Soporte' },
    ]);
    expect(query).not.toMatch(/publishablePublish|ACTIVE/);
  });

  it('no permite crear productos que no sean borradores', async () => {
    const { store, calls } = setup([() => json({ data: created })]);
    await expect(
      store.createDraftProduct({ ...draft(), status: 'ACTIVE' } as unknown as StoreDraft),
    ).rejects.toMatchObject({ code: 'STORE_ONLY_DRAFTS' });
    expect(calls).toHaveLength(0);
  });

  it('asocia variantes con productVariantsBulkCreate (REMOVE_STANDALONE_VARIANT), costo y peso', async () => {
    const { store, calls } = setup([
      () =>
        json({
          data: {
            productVariantsBulkCreate: {
              productVariants: [{ id: 'v1' }, { id: 'v2' }],
              userErrors: [],
            },
          },
        }),
    ]);
    const result = await store.addVariants(
      {
        id: 'gid://shopify/Product/101',
        handle: 'h',
        title: 't',
        status: 'DRAFT',
        variantsCount: 1,
        adminUrl: null,
      },
      draft(),
    );
    expect(result).toEqual({ created: 2 });
    const { query, variables } = gql(calls[0]!);
    expect(query).toContain('strategy: REMOVE_STANDALONE_VARIANT');
    expect(variables.variants[0]).toEqual({
      price: '29.99',
      optionValues: [{ optionName: 'Color', name: 'Silver' }],
      inventoryPolicy: 'DENY',
      inventoryItem: {
        sku: 'SKU-A',
        cost: '9.80',
        tracked: false,
        requiresShipping: true,
        measurement: { weight: { value: 650, unit: 'GRAMS' } },
      },
    });
    expect(variables.variants[1].inventoryItem.measurement).toBeUndefined();
  });

  it('producto sin opciones: completa la variante inicial con productVariantsBulkUpdate', async () => {
    const { store, calls } = setup([
      () =>
        json({
          data: { product: { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/9' }] } } },
        }),
      () =>
        json({
          data: {
            productVariantsBulkUpdate: {
              productVariants: [{ id: 'gid://shopify/ProductVariant/9' }],
              userErrors: [],
            },
          },
        }),
    ]);
    const single = draft({
      options: [],
      variants: [{ ...draft().variants[0]!, optionValues: [] }],
    });
    await store.addVariants(
      {
        id: 'gid://shopify/Product/101',
        handle: 'h',
        title: 't',
        status: 'DRAFT',
        variantsCount: 1,
        adminUrl: null,
      },
      single,
    );
    expect(gql(calls[1]!).variables.variants[0]).toMatchObject({
      id: 'gid://shopify/ProductVariant/9',
      price: '29.99',
    });
  });

  it('convierte userErrors en STORE_USER_ERRORS (422)', async () => {
    const { store } = setup([
      () =>
        json({
          data: {
            productCreate: {
              product: null,
              userErrors: [{ field: ['handle'], message: 'Handle has already been taken' }],
            },
          },
        }),
    ]);
    await expect(store.createDraftProduct(draft())).rejects.toMatchObject({
      code: 'STORE_USER_ERRORS',
      kind: 'unprocessable',
    });
  });

  it('reintenta THROTTLED (la mutación no se ejecutó) usando throttleStatus', async () => {
    const throttled = {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: {
        cost: {
          requestedQueryCost: 50,
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 10, restoreRate: 50 },
        },
      },
    };
    const { store, calls } = setup([() => json(throttled), () => json({ data: created })]);
    await store.createDraftProduct(draft());
    expect(calls).toHaveLength(2);
  });

  it('5xx en una mutación → STORE_OUTCOME_UNKNOWN sin reintentar (evita duplicados)', async () => {
    const { store, calls } = setup([() => json({}, 503)]);
    await expect(store.createDraftProduct(draft())).rejects.toMatchObject({
      code: 'STORE_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('con SHOPIFY_WRITE_ENABLED=false bloquea toda escritura sin llamar a Shopify', async () => {
    const { store, calls } = setup([() => json({ data: created })], { writeEnabled: false });
    await expect(store.createDraftProduct(draft())).rejects.toMatchObject({
      code: 'STORE_WRITE_DISABLED',
    });
    await expect(
      store.updateProduct('gid://shopify/Product/1', { title: 'x' }),
    ).rejects.toMatchObject({ code: 'STORE_WRITE_DISABLED' });
    expect(calls).toHaveLength(0);
  });

  it('busca por handle con productByIdentifier', async () => {
    const { store, calls } = setup([() => json({ data: { productByIdentifier: null } })]);
    expect(await store.findProductByHandle('dsp-x')).toBeNull();
    expect(gql(calls[0]!).variables).toEqual({ identifier: { handle: 'dsp-x' } });
  });

  it('client credentials: obtiene el token (form-urlencoded), lo reutiliza y lo renueva ante 401', async () => {
    const { store, calls } = setup(
      [
        () => json({ data: { productByIdentifier: null } }),
        () => json({ data: { productByIdentifier: null } }),
        () => json({ errors: 'unauthorized' }, 401),
        () => json({ data: { productByIdentifier: null } }),
      ],
      { tokens: 'client' },
    );
    await store.findProductByHandle('a');
    await store.findProductByHandle('b');
    await store.findProductByHandle('c');
    const tokenCalls = calls.filter((c) => c.url.includes('/admin/oauth/access_token'));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(tokenCalls[0]!.body).toBe(
      'grant_type=client_credentials&client_id=client-id-x&client_secret=client-secret-x',
    );
    expect(
      calls
        .filter((c) => c.url.includes('graphql'))
        .every((c) => c.headers['x-shopify-access-token'] === 'TOKEN-CC'),
    ).toBe(true);
  });

  it('prepareProduct devuelve exactamente las operaciones que se enviarían (para el dry-run)', () => {
    const { store } = setup([]);
    const prepared = store.prepareProduct(draft());
    expect(prepared.operations.map((o) => o.name)).toEqual([
      'productCreate',
      'productVariantsBulkCreate',
    ]);
    expect(prepared.store).toContain('2026-10');
  });
});
