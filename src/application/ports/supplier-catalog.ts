import type { Product } from '../../domain/product.js';

/**
 * Puerto (interfaz) de un proveedor de catálogo. El mock actual y los futuros proveedores
 * reales (APIs de dropshipping con bodegas en EE. UU.) deben implementar este contrato.
 */
export interface SupplierCatalog {
  /** Identificador de la fuente de datos, p. ej. "mock". */
  readonly source: string;
  listProducts(): Promise<Product[]>;
}
