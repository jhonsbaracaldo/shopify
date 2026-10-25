import { ApplicationError, ExternalServiceError } from '../../../application/errors.js';
import type {
  PreparedStoreProduct,
  StoreDraft,
  StoreInfo,
  StorePort,
  StoreProductRef,
} from '../../../application/ports/store-port.js';
import { centsToUsd } from '../../../domain/money.js';
import { SHOPIFY_SERVICE } from './shopify-auth.js';
import type { ShopifyGraphqlClient } from './shopify-graphql-client.js';

/**
 * Adaptador de Shopify Admin GraphQL API (verificado con la versión 2026-10, 2026-10-18).
 * - productCreate solo crea la variante inicial → las demás se crean con
 *   productVariantsBulkCreate(strategy: REMOVE_STANDALONE_VARIANT).
 * - Permisos requeridos: write_products (crear/actualizar) y read_products (consultas).
 * - SOLO crea productos en estado DRAFT. No existe en este adaptador ninguna operación que active
 *   productos o los publique en canales de venta (publishablePublish no se usa).
 */

const PRODUCT_FIELDS = 'id handle title status variantsCount { count }';

const CREATE_PRODUCT = `mutation CreateDraftProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { ${PRODUCT_FIELDS} variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

const BULK_CREATE_VARIANTS = `mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const BULK_UPDATE_VARIANTS = `mutation UpdateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const UPDATE_PRODUCT = `mutation UpdateProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { ${PRODUCT_FIELDS} }
    userErrors { field message }
  }
}`;

const PRODUCT_BY_HANDLE = `query ProductByHandle($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) { ${PRODUCT_FIELDS} }
}`;

const PRODUCT_BY_ID = `query ProductById($id: ID!) {
  product(id: $id) { ${PRODUCT_FIELDS} variants(first: 1) { nodes { id } } }
}`;

const PRODUCT_DEFAULT_VARIANT = `query ProductDefaultVariant($id: ID!) {
  product(id: $id) { variants(first: 2) { nodes { id } } }
}`;

interface ShopifyProductNode {
  id: string;
  handle: string;
  title: string;
  status: string;
  variantsCount?: { count: number } | null;
  variants?: { nodes: { id: string }[] };
}

interface UserError {
  field?: string[] | null;
  message: string;
}

export interface ShopifyStoreOptions {
  domain: string;
  apiVersion: string;
  writeEnabled: boolean;
}

const money = (cents: number) => centsToUsd(cents).toFixed(2);

export class ShopifyStore implements StorePort {
  readonly info: StoreInfo;

  constructor(
    private readonly client: ShopifyGraphqlClient,
    private readonly options: ShopifyStoreOptions,
  ) {
    this.info = {
      id: 'shopify',
      mode: 'live',
      writeEnabled: options.writeEnabled,
      configured: true,
      apiVersion: options.apiVersion,
      domain: options.domain,
    };
  }

  private adminUrl(gid: string): string | null {
    const numericId = /\/(\d+)$/.exec(gid)?.[1];
    const shop = this.options.domain.replace(/\.myshopify\.com$/, '');
    return numericId ? `https://admin.shopify.com/store/${shop}/products/${numericId}` : null;
  }

  private toRef(node: ShopifyProductNode): StoreProductRef {
    return {
      id: node.id,
      handle: node.handle,
      title: node.title,
      status: node.status,
      variantsCount: node.variantsCount?.count ?? null,
      adminUrl: this.adminUrl(node.id),
    };
  }

  private assertWritable(operation: string): void {
    if (!this.options.writeEnabled) {
      throw new ApplicationError(
        'forbidden',
        'STORE_WRITE_DISABLED',
        `Escritura en Shopify deshabilitada (SHOPIFY_WRITE_ENABLED=false): ${operation} no se ejecutó`,
      );
    }
  }

  private throwUserErrors(operation: string, errors: UserError[] | undefined): void {
    if (errors && errors.length > 0) {
      throw new ExternalServiceError(
        SHOPIFY_SERVICE,
        'unprocessable',
        'STORE_USER_ERRORS',
        `${operation}: ${errors
          .map((e) => `${e.field?.join('.') ?? '-'}: ${e.message}`)
          .join('; ')
          .slice(0, 800)}`,
        false,
      );
    }
  }

  private productInput(draft: StoreDraft) {
    return {
      title: draft.title,
      descriptionHtml: draft.descriptionHtml,
      handle: draft.handle,
      ...(draft.vendor && { vendor: draft.vendor }),
      ...(draft.productType && { productType: draft.productType }),
      tags: draft.tags,
      // Valor fijo: el borrador nunca se crea activo, aunque el objeto de entrada dijera otra cosa.
      status: 'DRAFT',
      ...(draft.options.length > 0 && {
        productOptions: draft.options.map((o) => ({
          name: o.name,
          values: o.values.map((name) => ({ name })),
        })),
      }),
    };
  }

  private mediaInput(images: StoreDraft['images']) {
    return images.map((img) => ({
      originalSource: img.url,
      mediaContentType: 'IMAGE',
      alt: img.alt,
    }));
  }

  private variantsInput(draft: StoreDraft) {
    return draft.variants.map((v) => ({
      price: money(v.priceCents),
      ...(v.optionValues.length > 0 &&
        draft.options.length > 0 && { optionValues: v.optionValues }),
      inventoryPolicy: 'DENY',
      inventoryItem: {
        ...(v.sku && { sku: v.sku }),
        cost: money(v.costCents),
        // El inventario real vive en el proveedor; la sincronización de stock es una fase posterior.
        tracked: false,
        requiresShipping: true,
        ...(v.weightGrams !== null && {
          measurement: { weight: { value: v.weightGrams, unit: 'GRAMS' } },
        }),
      },
    }));
  }

  prepareProduct(draft: StoreDraft): PreparedStoreProduct {
    const operations: PreparedStoreProduct['operations'] = [
      {
        name: 'productCreate',
        variables: { product: this.productInput(draft), media: this.mediaInput(draft.images) },
      },
    ];
    operations.push(
      draft.options.length > 0
        ? {
            name: 'productVariantsBulkCreate',
            variables: {
              productId: '<id del producto creado>',
              variants: this.variantsInput(draft),
              strategy: 'REMOVE_STANDALONE_VARIANT',
            },
          }
        : {
            name: 'productVariantsBulkUpdate',
            variables: {
              productId: '<id del producto creado>',
              variants: this.variantsInput(draft).map((v) => ({
                id: '<id de la variante inicial>',
                ...v,
              })),
            },
          },
    );
    return { store: `shopify:${this.options.domain} (API ${this.options.apiVersion})`, operations };
  }

  async findProductByHandle(handle: string): Promise<StoreProductRef | null> {
    const data = await this.client.execute<{ productByIdentifier: ShopifyProductNode | null }>(
      'productByIdentifier',
      PRODUCT_BY_HANDLE,
      { identifier: { handle } },
      'query',
    );
    return data.productByIdentifier ? this.toRef(data.productByIdentifier) : null;
  }

  async getProduct(id: string): Promise<StoreProductRef | null> {
    const data = await this.client.execute<{ product: ShopifyProductNode | null }>(
      'product',
      PRODUCT_BY_ID,
      { id },
      'query',
    );
    return data.product ? this.toRef(data.product) : null;
  }

  async createDraftProduct(draft: StoreDraft): Promise<StoreProductRef> {
    this.assertWritable('productCreate');
    if (draft.status !== 'DRAFT') {
      throw new ApplicationError(
        'forbidden',
        'STORE_ONLY_DRAFTS',
        'Solo se permite crear productos en estado DRAFT',
      );
    }
    const data = await this.client.execute<{
      productCreate: { product: ShopifyProductNode | null; userErrors: UserError[] };
    }>(
      'productCreate',
      CREATE_PRODUCT,
      { product: this.productInput(draft), media: this.mediaInput(draft.images) },
      'mutation',
    );
    this.throwUserErrors('productCreate', data.productCreate.userErrors);
    const created = data.productCreate.product;
    if (!created) {
      throw new ExternalServiceError(
        SHOPIFY_SERVICE,
        'bad_gateway',
        'STORE_INVALID_RESPONSE',
        'productCreate sin producto',
        false,
      );
    }
    if (created.status !== 'DRAFT') {
      // Defensa adicional: nunca debería ocurrir porque el estado se envía fijo.
      throw new ApplicationError(
        'conflict',
        'STORE_UNEXPECTED_STATUS',
        `Shopify devolvió estado ${created.status} para ${created.id}`,
      );
    }
    return this.toRef(created);
  }

  async addVariants(product: StoreProductRef, draft: StoreDraft): Promise<{ created: number }> {
    this.assertWritable('addVariants');
    const variants = this.variantsInput(draft);
    if (draft.options.length > 0) {
      const data = await this.client.execute<{
        productVariantsBulkCreate: {
          productVariants: { id: string }[] | null;
          userErrors: UserError[];
        };
      }>(
        'productVariantsBulkCreate',
        BULK_CREATE_VARIANTS,
        { productId: product.id, variants },
        'mutation',
      );
      this.throwUserErrors('productVariantsBulkCreate', data.productVariantsBulkCreate.userErrors);
      return { created: data.productVariantsBulkCreate.productVariants?.length ?? 0 };
    }
    // Producto sin opciones: se completa la variante inicial creada por productCreate.
    const current = await this.client.execute<{
      product: { variants: { nodes: { id: string }[] } } | null;
    }>('product.defaultVariant', PRODUCT_DEFAULT_VARIANT, { id: product.id }, 'query');
    const nodes = current.product?.variants.nodes ?? [];
    if (nodes.length !== 1) {
      throw new ApplicationError(
        'conflict',
        'STORE_UNEXPECTED_VARIANTS',
        `Se esperaba 1 variante inicial en ${product.id} y hay ${nodes.length}`,
      );
    }
    const data = await this.client.execute<{
      productVariantsBulkUpdate: {
        productVariants: { id: string }[] | null;
        userErrors: UserError[];
      };
    }>(
      'productVariantsBulkUpdate',
      BULK_UPDATE_VARIANTS,
      { productId: product.id, variants: [{ id: nodes[0]!.id, ...variants[0] }] },
      'mutation',
    );
    this.throwUserErrors('productVariantsBulkUpdate', data.productVariantsBulkUpdate.userErrors);
    return { created: 0 };
  }

  async updateProduct(
    id: string,
    patch: { title?: string; descriptionHtml?: string; tags?: string[] },
  ): Promise<StoreProductRef> {
    this.assertWritable('productUpdate');
    // Nunca se envía `status`: actualizar información no puede activar el producto.
    const data = await this.client.execute<{
      productUpdate: { product: ShopifyProductNode | null; userErrors: UserError[] };
    }>('productUpdate', UPDATE_PRODUCT, { product: { id, ...patch } }, 'mutation');
    this.throwUserErrors('productUpdate', data.productUpdate.userErrors);
    return this.toRef(data.productUpdate.product!);
  }

  async attachImages(id: string, images: StoreDraft['images']): Promise<{ attached: number }> {
    this.assertWritable('productUpdate(media)');
    const data = await this.client.execute<{
      productUpdate: { product: ShopifyProductNode | null; userErrors: UserError[] };
    }>(
      'productUpdate.media',
      UPDATE_PRODUCT,
      { product: { id }, media: this.mediaInput(images) },
      'mutation',
    );
    this.throwUserErrors('productUpdate(media)', data.productUpdate.userErrors);
    return { attached: images.length };
  }
}
