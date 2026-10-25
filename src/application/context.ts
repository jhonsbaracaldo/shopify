import type { AdapterLogger } from './ports/logger.js';
import type { EvaluationRules } from '../domain/rules.js';
import type { OverviewContext, Persistence } from './ports/persistence.js';
import type { StoreInfo, StorePort } from './ports/store-port.js';
import type { SupplierRegistry } from './supplier-registry.js';

/** Dependencias compartidas por los casos de uso de la Fase 2 (inyectadas en el composition root). */
export interface CatalogContext {
  persistence: Persistence;
  suppliers: SupplierRegistry;
  store: StorePort;
  rules: EvaluationRules;
  vendorName: string | null;
  clock: () => Date;
  logger: AdapterLogger;
}

/** Las publicaciones se registran por tienda concreta: una publicación simulada no bloquea la real. */
export function storeKeyOf(info: StoreInfo): string {
  return info.mode === 'live'
    ? `${info.id}:live:${info.domain ?? 'sin-dominio'}`
    : `${info.id}:${info.mode}`;
}

export function overviewContext(ctx: CatalogContext): OverviewContext {
  return { rulesHash: ctx.rules.hash, storeKey: storeKeyOf(ctx.store.info) };
}
