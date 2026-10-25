import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const states = ['RECEIVED', 'PAYMENT_PENDING', 'PAID', 'STOCK_VALIDATION', 'READY_FOR_FULFILLMENT', 'FULFILLMENT_REQUESTED', 'SUPPLIER_CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED', 'MANUAL_REVIEW'] as const;
export type OrderState = typeof states[number];
const transitions: Record<OrderState, readonly OrderState[]> = {
  RECEIVED: ['PAYMENT_PENDING', 'PAID', 'MANUAL_REVIEW', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED', 'MANUAL_REVIEW'],
  PAID: ['STOCK_VALIDATION', 'CANCELLED', 'MANUAL_REVIEW'],
  STOCK_VALIDATION: ['READY_FOR_FULFILLMENT', 'MANUAL_REVIEW', 'FAILED', 'CANCELLED'],
  READY_FOR_FULFILLMENT: ['FULFILLMENT_REQUESTED', 'STOCK_VALIDATION', 'CANCELLED', 'MANUAL_REVIEW'],
  FULFILLMENT_REQUESTED: ['SUPPLIER_CONFIRMED', 'FAILED', 'MANUAL_REVIEW'],
  SUPPLIER_CONFIRMED: ['SHIPPED', 'MANUAL_REVIEW'],
  SHIPPED: ['DELIVERED', 'MANUAL_REVIEW'],
  DELIVERED: [], CANCELLED: [], FAILED: ['MANUAL_REVIEW'],
  MANUAL_REVIEW: ['STOCK_VALIDATION', 'CANCELLED'],
};
export function assertTransition(from: OrderState, to: OrderState): void {
  if (!transitions[from].includes(to)) throw new Error(`Invalid transition: ${from} -> ${to}`);
}
const id = z.union([z.string().regex(/^\d+$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const money = z.string().regex(/^\d{1,9}\.\d{2}$/).transform(v => Number(v.replace('.', '')));
export const orderSchema = z.object({
  id, currency: z.literal('USD'), financial_status: z.string().max(40),
  cancelled_at: z.string().nullable().optional(),
  shipping_address: z.object({ first_name: z.string().min(1).max(100), last_name: z.string().max(100), address1: z.string().min(1).max(250), address2: z.string().max(250).nullable().optional(), city: z.string().min(1).max(100), province_code: z.string().min(1).max(10), zip: z.string().min(1).max(20), country_code: z.literal('US') }).nullable(),
  line_items: z.array(z.object({ id, product_id: id, variant_id: id, quantity: z.number().int().min(1).max(1000), price: money })).min(1).max(100),
});
export type IncomingOrder = z.infer<typeof orderSchema>;
export function validHmac(raw: Buffer, signature: string, secret: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}
export function encrypt(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt(value: string, key: Buffer): unknown {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')) as unknown;
}
