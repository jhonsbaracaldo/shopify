import { ApplicationError, notFound } from './errors.js';
import type { SupplierInfo, SupplierPort } from './ports/supplier-port.js';

/** Registro de proveedores disponibles. Agregar un proveedor = registrar un adaptador nuevo. */
export class SupplierRegistry {
  private readonly suppliers: Map<string, SupplierPort>;

  constructor(suppliers: SupplierPort[]) {
    this.suppliers = new Map(suppliers.map((s) => [s.info.id, s]));
  }

  list(): SupplierInfo[] {
    return [...this.suppliers.values()].map((s) => ({ ...s.info }));
  }

  /** Devuelve un proveedor habilitado y configurado, o un error explícito (404/503). */
  require(id: string): SupplierPort {
    const supplier = this.suppliers.get(id);
    if (!supplier) throw notFound('Proveedor', id);
    if (!supplier.info.enabled) {
      throw new ApplicationError(
        'unavailable',
        'SUPPLIER_DISABLED',
        `El proveedor ${id} está deshabilitado`,
      );
    }
    if (!supplier.info.configured) {
      throw new ApplicationError(
        'unavailable',
        'SUPPLIER_NOT_CONFIGURED',
        `El proveedor ${id} no tiene credenciales configuradas (ver docs/credenciales.md)`,
      );
    }
    return supplier;
  }
}
