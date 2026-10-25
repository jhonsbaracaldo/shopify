import { ExternalServiceError } from '../../../application/errors.js';
import {
  type AdapterLogger,
  type ResilientHttpClient,
  silentLogger,
} from '../../http/resilient-http-client.js';
import { SHOPIFY_SERVICE, type ShopifyTokenProvider } from './shopify-auth.js';

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: {
        maximumAvailable?: number;
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
}

export interface ShopifyGraphqlOptions {
  domain: string;
  apiVersion: string;
  tokens: ShopifyTokenProvider;
  http: ResilientHttpClient;
  timeoutMs: number;
  maxThrottleRetries?: number;
  logger?: AdapterLogger;
}

/**
 * Cliente GraphQL Admin API. Reglas de reintento:
 * - THROTTLED (límite por costo de consulta): la petición NO se ejecutó → se espera y se reintenta,
 *   también para mutaciones. La espera se calcula con throttleStatus (puntos faltantes / restoreRate).
 * - 401: el token pudo expirar → se renueva y se reintenta una vez.
 * - Timeouts/5xx en mutaciones: resultado desconocido → NO se reintenta (el flujo de borradores
 *   vuelve a comprobar por handle antes de crear nada).
 */
export class ShopifyGraphqlClient {
  private readonly logger: AdapterLogger;

  constructor(private readonly options: ShopifyGraphqlOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get endpoint(): string {
    return `https://${this.options.domain}/admin/api/${this.options.apiVersion}/graphql.json`;
  }

  async execute<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    kind: 'query' | 'mutation',
  ): Promise<T> {
    const maxThrottle = this.options.maxThrottleRetries ?? 4;
    let tokenRetried = false;

    for (let attempt = 1; ; attempt += 1) {
      const token = await this.options.tokens.getToken();
      const response = await this.options.http.request({
        method: 'POST',
        url: this.endpoint,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        timeoutMs: this.options.timeoutMs,
        idempotent: kind === 'query',
        operation: `shopify.${operation}`,
      });

      if (response.status === 401 && !tokenRetried) {
        tokenRetried = true;
        this.options.tokens.invalidate();
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'bad_gateway',
          'STORE_AUTH_FAILED',
          `HTTP ${response.status} en ${operation}: revise token y permisos (write_products/read_products)`,
          false,
        );
      }
      if (response.status >= 500) {
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'bad_gateway',
          kind === 'mutation' ? 'STORE_OUTCOME_UNKNOWN' : 'STORE_UNAVAILABLE',
          `HTTP ${response.status} en ${operation}`,
          kind === 'query',
        );
      }

      let body: GraphqlResponse<T>;
      try {
        body = JSON.parse(response.text) as GraphqlResponse<T>;
      } catch {
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'bad_gateway',
          'STORE_INVALID_RESPONSE',
          `respuesta no JSON en ${operation} (HTTP ${response.status})`,
          false,
        );
      }

      const throttled = body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled) {
        const status = body.extensions?.cost?.throttleStatus;
        const needed =
          (body.extensions?.cost?.requestedQueryCost ?? 0) - (status?.currentlyAvailable ?? 0);
        const waitMs = status?.restoreRate
          ? Math.max(1000, Math.ceil((needed / status.restoreRate) * 1000))
          : null;
        if (attempt <= maxThrottle) {
          this.logger.warn(
            { service: SHOPIFY_SERVICE, operation, attempt, waitMs },
            'Shopify THROTTLED: se espera y se reintenta',
          );
          await this.options.http.waitBeforeRetry(attempt, waitMs);
          continue;
        }
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'rate_limited',
          'STORE_RATE_LIMITED',
          `THROTTLED en ${operation}`,
          true,
          Math.ceil((waitMs ?? 2000) / 1000),
        );
      }
      if (body.errors && body.errors.length > 0) {
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'bad_gateway',
          'STORE_GRAPHQL_ERROR',
          `${operation}: ${body.errors
            .map((e) => e.message)
            .join('; ')
            .slice(0, 500)}`,
          false,
        );
      }
      if (response.status !== 200 || body.data === undefined) {
        throw new ExternalServiceError(
          SHOPIFY_SERVICE,
          'bad_gateway',
          'STORE_INVALID_RESPONSE',
          `HTTP ${response.status} sin datos en ${operation}`,
          false,
        );
      }
      return body.data;
    }
  }
}
