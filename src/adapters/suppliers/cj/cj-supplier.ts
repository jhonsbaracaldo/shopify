import { z } from 'zod';
import { ExternalServiceError } from '../../../application/errors.js';
import type {
  ListSupplierProductsQuery,
  Page,
  ShippingQuoteRequest,
  SupplierInfo,
  SupplierPort,
  SupplierProductSummary,
} from '../../../application/ports/supplier-port.js';
import type {
  ShippingQuote,
  SupplierProduct,
  SupplierVariant,
  WarehouseStock,
} from '../../../domain/catalog.js';
import { type AdapterLogger, silentLogger } from '../../http/resilient-http-client.js';
import { CJ_SERVICE, type CjClient } from './cj-client.js';
import {
  cjFreightSchema,
  cjListProductSchema,
  cjProductSchema,
  cjStockSchema,
  cjVariantSchema,
  mapCjFreight,
  mapCjListProduct,
  mapCjProduct,
  mapCjStock,
  mapCjVariant,
} from './cj-mappers.js';

export interface CjSupplierOptions {
  enabled: boolean;
  /** País de destino de los clientes. */
  destinationCountry: string;
  /** Países de bodega que se cotizan (normalmente ["US"]). */
  quoteOriginCountries: string[];
  /** Límite de variantes cotizadas por producto (cada cotización es una llamada con límite de tasa). */
  maxQuotedVariants: number;
  logger?: AdapterLogger;
}

function invalid(operation: string, detail: string): ExternalServiceError {
  return new ExternalServiceError(
    CJ_SERVICE,
    'bad_gateway',
    'SUPPLIER_INVALID_RESPONSE',
    `${operation}: ${detail}`,
    false,
  );
}

/** Adaptador real de CJdropshipping. Requiere CJ_API_KEY; sin ella todas las operaciones fallan con 503. */
export class CjSupplier implements SupplierPort {
  readonly info: SupplierInfo;
  private readonly logger: AdapterLogger;

  constructor(
    private readonly client: CjClient,
    private readonly options: CjSupplierOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
    this.info = {
      id: 'cj',
      name: 'CJdropshipping',
      kind: 'api',
      enabled: options.enabled,
      configured: client.configured,
      capabilities: {
        inventoryByWarehouse: true,
        shippingQuotes: true,
        filterByShipFromCountry: true,
      },
      docsUrl: 'https://developers.cjdropshipping.com/en/api/api2/',
      notes: [
        'Requiere cuenta CJ y API key (CJ_API_KEY). Límite de 1 req/s para cuentas gratuitas y cuota diaria por puntos.',
        'El origen de despacho se obtiene del inventario por país de bodega de cada variante, no del país del proveedor.',
      ],
    };
  }

  private ensureEnabled() {
    if (!this.options.enabled) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'unavailable',
        'SUPPLIER_DISABLED',
        'CJ está deshabilitado (CJ_ENABLED=false)',
        false,
      );
    }
  }

  async listProducts(query: ListSupplierProductsQuery): Promise<Page<SupplierProductSummary>> {
    this.ensureEnabled();
    const { data } = await this.client.call<unknown>('GET', '/product/listV2', {
      operation: 'product.listV2',
      query: {
        page: query.page,
        size: query.pageSize,
        keyWord: query.keyword,
        countryCode: query.shipsFromCountry,
        categoryId: query.categoryId,
      },
    });
    const parsed = z
      .object({
        totalRecords: z.coerce.number().nullish(),
        total: z.coerce.number().nullish(),
        content: z
          .array(z.object({ productList: z.array(z.unknown()).nullish() }).loose())
          .nullish(),
        list: z.array(z.unknown()).nullish(),
      })
      .loose()
      .safeParse(data ?? {});
    if (!parsed.success) throw invalid('product.listV2', 'estructura de listado inesperada');

    const rawItems =
      parsed.data.content?.flatMap((c) => c.productList ?? []) ?? parsed.data.list ?? [];
    const items: SupplierProductSummary[] = [];
    for (const raw of rawItems) {
      const item = cjListProductSchema.safeParse(raw);
      if (item.success) items.push(mapCjListProduct(item.data, query.shipsFromCountry));
      else
        this.logger.warn(
          { service: CJ_SERVICE },
          'Producto de listado con formato inesperado: omitido',
        );
    }
    const total = parsed.data.totalRecords ?? parsed.data.total ?? null;
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore:
        total === null ? items.length === query.pageSize : query.page * query.pageSize < total,
    };
  }

  async getProduct(externalId: string): Promise<SupplierProduct | null> {
    this.ensureEnabled();
    const { data } = await this.client.call<unknown>('GET', '/product/query', {
      operation: 'product.query',
      query: { pid: externalId },
    });
    if (data === null || data === undefined) return null;
    const parsed = cjProductSchema.safeParse(data);
    if (!parsed.success)
      throw invalid('product.query', `producto ${externalId} con formato inesperado`);
    const product = mapCjProduct(parsed.data, this.info.id);

    // Variantes sin inventario en el detalle: se consulta el endpoint de stock por variante.
    for (const variant of product.variants) {
      if (variant.inventory !== null) continue;
      variant.inventory = await this.getInventory(variant.externalId).catch((error: unknown) => {
        this.logger.warn(
          { service: CJ_SERVICE, vid: variant.externalId, error: (error as Error).message },
          'Inventario no disponible',
        );
        return null;
      });
    }
    await this.attachShippingQuotes(product.variants);
    return product;
  }

  /** Cotiza envío para las variantes con existencias en los países de origen permitidos. */
  private async attachShippingQuotes(variants: SupplierVariant[]) {
    let quoted = 0;
    for (const variant of variants) {
      const origin = this.options.quoteOriginCountries.find((country) =>
        variant.inventory?.some((s) => s.countryCode === country && (s.quantity ?? 0) > 0),
      );
      if (!origin) continue;
      if (quoted >= this.options.maxQuotedVariants) {
        this.logger.info(
          { service: CJ_SERVICE, vid: variant.externalId },
          'Variante sin cotizar: límite de cotizaciones por producto',
        );
        continue;
      }
      quoted += 1;
      variant.shippingQuotes = await this.getShippingQuotes({
        variantExternalId: variant.externalId,
        originCountry: origin,
        destinationCountry: this.options.destinationCountry,
        quantity: 1,
      }).catch((error: unknown) => {
        this.logger.warn(
          { service: CJ_SERVICE, vid: variant.externalId, error: (error as Error).message },
          'Cotización de envío no disponible',
        );
        return null;
      });
    }
  }

  async getVariants(externalId: string): Promise<SupplierVariant[]> {
    this.ensureEnabled();
    const { data } = await this.client.call<unknown>('GET', '/product/variant/query', {
      operation: 'product.variant.query',
      query: { pid: externalId },
    });
    const parsed = z.array(cjVariantSchema).safeParse(data ?? []);
    if (!parsed.success) throw invalid('product.variant.query', 'variantes con formato inesperado');
    return parsed.data.map((v) => mapCjVariant(v, null));
  }

  async getInventory(variantExternalId: string): Promise<WarehouseStock[]> {
    this.ensureEnabled();
    const { data } = await this.client.call<unknown>('GET', '/product/stock/queryByVid', {
      operation: 'product.stock.queryByVid',
      query: { vid: variantExternalId },
    });
    const parsed = z.array(cjStockSchema).safeParse(data ?? []);
    if (!parsed.success)
      throw invalid('product.stock.queryByVid', 'inventario con formato inesperado');
    return mapCjStock(parsed.data);
  }

  async getShippingQuotes(request: ShippingQuoteRequest): Promise<ShippingQuote[]> {
    this.ensureEnabled();
    const { data } = await this.client.call<unknown>('POST', '/logistic/freightCalculate', {
      operation: 'logistic.freightCalculate',
      readOnly: true,
      body: {
        startCountryCode: request.originCountry,
        endCountryCode: request.destinationCountry,
        products: [{ quantity: request.quantity, vid: request.variantExternalId }],
      },
    });
    const parsed = z.array(cjFreightSchema).safeParse(data ?? []);
    if (!parsed.success)
      throw invalid('logistic.freightCalculate', 'cotización con formato inesperado');
    return mapCjFreight(parsed.data, request.originCountry, request.destinationCountry);
  }
}
