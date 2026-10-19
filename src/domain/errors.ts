export interface ValidationIssue {
  path: string;
  message: string;
}

/** Error base del dominio: representa una violación de reglas de negocio. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'DOMAIN_ERROR',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Datos que no cumplen las invariantes del dominio (negativos, faltantes, fuera de rango...). */
export class DomainValidationError extends DomainError {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
  ) {
    super(message, 'DOMAIN_VALIDATION_ERROR');
  }
}
