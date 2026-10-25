import { ExternalServiceError } from '../../application/errors.js';
import { silentLogger, type AdapterLogger } from '../../application/ports/logger.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { silentLogger, type AdapterLogger } from '../../application/ports/logger.js';

/**
 * Limitador de tasa: espacia el INICIO de las peticiones a un máximo de N por segundo
 * (las serializa). Pensado para límites tipo "1 request/second" como el de CJ.
 */
export class RateLimiter {
  private nextSlot = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    if (!(maxPerSecond > 0)) throw new Error('maxPerSecond debe ser > 0');
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const interval = 1000 / this.maxPerSecond;
    const turn = this.chain.then(async () => {
      const wait = this.nextSlot - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = Math.max(this.now(), this.nextSlot) + interval;
    });
    this.chain = turn.catch(() => undefined);
    return turn.then(task);
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /**
   * true si repetir la petición es seguro ante errores de red/timeout/5xx (lecturas).
   * Las escrituras NO deben reintentarse a ciegas: el resultado podría ser desconocido.
   * Los 429 siempre se reintentan: el servidor confirma que no ejecutó la petición.
   */
  idempotent: boolean;
  /** Nombre lógico de la operación para logs (nunca se registran headers ni cuerpos). */
  operation: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface ResilientHttpOptions {
  service: string;
  retry: RetryPolicy;
  fetch?: FetchLike;
  sleep?: Sleep;
  random?: () => number;
  rateLimiter?: RateLimiter;
  logger?: AdapterLogger;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Ruta sin query string: evita filtrar parámetros a los logs. */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(url inválida)';
  }
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/**
 * Cliente HTTP con timeouts, reintentos con backoff exponencial y jitter completo,
 * respeto de `Retry-After` y limitación de tasa opcional.
 */
export class ResilientHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly logger: AdapterLogger;

  constructor(private readonly options: ResilientHttpOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? silentLogger;
  }

  backoffDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs } = this.options.retry;
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(this.random() * cap);
  }

  /** Espera antes de reintentar; también la usan los adaptadores para errores de su protocolo. */
  async waitBeforeRetry(attempt: number, retryAfterMs: number | null): Promise<void> {
    const delay = retryAfterMs ?? this.backoffDelay(attempt);
    await this.sleep(Math.min(delay, this.options.retry.maxDelayMs * 4));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const { service, retry } = this.options;
    const path = safePath(req.url);
    let lastError: ExternalServiceError | null = null;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const send = () =>
          this.fetchImpl(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: AbortSignal.timeout(req.timeoutMs),
          });
        const response = await (this.options.rateLimiter
          ? this.options.rateLimiter.schedule(send)
          : send());
        const text = await response.text();
        const meta = {
          service,
          operation: req.operation,
          path,
          status: response.status,
          attempt,
          ms: Date.now() - started,
        };

        if (response.status === 429 || (RETRYABLE_STATUS.has(response.status) && req.idempotent)) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          lastError = new ExternalServiceError(
            service,
            response.status === 429 ? 'rate_limited' : 'unavailable',
            response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
            `HTTP ${response.status} en ${req.operation}`,
            true,
            retryAfterMs === null ? undefined : Math.ceil(retryAfterMs / 1000),
          );
          if (attempt < retry.maxAttempts) {
            this.logger.warn(meta, 'Respuesta reintentable de servicio externo');
            await this.waitBeforeRetry(attempt, retryAfterMs);
            continue;
          }
          this.logger.warn(meta, 'Reintentos agotados');
          throw lastError;
        }

        this.logger.debug(meta, 'Llamada a servicio externo');
        return { status: response.status, headers: response.headers, text };
      } catch (error) {
        if (error instanceof ExternalServiceError) throw error;
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastError = new ExternalServiceError(
          service,
          timedOut ? 'timeout' : 'unavailable',
          timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR',
          timedOut
            ? `Timeout de ${req.timeoutMs} ms en ${req.operation}`
            : `Error de red en ${req.operation}: ${(error as Error).message}`,
          req.idempotent,
        );
        const meta = { service, operation: req.operation, path, attempt, error: lastError.code };
        if (req.idempotent && attempt < retry.maxAttempts) {
          this.logger.warn(meta, 'Error de red/timeout, se reintenta');
          await this.waitBeforeRetry(attempt, null);
          continue;
        }
        this.logger.warn(meta, 'Error de red/timeout sin reintento');
        throw lastError;
      }
    }
    throw (
      lastError ??
      new ExternalServiceError(
        service,
        'unavailable',
        'UPSTREAM_UNAVAILABLE',
        'sin respuesta',
        true,
      )
    );
  }
}
