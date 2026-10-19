import type { StoreDraft, StoreDraftVariant } from '../../domain/store-draft.js';

export type StoreMode = 'disabled' | 'mock' | 'live';

export interface StoreInfo {
  id: string;
  mode: StoreMode;
  /** Escrituras habilitadas explícitamente por configuración (SHOPIFY_WRITE_ENABLED). */
  writeEnabled: boolean;
  configured: boolean;
  apiVersion: string | null;
  domain: string | null;
}

export interface StoreProductRef {
  id: string;
  handle: string;
  title: string;
  status: string;
  variantsCount: number | null;
  adminUrl: string | null;
}

/** Carga útil exacta que se enviaría a la tienda (para revisión en modo dry-run). */
export interface PreparedStoreProduct {
  store: string;
  operations: { name: string; variables: unknown }[];
}

/**
 * Contrato de tienda. Los adaptadores SOLO crean productos en estado borrador: no existe ninguna
 * operación para activar o publicar productos en canales de venta.
 */
export interface StorePort {
  readonly info: StoreInfo;
  prepareProduct(draft: StoreDraft): PreparedStoreProduct;
  findProductByHandle(handle: string): Promise<StoreProductRef | null>;
  getProduct(id: string): Promise<StoreProductRef | null>;
  createDraftProduct(draft: StoreDraft): Promise<StoreProductRef>;
  /** Asocia las variantes del borrador al producto ya creado. */
  addVariants(product: StoreProductRef, draft: StoreDraft): Promise<{ created: number }>;
  updateProduct(
    id: string,
    patch: { title?: string; descriptionHtml?: string; tags?: string[] },
  ): Promise<StoreProductRef>;
  attachImages(id: string, images: StoreDraft['images']): Promise<{ attached: number }>;
}

export type { StoreDraft, StoreDraftVariant };
