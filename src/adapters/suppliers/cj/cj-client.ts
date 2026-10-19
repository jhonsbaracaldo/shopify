import { z } from 'zod';
import { ExternalServiceError } from '../../../application/errors.js';
import {
  type AdapterLogger,
  type ResilientHttpClient,
  silentLogger,
} from '../../http/resilient-http-client.js';

/**
 * Cliente de bajo nivel de CJdropshipping API 2.0
 * (https://developers.cjdropshipping.com/en/api/api2/). Verificado el 2026-10-18:
 * - Autenticación: POST /authentication/getAccessToken con { apiKey } → accessToken (header CJ-Access-Token),
 *   refreshToken (POST /authentication/refreshAccessToken).
 * - Sobre de respuesta: { code, result, message, data, requestId }; code 200 = éxito.
 * - Límite: 1 req/s para cuentas gratuitas (configurable), cuota diaria por puntos.
 * El token se guarda SOLO en memoria; nunca se registra en logs ni en la base de datos.
 */

export const CJ_SERVICE = 'cjdropshipping';

const envelopeSchema = z.object({
  code: z.coerce.number(),
  result: z.boolean().optional(),
  message: z.string().nullish(),
  data: z.unknown(),
  requestId: z.string().nullish(),
});

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiryDate: z.string().nullish(),
  refreshToken: z.string().nullish(),
  refreshTokenExpiryDate: z.string().nullish(),
});

/** Códigos documentados/observados: 1600200 = límite de frecuencia. */
const RATE_LIMIT_CODES = new Set([1600200]);
const AUTH_MESSAGE_RE = /(token|api ?key|unauthori[sz]ed|user not find|login)/i;

interface TokenState {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number;
}

export interface CjClientOptions {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  http: ResilientHttpClient;
  logger?: AdapterLogger;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;
/** La documentación limita la obtención de tokens; se evita pedir uno nuevo en menos de 5 minutos. */
const MIN_TOKEN_REQUEST_INTERVAL_MS = 5 * 60 * 1000;

export class CjClient {
  private token: TokenState | null = null;
  private lastTokenRequestAt = 0;
  private pendingToken: Promise<string> | null = null;
  private readonly logger: AdapterLogger;
  private readonly now: () => number;

  constructor(private readonly options: CjClientOptions) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.options.apiKey !== null && this.options.apiKey.length > 0;
  }

  private notConfigured(): ExternalServiceError {
    return new ExternalServiceError(
      CJ_SERVICE,
      'unavailable',
      'SUPPLIER_NOT_CONFIGURED',
      'CJ no está configurado: defina CJ_API_KEY (ver docs/credenciales.md)',
      false,
    );
  }

  private parseExpiry(value: string | null | undefined, fallbackMs: number): number {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? this.now() + fallbackMs : parsed;
  }

  private async callRaw(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    body: unknown,
    headers: Record<string, string>,
    idempotent: boolean,
  ): Promise<z.infer<typeof envelopeSchema>> {
    const response = await this.options.http.request({
      method,
      url: `${this.options.baseUrl}${path}`,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.options.timeoutMs,
      idempotent,
      operation,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        'SUPPLIER_AUTH_FAILED',
        `HTTP ${response.status} en ${operation}`,
        false,
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text);
    } catch {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        'SUPPLIER_INVALID_RESPONSE',
        `respuesta no JSON en ${operation} (HTTP ${response.status})`,
        response.status >= 500,
      );
    }
    const envelope = envelopeSchema.safeParse(parsedJson);
    if (!envelope.success) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        'SUPPLIER_INVALID_RESPONSE',
        `sobre de respuesta inesperado en ${operation}`,
        false,
      );
    }
    return envelope.data;
  }

  private async fetchToken(): Promise<string> {
    if (!this.configured) throw this.notConfigured();
    const now = this.now();
    if (this.token && this.token.accessExpiresAt - now > 60_000) return this.token.accessToken;

    if (this.token?.refreshToken && this.token.refreshExpiresAt - now > 60_000) {
      const refreshed = await this.callRaw(
        'POST',
        '/authentication/refreshAccessToken',
        'refreshAccessToken',
        { refreshToken: this.token.refreshToken },
        {},
        false,
      );
      if (refreshed.code === 200) return this.storeToken(refreshed.data, 'refresh');
      this.logger.warn(
        { service: CJ_SERVICE, code: refreshed.code, requestId: refreshed.requestId },
        'No se pudo renovar el token CJ',
      );
    }

    if (now - this.lastTokenRequestAt < MIN_TOKEN_REQUEST_INTERVAL_MS) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'rate_limited',
        'SUPPLIER_TOKEN_THROTTLED',
        'Se solicitó un token recientemente; espere antes de reintentar la autenticación',
        true,
        Math.ceil((MIN_TOKEN_REQUEST_INTERVAL_MS - (now - this.lastTokenRequestAt)) / 1000),
      );
    }
    this.lastTokenRequestAt = now;
    const result = await this.callRaw(
      'POST',
      '/authentication/getAccessToken',
      'getAccessToken',
      { apiKey: this.options.apiKey },
      {},
      false,
    );
    if (result.code !== 200) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        'SUPPLIER_AUTH_FAILED',
        `autenticación rechazada (code ${result.code}): ${result.message ?? 'sin mensaje'}`,
        false,
        undefined,
        result.requestId ?? undefined,
      );
    }
    return this.storeToken(result.data, 'login');
  }

  private storeToken(data: unknown, source: 'login' | 'refresh'): string {
    const parsed = tokenSchema.safeParse(data);
    if (!parsed.success) {
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        'SUPPLIER_INVALID_RESPONSE',
        'respuesta de token sin accessToken',
        false,
      );
    }
    this.token = {
      accessToken: parsed.data.accessToken,
      accessExpiresAt: this.parseExpiry(parsed.data.accessTokenExpiryDate, DAY),
      refreshToken: parsed.data.refreshToken ?? null,
      refreshExpiresAt: this.parseExpiry(parsed.data.refreshTokenExpiryDate, 30 * DAY),
    };
    this.logger.info(
      {
        service: CJ_SERVICE,
        source,
        expiresAt: new Date(this.token.accessExpiresAt).toISOString(),
      },
      'Token CJ obtenido',
    );
    return this.token.accessToken;
  }

  private getToken(): Promise<string> {
    // Peticiones concurrentes comparten una única solicitud de token.
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  /**
   * Llamada autenticada. Reintenta errores de límite de frecuencia notificados dentro del sobre
   * (code 1600200) y renueva el token una vez si CJ lo rechaza.
   */
  async call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      operation: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      maxRateLimitRetries?: number;
      /** Consultas por POST (p. ej. cotizar envío) que no modifican nada y pueden repetirse. */
      readOnly?: boolean;
    },
  ): Promise<{ data: T; requestId: string | null }> {
    if (!this.configured) throw this.notConfigured();
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query ?? {}))
      if (v !== undefined && v !== '') params.set(k, String(v));
    const fullPath = params.size > 0 ? `${path}?${params.toString()}` : path;
    const maxRateRetries = options.maxRateLimitRetries ?? 3;

    let authRetried = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.getToken();
      const envelope = await this.callRaw(
        method,
        fullPath,
        options.operation,
        options.body,
        { 'CJ-Access-Token': token },
        options.readOnly ?? method === 'GET',
      );
      if (envelope.code === 200 && envelope.result !== false) {
        return { data: envelope.data as T, requestId: envelope.requestId ?? null };
      }
      const meta = {
        service: CJ_SERVICE,
        operation: options.operation,
        code: envelope.code,
        requestId: envelope.requestId,
      };
      if (RATE_LIMIT_CODES.has(envelope.code)) {
        if (attempt <= maxRateRetries) {
          this.logger.warn(meta, 'Límite de frecuencia de CJ, se reintenta con backoff');
          await this.options.http.waitBeforeRetry(attempt, null);
          continue;
        }
        throw new ExternalServiceError(
          CJ_SERVICE,
          'rate_limited',
          'SUPPLIER_RATE_LIMITED',
          `límite de frecuencia en ${options.operation}`,
          true,
          2,
          envelope.requestId ?? undefined,
        );
      }
      if (!authRetried && AUTH_MESSAGE_RE.test(envelope.message ?? '')) {
        authRetried = true;
        // Se invalida solo el token de acceso: el refresh token permite renovarlo sin volver a
        // pedir uno nuevo con la API key (limitado a una solicitud cada 5 minutos).
        if (this.token) this.token = { ...this.token, accessExpiresAt: 0 };
        this.logger.warn(meta, 'CJ rechazó el token; se intenta renovar una vez');
        continue;
      }
      throw new ExternalServiceError(
        CJ_SERVICE,
        'bad_gateway',
        `SUPPLIER_ERROR_${envelope.code}`,
        `${options.operation} devolvió code ${envelope.code}: ${envelope.message ?? 'sin mensaje'}`,
        false,
        undefined,
        envelope.requestId ?? undefined,
      );
    }
  }
}
