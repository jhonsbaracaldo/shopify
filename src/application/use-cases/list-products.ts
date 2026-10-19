import type { Product } from '../../domain/product.js';
import type { SupplierCatalog } from '../ports/supplier-catalog.js';

export class ListProductsUseCase {
  constructor(private readonly catalog: SupplierCatalog) {}

  async execute(): Promise<{ source: string; products: Product[] }> {
    const products = await this.catalog.listProducts();
    return { source: this.catalog.source, products };
  }
}
