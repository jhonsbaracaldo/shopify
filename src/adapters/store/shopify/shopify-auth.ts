import { z } from 'zod';
import { ExternalServiceError } from '../../../application/errors.js';
import type { ResilientHttpClient } from '../../http/resilient-http-client.js';

export const SHOPIFY_SERVICE = 'shopify';

export interface ShopifyTokenProvider {
  readonly kind: 'static' | 'client_credentials';
  getToken(): Promise<string>;
  invalidate(): void;
}

/** Token de Admin API ya emitido (apps personalizadas "legacy" creadas antes de 2026 o tokens offline). */
export class StaticTokenProvider implements ShopifyTokenProvider {
  readonly kind = 'static' as const;
  constructor(private readonly token: string) {}
  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  invalidate(): void {}
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  expires_in: z.coerce.number().positive().optional(),
});

/**
 * Client credentials grant (apps del Dev Dashboard en la misma organización que la tienda):
 * POST https://{shop}.myshopify.com/admin/oauth/access_token con grant_type=client_credentials.
 * Los tokens duran 24 h: se guardan en memoria y se renuevan 60 s antes de expirar.
 * Ref: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */
export class ClientCredentialsTokenProvider implements ShopifyTokenProvider {
  readonly kind = 'client_credentials' as const;
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly options: {
      domain: string;
      clientId: string;
      clientSecret: string;
      http: ResilientHttpClient;
      timeoutMs: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > 60_000)
      return Promise.resolve(this.cached.token);
    this.pending ??= this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const response = await this.options.http.request({
      method: 'POST',
      url: `https://${this.options.domain}/admin/oauth/access_token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      timeoutMs: this.options.timeoutMs,
      idempotent: true,
      operation: 'oauth.client_credentials',
    });
    if (response.status !== 200) {
      // El cuerpo puede incluir detalles de la app; solo se expone el código de estado y un código conocido.
      const known = /shop_not_permitted|invalid_client|invalid_request/.exec(response.text)?.[0];
      throw new ExternalServiceError(
        SHOPIFY_SERVICE,
        'bad_gateway',
        'STORE_AUTH_FAILED',
        `no se pudo obtener el token (HTTP ${response.status}${known ? `, ${known}` : ''})`,
        false,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.text);
    } catch {
      raw = null;
    }
    const parsed = tokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ExternalServiceError(
        SHOPIFY_SERVICE,
        'bad_gateway',
        'STORE_AUTH_FAILED',
        'respuesta de token inválida',
        false,
      );
    }
    const ttlMs = (parsed.data.expires_in ?? 86_399) * 1000;
    this.cached = { token: parsed.data.access_token, expiresAt: this.now() + ttlMs };
    return parsed.data.access_token;
  }
}
