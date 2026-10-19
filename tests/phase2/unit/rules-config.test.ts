import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRules, RulesConfigError } from '../../../src/config/rules.js';

const raw = () =>
  JSON.parse(readFileSync('config/evaluation-rules.json', 'utf8')) as Record<string, any>;

describe('reglas configurables (config/evaluation-rules.json)', () => {
  it('convierte USD y porcentajes a centavos y puntos básicos', () => {
    const rules = parseRules(raw());
    expect(rules.pricing).toMatchObject({
      targetMarginBp: 2000,
      minMarginBp: 1200,
      paymentFeeBp: 290,
      paymentFeeFixedCents: 30,
      returnsReserveBp: 300,
      acquisitionCostCents: 600,
      priceEndingCents: 99,
      maxRetailPriceCents: 7999,
    });
    expect(rules.shipping.allowedOriginCountries).toEqual(['US']);
    expect(rules.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambiar un valor cambia el hash (invalida evaluaciones previas)', () => {
    const changed = raw();
    changed.pricing.customerAcquisitionCostUsd = 7;
    expect(parseRules(changed).hash).not.toBe(parseRules(raw()).hash);
  });

  it('el comentario no afecta al hash', () => {
    const commented = raw();
    commented.$comment = 'otro comentario';
    expect(parseRules(commented).hash).toBe(parseRules(raw()).hash);
  });

  it('rechaza reglas inviables o incoherentes con mensajes claros', () => {
    const infeasible = raw();
    infeasible.pricing.targetMarginPercent = 94;
    infeasible.pricing.minMarginPercent = 10;
    expect(() => parseRules(infeasible)).toThrow(/inviables/);

    const minAboveTarget = raw();
    minAboveTarget.pricing.minMarginPercent = 30;
    expect(() => parseRules(minAboveTarget)).toThrow(RulesConfigError);

    const badDecimals = raw();
    badDecimals.pricing.paymentProcessing.fixedUsd = 0.301;
    expect(() => parseRules(badDecimals)).toThrow(/2 decimales/);
  });
});
