import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  normalizeSupplierProduct,
  stockInCountries,
} from '../../../src/domain/catalog.js';
import { makeSupplierProduct, makeVariant } from '../helpers.js';

describe('normalizeSupplierProduct', () => {
  it('produce VALID con datos completos y un hash de contenido estable', () => {
    const a = normalizeSupplierProduct(makeSupplierProduct());
    const b = normalizeSupplierProduct(makeSupplierProduct());
    expect(a.validation).toEqual({ status: 'VALID', issues: [] });
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('cambia el hash cuando cambia un dato relevante (costo de una variante)', () => {
    const a = normalizeSupplierProduct(makeSupplierProduct());
    const b = normalizeSupplierProduct(
      makeSupplierProduct({ variants: [makeVariant({ costCents: 990 })] }),
    );
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('recorta textos, normaliza países y descarta imágenes no https o repetidas', () => {
    const result = normalizeSupplierProduct(
      makeSupplierProduct({
        name: '  Soporte  ',
        images: ['https://x.com/1.jpg', 'http://x.com/2.jpg', 'https://x.com/1.jpg', 'no-url'],
        variants: [
          makeVariant({
            inventory: [
              { warehouseId: ' w1 ', warehouseName: null, countryCode: 'us', quantity: 5 },
            ],
          }),
        ],
      }),
    );
    expect(result.name).toBe('Soporte');
    expect(result.images).toEqual(['https://x.com/1.jpg']);
    expect(result.variants[0]!.inventory).toEqual([
      { warehouseId: 'w1', warehouseName: null, countryCode: 'US', quantity: 5 },
    ]);
    expect(result.validation.status).toBe('INCOMPLETE');
    expect(result.validation.issues.map((i) => i.path)).toContain('images');
  });

  it('elimina variantes duplicadas (mismo id externo) conservando la primera', () => {
    const result = normalizeSupplierProduct(
      makeSupplierProduct({
        variants: [makeVariant({ costCents: 100 }), makeVariant({ costCents: 999 })],
      }),
    );
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]!.costCents).toBe(100);
    expect(result.validation.issues.some((i) => i.message.includes('repetida'))).toBe(true);
  });

  it('marca INCOMPLETE si faltan costo, peso, descripción o inventario (respuesta incompleta)', () => {
    const result = normalizeSupplierProduct(
      makeSupplierProduct({
        description: null,
        category: null,
        variants: [
          makeVariant({
            costCents: null,
            weightGrams: null,
            inventory: null,
            shippingQuotes: null,
          }),
        ],
      }),
    );
    expect(result.validation.status).toBe('INCOMPLETE');
    const paths = result.validation.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'description',
        'category',
        'variants[0].costCents',
        'variants[0].weightGrams',
        'variants[0].inventory',
      ]),
    );
    expect(result.variants[0]!.inventory).toBeNull();
  });

  it('marca INVALID sin variantes, sin nombre o con moneda distinta de USD', () => {
    expect(normalizeSupplierProduct(makeSupplierProduct({ variants: [] })).validation.status).toBe(
      'INVALID',
    );
    expect(normalizeSupplierProduct(makeSupplierProduct({ name: '   ' })).validation.status).toBe(
      'INVALID',
    );
    const cop = normalizeSupplierProduct(makeSupplierProduct({ currency: 'COP' }));
    expect(cop.validation.status).toBe('INVALID');
    expect(cop.validation.issues[0]!.message).toContain('COP');
  });

  it('rechaza costos negativos o no enteros tratándolos como desconocidos', () => {
    const result = normalizeSupplierProduct(
      makeSupplierProduct({ variants: [makeVariant({ costCents: -5 })] }),
    );
    expect(result.variants[0]!.costCents).toBeNull();
  });

  it('descarta cotizaciones de envío con costo inválido', () => {
    const result = normalizeSupplierProduct(
      makeSupplierProduct({
        variants: [
          makeVariant({
            shippingQuotes: [
              {
                method: 'ok',
                originCountry: 'US',
                destinationCountry: 'US',
                costCents: 400,
                minDays: 2,
                maxDays: 3,
              },
              {
                method: 'malo',
                originCountry: 'US',
                destinationCountry: 'US',
                costCents: Number.NaN,
                minDays: 2,
                maxDays: 3,
              },
            ],
          }),
        ],
      }),
    );
    expect(result.variants[0]!.shippingQuotes!.map((q) => q.method)).toEqual(['ok']);
  });
});

describe('variantes y origen de despacho', () => {
  it('cuenta existencias solo en bodegas de los países indicados (no el país del proveedor)', () => {
    const variant = makeVariant({
      inventory: [
        { warehouseId: 'us', warehouseName: null, countryCode: 'US', quantity: 30 },
        { warehouseId: 'us2', warehouseName: null, countryCode: 'US', quantity: 20 },
        { warehouseId: 'cn', warehouseName: null, countryCode: 'CN', quantity: 900 },
      ],
    });
    expect(stockInCountries(variant, ['US'])).toBe(50);
    expect(stockInCountries(variant, ['CN'])).toBe(900);
    expect(stockInCountries(variant, ['GB'])).toBe(0);
  });

  it('devuelve null si el inventario o las cantidades son desconocidos', () => {
    expect(stockInCountries(makeVariant({ inventory: null }), ['US'])).toBeNull();
    expect(
      stockInCountries(
        makeVariant({
          inventory: [
            { warehouseId: 'us', warehouseName: null, countryCode: 'US', quantity: null },
          ],
        }),
        ['US'],
      ),
    ).toBeNull();
  });
});

describe('buildDedupeKey', () => {
  it('ignora orden de palabras, mayúsculas, acentos, signos y palabras vacías', () => {
    expect(buildDedupeKey('Botella térmica de acero inoxidable 1 L')).toBe(
      buildDedupeKey('BOTELLA TERMICA 1 l, acero inoxidable'),
    );
    expect(buildDedupeKey('Soporte para laptop')).not.toBe(buildDedupeKey('Soporte para tablet'));
  });
});
