import type {
  ShippingQuote,
  SupplierProduct,
  SupplierVariant,
  WarehouseStock,
} from '../../domain/catalog.js';
import type { Cents } from '../../domain/money.js';

/**
 * Contrato común para proveedores de dropshipping. Cada adaptador traduce la API del proveedor
 * a este modelo. No todos los proveedores soportan todas las operaciones: `capabilities` lo declara.
 */
export interface SupplierInfo {
  id: string;
  name: string;
  /** `api` = integración real (requiere credenciales); `mock` = datos ficticios de desarrollo. */
  kind: 'api' | 'mock';
  enabled: boolean;
  configured: boolean;
  capabilities: {
    inventoryByWarehouse: boolean;
    shippingQuotes: boolean;
    filterByShipFromCountry: boolean;
  };
  docsUrl: string | null;
  notes: string[];
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  /** `null` si el proveedor no informa el total. */
  total: number | null;
  hasMore: boolean;
}

export interface SupplierProductSummary {
  externalId: string;
  sku: string | null;
  name: string;
  imageUrl: string | null;
  /** Costo de lista (el menor si el proveedor informa un rango); `null` si no lo informa. */
  listCostCents: Cents | null;
  category: string | null;
  /** Países de bodega conocidos desde el listado; `null` si el listado no lo informa. */
  warehouseCountries: string[] | null;
}

export interface ListSupplierProductsQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  /** Filtra productos con inventario en ese país (si el proveedor lo soporta). */
  shipsFromCountry?: string;
  categoryId?: string;
}

export interface ShippingQuoteRequest {
  variantExternalId: string;
  originCountry: string;
  destinationCountry: string;
  quantity: number;
}

export interface SupplierPort {
  readonly info: SupplierInfo;
  listProducts(query: ListSupplierProductsQuery): Promise<Page<SupplierProductSummary>>;
  /** Detalle completo: variantes, inventario por bodega y cotizaciones de envío cuando sea posible. */
  getProduct(externalId: string): Promise<SupplierProduct | null>;
  getVariants(externalId: string): Promise<SupplierVariant[]>;
  getInventory(variantExternalId: string): Promise<WarehouseStock[]>;
  getShippingQuotes(request: ShippingQuoteRequest): Promise<ShippingQuote[]>;
}
