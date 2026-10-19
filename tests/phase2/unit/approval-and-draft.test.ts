import { describe, expect, it } from 'vitest';
import {
  checkDecision,
  checkPublicationAuthorization,
  type Approval,
  type StoredEvaluation,
} from '../../../src/domain/approval.js';
import { classifyProduct } from '../../../src/domain/classification.js';
import { buildStoreDraft, buildStoreHandle } from '../../../src/domain/store-draft.js';
import { defaultRules, makeCatalogProduct, makeVariant } from '../helpers.js';

function evaluate(product = makeCatalogProduct()): StoredEvaluation {
  return {
    ...classifyProduct(product, defaultRules, { duplicates: [] }),
    id: 'eval-1',
    createdAt: new Date(),
  };
}

function approval(evaluation: StoredEvaluation, overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    productId: evaluation.productId,
    evaluationId: evaluation.id,
    decision: 'APPROVED',
    reviewer: 'Ana',
    notes: null,
    productContentHash: evaluation.productContentHash,
    rulesHash: evaluation.rulesHash,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('aprobación humana — checkDecision', () => {
  const product = makeCatalogProduct();
  const evaluation = evaluate(product);
  const input = { decision: 'APPROVED' as const, evaluationId: 'eval-1', notes: null };

  it('permite aprobar la evaluación vigente', () => {
    expect(checkDecision(input, product, evaluation, defaultRules.hash)).toEqual({ ok: true });
  });

  it('exige que exista una evaluación y que sea la que la persona revisó', () => {
    expect(checkDecision(input, product, null, defaultRules.hash)).toMatchObject({
      ok: false,
      code: 'EVALUATION_REQUIRED',
    });
    expect(
      checkDecision({ ...input, evaluationId: 'otra' }, product, evaluation, defaultRules.hash),
    ).toMatchObject({ ok: false, code: 'EVALUATION_MISMATCH' });
  });

  it('rechaza decisiones sobre evaluaciones obsoletas (cambió el producto o las reglas)', () => {
    expect(
      checkDecision(input, { ...product, contentHash: 'cambiado' }, evaluation, defaultRules.hash),
    ).toMatchObject({ code: 'EVALUATION_STALE' });
    expect(checkDecision(input, product, evaluation, 'reglas-nuevas')).toMatchObject({
      code: 'EVALUATION_STALE',
    });
  });

  it('no permite aprobar lo que el motor rechazó, pero sí registrar un rechazo humano', () => {
    const rejectedProduct = makeCatalogProduct({ variants: [makeVariant({ inventory: [] })] });
    const rejected = evaluate(rejectedProduct);
    expect(rejected.classification).toBe('REJECTED');
    expect(checkDecision(input, rejectedProduct, rejected, defaultRules.hash)).toMatchObject({
      code: 'NOT_APPROVABLE',
    });
    expect(
      checkDecision(
        { ...input, decision: 'REJECTED' },
        rejectedProduct,
        rejected,
        defaultRules.hash,
      ),
    ).toEqual({ ok: true });
  });

  it('exige notas para aprobar productos REVIEW_REQUIRED', () => {
    const reviewProduct = makeCatalogProduct({ description: null });
    const review = evaluate(reviewProduct);
    expect(review.classification).toBe('REVIEW_REQUIRED');
    expect(checkDecision(input, reviewProduct, review, defaultRules.hash)).toMatchObject({
      code: 'REVIEW_NOTES_REQUIRED',
    });
    expect(
      checkDecision(
        { ...input, notes: 'Descripción redactada y revisada manualmente' },
        reviewProduct,
        review,
        defaultRules.hash,
      ),
    ).toEqual({ ok: true });
  });
});

describe('autorización de publicación — independiente de la clasificación', () => {
  const product = makeCatalogProduct();
  const evaluation = evaluate(product);

  it('APPROVED del motor sin aprobación humana NO autoriza publicar', () => {
    expect(evaluation.classification).toBe('APPROVED');
    expect(
      checkPublicationAuthorization(product, evaluation, null, defaultRules.hash),
    ).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
  });

  it('autoriza con aprobación humana vigente', () => {
    expect(
      checkPublicationAuthorization(product, evaluation, approval(evaluation), defaultRules.hash),
    ).toEqual({ ok: true });
  });

  it('bloquea si la última decisión fue rechazar o si la aprobación quedó obsoleta', () => {
    expect(
      checkPublicationAuthorization(
        product,
        evaluation,
        approval(evaluation, { decision: 'REJECTED' }),
        defaultRules.hash,
      ),
    ).toMatchObject({ code: 'APPROVAL_REJECTED' });
    expect(
      checkPublicationAuthorization(
        product,
        evaluation,
        approval(evaluation, { evaluationId: 'vieja' }),
        defaultRules.hash,
      ),
    ).toMatchObject({ code: 'APPROVAL_STALE' });
    expect(
      checkPublicationAuthorization(
        { ...product, contentHash: 'nuevo' },
        evaluation,
        approval(evaluation),
        defaultRules.hash,
      ),
    ).toMatchObject({ code: 'EVALUATION_STALE' });
  });
});

describe('buildStoreDraft', () => {
  it('prepara un borrador DRAFT solo con variantes elegibles y precio de la evaluación', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({ externalId: 'A', sku: 'SKU-A', options: { Color: 'Negro' } }),
        makeVariant({ externalId: 'B', sku: 'SKU-B', options: { Color: 'Blanco' } }),
        makeVariant({ externalId: 'C', sku: 'SKU-C', options: { Color: 'Rojo' }, inventory: [] }),
      ],
    });
    const { draft, issues } = buildStoreDraft(product, evaluate(product), { vendor: 'Mi Tienda' });
    expect(issues).toEqual([]);
    expect(draft!.status).toBe('DRAFT');
    expect(draft!.handle).toBe(buildStoreHandle(product));
    expect(draft!.handle).toBe('dsp-test-sup-p-1');
    expect(draft!.options).toEqual([{ name: 'Color', values: ['Negro', 'Blanco'] }]);
    expect(draft!.variants.map((v) => [v.sku, v.priceCents])).toEqual([
      ['SKU-A', 2999],
      ['SKU-B', 2999],
    ]);
    expect(draft!.vendor).toBe('Mi Tienda');
  });

  it('sanea la descripción HTML del proveedor (sin scripts ni atributos)', () => {
    const product = makeCatalogProduct({
      description:
        '<p onclick="x()">Hola <b>mundo</b></p><script>alert(1)</script><img src=x onerror=alert(2)>Línea 2 & más',
    });
    const { draft } = buildStoreDraft(product, evaluate(product), { vendor: null });
    expect(draft!.descriptionHtml).toBe('<p>Hola mundo</p>\n<p>Línea 2 &amp; más</p>');
  });

  it('el hash del borrador es determinista', () => {
    const product = makeCatalogProduct();
    const evaluation = evaluate(product);
    expect(buildStoreDraft(product, evaluation, { vendor: null }).draft!.draftHash).toBe(
      buildStoreDraft(product, evaluation, { vendor: null }).draft!.draftHash,
    );
  });

  it('informa por qué no se puede preparar (sin variantes elegibles, opciones incompletas o repetidas)', () => {
    const none = makeCatalogProduct({ variants: [makeVariant({ inventory: [] })] });
    expect(buildStoreDraft(none, evaluate(none), { vendor: null }).issues[0]!.message).toMatch(
      /no hay variantes elegibles/,
    );

    const repeated = makeCatalogProduct({
      variants: [
        makeVariant({ externalId: 'A', options: { Color: 'Negro' } }),
        makeVariant({ externalId: 'B', options: { Color: 'Negro' } }),
      ],
    });
    expect(
      buildStoreDraft(repeated, evaluate(repeated), { vendor: null }).issues[0]!.message,
    ).toMatch(/repetida/);

    const partial = makeCatalogProduct({
      variants: [
        makeVariant({ externalId: 'A', options: { Color: 'Negro', Talla: 'M' } }),
        makeVariant({ externalId: 'B', options: { Color: 'Blanco' } }),
      ],
    });
    expect(
      buildStoreDraft(partial, evaluate(partial), { vendor: null }).issues[0]!.message,
    ).toMatch(/no define todas las opciones/);
  });

  it('crea una opción sintética si hay varias variantes sin opciones', () => {
    const product = makeCatalogProduct({
      variants: [
        makeVariant({ externalId: 'A', name: 'Pack x1' }),
        makeVariant({ externalId: 'B', name: 'Pack x2' }),
      ],
    });
    const { draft } = buildStoreDraft(product, evaluate(product), { vendor: null });
    expect(draft!.options).toEqual([{ name: 'Variante', values: ['Pack x1', 'Pack x2'] }]);
  });
});
