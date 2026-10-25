import { ApplicationError, ExternalServiceError } from '../../application/errors.js';
import type {
  PreparedStoreProduct,
  StoreDraft,
  StoreInfo,
  StorePort,
  StoreProductRef,
} from '../../application/ports/store-port.js';

interface MockProduct extends StoreProductRef {
  variants: number;
  images: number;
}

/**
 * Tienda SIMULADA en memoria (SHOPIFY_MODE=mock). No contacta a Shopify. Los IDs usan el prefijo
 * `gid://mock-shopify/` para que nunca se confundan con productos reales. Permite inyectar fallos
 * para probar errores parciales.
 */
export class MockStore implements StorePort {
  readonly info: StoreInfo = {
    id: 'shopify',
    mode: 'mock',
    writeEnabled: true,
    configured: true,
    apiVersion: null,
    domain: null,
  };
  private products = new Map<string, MockProduct>();
  private sequence = 0;
  /** Fallos programados por operación (se consumen en orden). */
  readonly failures: Partial<
    Record<'createDraftProduct' | 'addVariants' | 'findProductByHandle', Error[]>
  > = {};
  readonly calls: string[] = [];

  private maybeFail(operation: keyof MockStore['failures']) {
    const error = this.failures[operation]?.shift();
    if (error) throw error;
  }

  static transientError(message = 'timeout simulado'): ExternalServiceError {
    return new ExternalServiceError(
      'shopify-mock',
      'timeout',
      'STORE_OUTCOME_UNKNOWN',
      message,
      false,
    );
  }

  prepareProduct(draft: StoreDraft): PreparedStoreProduct {
    return {
      store: 'shopify-mock',
      operations: [
        {
          name: 'mock.createDraft',
          variables: {
            handle: draft.handle,
            title: draft.title,
            status: 'DRAFT',
            variants: draft.variants.length,
          },
        },
      ],
    };
  }

  /** Simula un producto creado manualmente en la tienda (para probar conflictos de handle). */
  seedExisting(handle: string, status = 'ACTIVE', title = 'Producto existente'): StoreProductRef {
    return this.store({ handle, title, status, variants: 1, images: 0 });
  }

  private store(input: {
    handle: string;
    title: string;
    status: string;
    variants: number;
    images: number;
  }): StoreProductRef {
    this.sequence += 1;
    const product: MockProduct = {
      id: `gid://mock-shopify/Product/${this.sequence}`,
      handle: input.handle,
      title: input.title,
      status: input.status,
      variantsCount: input.variants,
      adminUrl: null,
      variants: input.variants,
      images: input.images,
    };
    this.products.set(product.id, product);
    return this.ref(product);
  }

  private ref(p: MockProduct): StoreProductRef {
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      status: p.status,
      variantsCount: p.variants,
      adminUrl: p.adminUrl,
    };
  }

  findProductByHandle(handle: string): Promise<StoreProductRef | null> {
    this.calls.push(`findProductByHandle:${handle}`);
    this.maybeFail('findProductByHandle');
    const found = [...this.products.values()].find((p) => p.handle === handle);
    return Promise.resolve(found ? this.ref(found) : null);
  }

  getProduct(id: string): Promise<StoreProductRef | null> {
    const found = this.products.get(id);
    return Promise.resolve(found ? this.ref(found) : null);
  }

  createDraftProduct(draft: StoreDraft): Promise<StoreProductRef> {
    this.calls.push(`createDraftProduct:${draft.handle}`);
    this.maybeFail('createDraftProduct');
    if (draft.status !== 'DRAFT') {
      return Promise.reject(
        new ApplicationError('forbidden', 'STORE_ONLY_DRAFTS', 'Solo se permiten borradores'),
      );
    }
    if ([...this.products.values()].some((p) => p.handle === draft.handle)) {
      return Promise.reject(
        new ExternalServiceError(
          'shopify-mock',
          'unprocessable',
          'STORE_USER_ERRORS',
          `handle ${draft.handle} en uso`,
          false,
        ),
      );
    }
    return Promise.resolve(
      this.store({
        handle: draft.handle,
        title: draft.title,
        status: 'DRAFT',
        variants: 1,
        images: draft.images.length,
      }),
    );
  }

  addVariants(product: StoreProductRef, draft: StoreDraft): Promise<{ created: number }> {
    this.calls.push(`addVariants:${product.id}`);
    this.maybeFail('addVariants');
    const stored = this.products.get(product.id);
    if (!stored) return Promise.reject(new ApplicationError('not_found', 'NOT_FOUND', product.id));
    stored.variants = draft.variants.length;
    stored.variantsCount = draft.variants.length;
    return Promise.resolve({ created: draft.options.length > 0 ? draft.variants.length : 0 });
  }

  updateProduct(
    id: string,
    patch: { title?: string; descriptionHtml?: string; tags?: string[] },
  ): Promise<StoreProductRef> {
    const stored = this.products.get(id);
    if (!stored) return Promise.reject(new ApplicationError('not_found', 'NOT_FOUND', id));
    if (patch.title) stored.title = patch.title;
    return Promise.resolve(this.ref(stored));
  }

  attachImages(id: string, images: StoreDraft['images']): Promise<{ attached: number }> {
    const stored = this.products.get(id);
    if (!stored) return Promise.reject(new ApplicationError('not_found', 'NOT_FOUND', id));
    stored.images += images.length;
    return Promise.resolve({ attached: images.length });
  }

  /** Solo para pruebas: inspección del estado simulado. */
  snapshot(): MockProduct[] {
    return [...this.products.values()].map((p) => ({ ...p }));
  }
}
