import { createHash } from 'node:crypto';

/** Quita acentos y diacríticos ("Café" → "Cafe"). */
export function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '');
}

/** Minúsculas, sin acentos, solo letras/números separados por un espacio. */
export function normalizeForMatching(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Slug apto para URLs/handles: "Licuadora USB-C 380ml" → "licuadora-usb-c-380ml". */
export function slugify(value: string, maxLength = 80): string {
  return normalizeForMatching(value).replace(/\s+/g, '-').slice(0, maxLength).replace(/-+$/g, '');
}

/** Serialización JSON determinista (claves ordenadas) para calcular hashes estables. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * Convierte HTML de proveedores (no confiable) a texto plano conservando saltos de párrafo.
 * Se descartan por completo scripts, estilos e iframes.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML seguro construido desde texto plano: un <p> por línea, todo escapado. */
export function plainTextToSafeHtml(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${escapeHtml(line.trim())}</p>`)
    .join('\n');
}
