import { z } from 'zod';
import { hasAtMostDecimals } from '../domain/money.js';

const percentWithTwoDecimals = z.coerce
  .number()
  .min(0)
  .max(99.99)
  .refine((v) => hasAtMostDecimals(v, 2), { message: 'admite como máximo 2 decimales' });

/** Las variables vacías en .env (CLAVE=) se tratan como no definidas. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional(),
  );

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const secret = (minLength: number) =>
  optional(z.string().trim().min(minLength, `debe tener al menos ${minLength} caracteres`));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // --- Fase 1: evaluación sin estado (POST /api/v1/products/evaluate con { product }) ---
    DEFAULT_TARGET_MARGIN_PERCENT: percentWithTwoDecimals.default(30),
    DEFAULT_MAX_DELIVERY_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Vacío o "NONE" desactiva la regla de país de bodega. */
    DEFAULT_REQUIRED_ORIGIN_COUNTRY: z
      .string()
      .trim()
      .toUpperCase()
      .default('US')
      .transform((v) => (v === '' || v === 'NONE' ? null : v))
      .refine((v) => v === null || /^[A-Z]{2}$/.test(v), {
        message: 'debe ser un código ISO alfa-2 (p. ej. US), vacío o NONE',
      }),

    // --- Fase 2: seguridad ---
    /** Clave para automatizaciones (n8n): importar, evaluar, preparar/crear borradores. */
    ADMIN_API_KEY: secret(32),
    /** Clave EXCLUSIVA para decisiones humanas (aprobar/rechazar). Debe ser distinta de ADMIN_API_KEY. */
    APPROVER_API_KEY: secret(32),

    // --- Fase 2: persistencia y reglas ---
    /** Sin DATABASE_URL se usa persistencia en memoria (los datos se pierden al reiniciar). */
    DATABASE_URL: optional(z.string().regex(/^postgres(ql)?:\/\//, 'debe empezar por postgres://')),
    DB_AUTO_MIGRATE: bool(true),
    RULES_FILE: z.string().min(1).default('config/evaluation-rules.json'),

    // --- Fase 2: proveedores ---
    MOCK_SUPPLIER_ENABLED: bool(true),
    CJ_ENABLED: bool(false),
    CJ_API_KEY: secret(10),
    CJ_BASE_URL: z.url().default('https://developers.cjdropshipping.com/api2.0/v1'),
    CJ_MAX_REQUESTS_PER_SECOND: z.coerce.number().min(0.1).max(10).default(1),
    CJ_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    CJ_MAX_QUOTED_VARIANTS: z.coerce.number().int().min(0).max(50).default(5),

    // --- Fase 2: tienda ---
    /** disabled = sin tienda; mock = tienda simulada en memoria; live = Shopify real. */
    SHOPIFY_MODE: z.enum(['disabled', 'mock', 'live']).default('mock'),
    SHOPIFY_STORE_DOMAIN: optional(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'formato tienda.myshopify.com'),
    ),
    SHOPIFY_API_VERSION: z
      .string()
      .regex(/^\d{4}-(01|04|07|10)$/, 'formato AAAA-MM trimestral')
      .default('2026-10'),
    SHOPIFY_ADMIN_ACCESS_TOKEN: secret(20),
    SHOPIFY_CLIENT_ID: secret(10),
    SHOPIFY_CLIENT_SECRET: secret(10),
    /** Interruptor explícito para escrituras reales en Shopify. Por defecto, apagado. */
    SHOPIFY_WRITE_ENABLED: bool(false),
    SHOPIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    STORE_VENDOR_NAME: optional(z.string().trim().max(100)),
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_API_KEY && env.ADMIN_API_KEY === env.APPROVER_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['APPROVER_API_KEY'],
        message: 'debe ser distinta de ADMIN_API_KEY',
      });
    }
    if (env.CJ_ENABLED && !env.CJ_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CJ_API_KEY'],
        message: 'es obligatoria cuando CJ_ENABLED=true',
      });
    }
    if (env.SHOPIFY_MODE === 'live') {
      if (!env.SHOPIFY_STORE_DOMAIN) {
        ctx.addIssue({
          code: 'custom',
          path: ['SHOPIFY_STORE_DOMAIN'],
          message: 'es obligatorio con SHOPIFY_MODE=live',
        });
      }
      const hasToken = Boolean(env.SHOPIFY_ADMIN_ACCESS_TOKEN);
      const hasClient = Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
      if (!hasToken && !hasClient) {
        ctx.addIssue({
          code: 'custom',
          path: ['SHOPIFY_CLIENT_ID'],
          message:
            'con SHOPIFY_MODE=live defina SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET o SHOPIFY_ADMIN_ACCESS_TOKEN',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {}

/** Valida las variables de entorno y falla de inmediato con un mensaje claro si hay errores. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Solo se informan nombres de variables y motivos, nunca sus valores.
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Variables de entorno no válidas:\n${details}`);
  }
  return parsed.data;
}
