import { DomainValidationError, type ValidationIssue } from './errors.js';
import { CURRENCY, MAX_AMOUNT_CENTS, type Cents, type Currency } from './money.js';

export const AVAILABILITY_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export interface Supplier {
  id: string;
  name: string;
  /** Código ISO 3166-1 alfa-2 del país de la bodega desde la que despacha (p. ej. "US"). */
  warehouseCountry: string;
}

export interface DeliveryWindow {
  /** Días hábiles mínimos estimados hasta la entrega al cliente final. */
  minDays: number;
  /** Días hábiles máximos estimados hasta la entrega al cliente final. */
  maxDays: number;
}

export interface Availability {
  status: AvailabilityStatus;
  quantity: number;
}

/** Producto del catálogo de un proveedor. Todos los importes en centavos de USD. */
export interface Product {
  sku: string;
  name: string;
  description: string;
  category: string;
  supplier: Supplier;
  productCostCents: Cents;
  shippingCostCents: Cents;
  suggestedPriceCents: Cents;
  currency: Currency;
  estimatedDelivery: DeliveryWindow;
  availability: Availability;
}

export const MAX_DELIVERY_DAYS_LIMIT = 90;

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkCents(issues: ValidationIssue[], path: string, value: unknown, allowZero: boolean) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.push({ path, message: 'debe ser un número entero de centavos' });
  } else if (value < 0) {
    issues.push({ path, message: 'no puede ser negativo' });
  } else if (!allowZero && value === 0) {
    issues.push({ path, message: 'debe ser mayor que cero' });
  } else if (value > MAX_AMOUNT_CENTS) {
    issues.push({ path, message: 'supera el importe máximo permitido' });
  }
}

function checkDays(issues: ValidationIssue[], path: string, value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    issues.push({ path, message: 'debe ser un número entero de días ≥ 0' });
  } else if (value > MAX_DELIVERY_DAYS_LIMIT) {
    issues.push({ path, message: `no puede superar ${MAX_DELIVERY_DAYS_LIMIT} días` });
  }
}

/**
 * Verifica las invariantes de un producto. Se usa como última línea de defensa del dominio,
 * independientemente de la validación que haga la capa HTTP.
 */
export function assertValidProduct(product: Product): void {
  const issues: ValidationIssue[] = [];

  for (const field of ['sku', 'name', 'description', 'category'] as const) {
    if (!isNonEmpty(product[field])) issues.push({ path: field, message: 'es obligatorio' });
  }

  if (!product.supplier) {
    issues.push({ path: 'supplier', message: 'es obligatorio' });
  } else {
    if (!isNonEmpty(product.supplier.id))
      issues.push({ path: 'supplier.id', message: 'es obligatorio' });
    if (!isNonEmpty(product.supplier.name)) {
      issues.push({ path: 'supplier.name', message: 'es obligatorio' });
    }
    if (!/^[A-Z]{2}$/.test(product.supplier.warehouseCountry ?? '')) {
      issues.push({ path: 'supplier.warehouseCountry', message: 'debe ser un código ISO alfa-2' });
    }
  }

  checkCents(issues, 'productCost', product.productCostCents, true);
  checkCents(issues, 'shippingCost', product.shippingCostCents, true);
  checkCents(issues, 'suggestedPrice', product.suggestedPriceCents, false);

  if (product.currency !== CURRENCY) {
    issues.push({ path: 'currency', message: 'solo se admite USD' });
  }

  if (!product.estimatedDelivery) {
    issues.push({ path: 'estimatedDelivery', message: 'es obligatorio' });
  } else {
    const { minDays, maxDays } = product.estimatedDelivery;
    checkDays(issues, 'estimatedDelivery.minDays', minDays);
    checkDays(issues, 'estimatedDelivery.maxDays', maxDays);
    if (Number.isInteger(minDays) && Number.isInteger(maxDays) && minDays > maxDays) {
      issues.push({ path: 'estimatedDelivery', message: 'minDays no puede ser mayor que maxDays' });
    }
  }

  if (!product.availability) {
    issues.push({ path: 'availability', message: 'es obligatorio' });
  } else {
    const { status, quantity } = product.availability;
    if (!AVAILABILITY_STATUSES.includes(status)) {
      issues.push({ path: 'availability.status', message: 'estado de disponibilidad no válido' });
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      issues.push({ path: 'availability.quantity', message: 'debe ser un entero ≥ 0' });
    }
  }

  if (issues.length > 0) {
    throw new DomainValidationError('El producto no es válido', issues);
  }
}

export function isAvailable(availability: Availability): boolean {
  return availability.status !== 'out_of_stock' && availability.quantity > 0;
}
