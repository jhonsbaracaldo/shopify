import { ApplicationError } from '../../application/errors.js';
import type {
  PreparedStoreProduct,
  StoreDraft,
  StoreInfo,
  StorePort,
  StoreProductRef,
} from '../../application/ports/store-port.js';

const disabled = () =>
  Promise.reject(
    new ApplicationError(
      'unavailable',
      'STORE_DISABLED',
      'La integración con la tienda está deshabilitada (SHOPIFY_MODE=disabled)',
    ),
  );

/** SHOPIFY_MODE=disabled: permite preparar contenido (dry-run) pero ninguna llamada a la tienda. */
export class DisabledStore implements StorePort {
  readonly info: StoreInfo = {
    id: 'shopify',
    mode: 'disabled',
    writeEnabled: false,
    configured: false,
    apiVersion: null,
    domain: null,
  };

  prepareProduct(draft: StoreDraft): PreparedStoreProduct {
    return {
      store: 'disabled',
      operations: [{ name: 'none', variables: { handle: draft.handle, status: draft.status } }],
    };
  }
  findProductByHandle(): Promise<StoreProductRef | null> {
    return disabled();
  }
  getProduct(): Promise<StoreProductRef | null> {
    return disabled();
  }
  createDraftProduct(): Promise<StoreProductRef> {
    return disabled();
  }
  addVariants(): Promise<{ created: number }> {
    return disabled();
  }
  updateProduct(): Promise<StoreProductRef> {
    return disabled();
  }
  attachImages(): Promise<{ attached: number }> {
    return disabled();
  }
}
