import { overviewContext, type CatalogContext } from '../context.js';
import { notFound } from '../errors.js';
import type { OverviewFilter, ProductOverview } from '../ports/persistence.js';
import type {
  ListSupplierProductsQuery,
  Page,
  SupplierInfo,
  SupplierProductSummary,
} from '../ports/supplier-port.js';

/** Consultas de solo lectura del catálogo y de los proveedores. */
export class CatalogQueries {
  constructor(private readonly ctx: CatalogContext) {}

  listSuppliers(): SupplierInfo[] {
    return this.ctx.suppliers.list();
  }

  listSupplierProducts(
    supplierId: string,
    query: ListSupplierProductsQuery,
  ): Promise<Page<SupplierProductSummary>> {
    return this.ctx.suppliers.require(supplierId).listProducts(query);
  }

  listCandidates(
    filter: OverviewFilter,
    page: { page: number; pageSize: number },
  ): Promise<Page<ProductOverview>> {
    return this.ctx.persistence.listOverviews(filter, page, overviewContext(this.ctx));
  }

  async getProduct(id: string): Promise<ProductOverview> {
    const overview = await this.ctx.persistence.getOverview(id, overviewContext(this.ctx));
    if (!overview) throw notFound('Producto', id);
    return overview;
  }
}
