// Genera los workflows de n8n de la Fase 2 (A, B, C) en el directorio indicado.
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const OUT = process.argv[2];
const CRED = { httpHeaderAuth: { id: 'dropshipBackendAdmin', name: 'Dropship Backend - Admin (X-Api-Key)' } };
const RESPONSE_OPTS = (timeout) => ({ timeout, response: { response: { fullResponse: true, neverError: true } } });
const id = () => randomUUID();

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({ parameters, id: id(), name, type, typeVersion, position, ...extra });
const manual = (y = 0) => node('Ejecutar manualmente', 'n8n-nodes-base.manualTrigger', 1, [0, y], {});
const schedule = (hours) =>
  node('Programación (desactivada)', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 200], { rule: { interval: [{ field: 'hours', hoursInterval: hours }] } }, {
    disabled: true,
    notes: `Actívela para ejecutar cada ${hours} h y active el workflow. Mientras esté desactivada solo corre manualmente.`,
  });
const config = (pos, fields, notes) =>
  node(
    'Configuración',
    'n8n-nodes-base.set',
    3.4,
    pos,
    { assignments: { assignments: fields.map(([name, value, type]) => ({ id: id(), name, value, type })) }, options: {} },
    { notes },
  );
const http = (name, pos, p, notes) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...p }, { credentials: CRED, ...(notes && { notes }) });
const code = (name, pos, jsCode, notes) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode }, notes ? { notes } : {});
const ifEquals = (name, pos, left, right) =>
  node(name, 'n8n-nodes-base.if', 2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: id(), leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
    options: {},
  });
const link = (connections, from, to, output = 0) => {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
};
const workflow = (name, nodes, connections) => ({ name, nodes, connections, pinData: {}, settings: { executionOrder: 'v1' } });
const CFG = "$('Configuración').first().json";
const SAFE = 'const safeAll = (name) => { try { return $(name).all(); } catch (error) { return []; } };';

// ---------------------------------------------------------------- Workflow A
{
  const nodes = [
    manual(),
    schedule(6),
    config(
      [220, 100],
      [
        ['baseUrl', 'http://host.docker.internal:3000', 'string'],
        ['shipsFrom', 'US', 'string'],
        ['pageSize', 20, 'number'],
        ['batchSize', 10, 'number'],
        ['runId', '={{ $execution.id }}-{{ $now.toMillis() }}', 'string'],
      ],
      'baseUrl usa host.docker.internal (n8n en Docker, backend en Windows). batchSize máximo 50. runId (calculado una vez por ejecución) hace única la Idempotency-Key aunque n8n reutilice IDs de ejecución.',
    ),
    http('Consultar proveedores', [440, 100], { url: '={{ $json.baseUrl }}/api/v1/suppliers', options: { timeout: 15000 } }),
    code(
      'Proveedores habilitados',
      [660, 100],
      `// Orquestación: solo se consultan proveedores habilitados y con credenciales.
const suppliers = $input.first().json.data ?? [];
return suppliers.filter((s) => s.enabled && s.configured).map((s) => ({ json: { supplierId: s.id, name: s.name, kind: s.kind } }));`,
      'Si ningún proveedor está habilitado y configurado, el flujo termina aquí.',
    ),
    http(
      'Obtener productos del proveedor',
      [880, 100],
      {
        url: `={{ ${CFG}.baseUrl }}/api/v1/suppliers/{{ $json.supplierId }}/products`,
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'shipsFrom', value: `={{ ${CFG}.shipsFrom }}` },
            { name: 'pageSize', value: `={{ ${CFG}.pageSize }}` },
            { name: 'page', value: '1' },
          ],
        },
        options: RESPONSE_OPTS(60000),
      },
      'Una llamada por proveedor. Los errores (p. ej. 503 sin credenciales) se registran en el resumen.',
    ),
    code(
      'Preparar lotes de importación',
      [1100, 100],
      `// "Normalización" en n8n = solo dar forma a la solicitud (lotes de IDs externos).
// La normalización real del catálogo y sus validaciones las hace el backend.
const config = ${CFG};
const suppliers = $('Proveedores habilitados').all();
const batches = [];
$input.all().forEach((item, index) => {
  const supplierId = suppliers[index]?.json.supplierId;
  if (item.json.statusCode !== 200) return;
  const ids = (item.json.body?.data ?? []).map((p) => p.externalId).filter(Boolean);
  for (let i = 0; i < ids.length; i += config.batchSize) {
    batches.push({ json: { kind: 'batch', supplierId, externalProductIds: ids.slice(i, i + config.batchSize), idempotencyKey: \`import-\${supplierId}-\${config.runId}-\${i / config.batchSize}\` } });
  }
});
return batches.length > 0 ? batches : [{ json: { kind: 'none', message: 'No hay productos para importar' } }];`,
    ),
    ifEquals('¿Hay lotes?', [1320, 0], '={{ $json.kind }}', 'batch'),
    http(
      'Importar en backend',
      [1540, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.baseUrl }}/api/v1/products/import`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ supplierId: $json.supplierId, externalProductIds: $json.externalProductIds }) }}',
        options: RESPONSE_OPTS(600000),
      },
      'Idempotency-Key por lote y ejecución. Con CJ (1 req/s) un lote puede tardar varios minutos.',
    ),
    code(
      'Registrar resultados',
      [1320, 300],
      `// Rama inferior: se ejecuta después de la importación (orden de ejecución v1).
${SAFE}
const config = ${CFG};
const suppliers = $('Proveedores habilitados').all();
const proveedores = safeAll('Obtener productos del proveedor').map((item, index) => ({
  supplierId: suppliers[index]?.json.supplierId ?? null,
  statusCode: item.json.statusCode,
  totalDisponibles: item.json.body?.pagination?.total ?? null,
  error: item.json.statusCode === 200 ? null : (item.json.body?.error ?? item.json.body ?? null),
}));
const lotes = safeAll('Importar en backend').map((item) => {
  const data = item.json.body?.data;
  if (item.json.statusCode !== 200 || !data) return { statusCode: item.json.statusCode, error: item.json.body?.error ?? item.json.body ?? null };
  return {
    statusCode: item.json.statusCode,
    reproducida: item.json.headers?.['idempotent-replayed'] === 'true',
    syncRunId: data.syncRunId,
    supplierId: data.supplierId,
    estado: data.status,
    resumen: data.summary,
    fallidos: data.items.filter((x) => x.error).map((x) => ({ externalId: x.externalId, codigo: x.error.code, reintentable: x.error.retryable })),
    noValidos: data.items.filter((x) => x.validationStatus && x.validationStatus !== 'VALID').map((x) => ({ externalId: x.externalId, validacion: x.validationStatus })),
  };
});
const totales = {};
for (const lote of lotes) for (const [k, v] of Object.entries(lote.resumen ?? {})) totales[k] = (totales[k] ?? 0) + v;
return [{ json: { workflow: 'A - Importación', backend: config.baseUrl, generadoEn: new Date().toISOString(), proveedores, lotesEnviados: lotes.length, totales, lotes, nota: 'La normalización, validación y deduplicación las hace el backend (idempotente por proveedor + ID externo).' } }];`,
    ),
  ];
  const c = {};
  link(c, 'Ejecutar manualmente', 'Configuración');
  link(c, 'Programación (desactivada)', 'Configuración');
  link(c, 'Configuración', 'Consultar proveedores');
  link(c, 'Consultar proveedores', 'Proveedores habilitados');
  link(c, 'Proveedores habilitados', 'Obtener productos del proveedor');
  link(c, 'Obtener productos del proveedor', 'Preparar lotes de importación');
  link(c, 'Preparar lotes de importación', '¿Hay lotes?');
  link(c, 'Preparar lotes de importación', 'Registrar resultados');
  link(c, '¿Hay lotes?', 'Importar en backend', 0);
  writeFileSync(`${OUT}/A-importacion.workflow.json`, JSON.stringify(workflow('Fase 2 - A - Importación de productos', nodes, c), null, 2) + '\n');
}

// ---------------------------------------------------------------- Workflow B
{
  const nodes = [
    manual(),
    schedule(12),
    config(
      [220, 100],
      [
        ['baseUrl', 'http://host.docker.internal:3000', 'string'],
        ['batchSize', 50, 'number'],
      ],
      'batchSize máximo 100. Las reglas (márgenes, costos, categorías) están en config/evaluation-rules.json del backend.',
    ),
    http(
      'Consultar pendientes',
      [440, 100],
      {
        url: '={{ $json.baseUrl }}/api/v1/products/candidates',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'evaluation', value: 'PENDING' }, { name: 'pageSize', value: '100' }] },
        options: { timeout: 30000 },
      },
      'Pendientes = sin evaluación o con evaluación obsoleta (cambió el producto o las reglas).',
    ),
    code(
      'Lotes de pendientes',
      [660, 100],
      `const config = ${CFG};
const ids = ($input.first().json.data ?? []).map((p) => p.id);
if (ids.length === 0) return [{ json: { productIds: null, pendientes: 0 } }];
const batches = [];
for (let i = 0; i < ids.length; i += config.batchSize) batches.push({ json: { productIds: ids.slice(i, i + config.batchSize), pendientes: ids.length } });
return batches;`,
    ),
    http(
      'Evaluar y guardar',
      [880, 100],
      {
        method: 'POST',
        url: `={{ ${CFG}.baseUrl }}/api/v1/products/evaluate`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.productIds ? { productIds: $json.productIds } : { limit: 100 }) }}',
        options: { timeout: 120000 },
      },
      'El backend aplica las reglas de rentabilidad y clasificación y guarda el resultado.',
    ),
    http('Consultar resultados', [1100, 100], {
      url: `={{ ${CFG}.baseUrl }}/api/v1/products/candidates`,
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'classification', value: 'APPROVED,REVIEW_REQUIRED,REJECTED' }, { name: 'pageSize', value: '100' }] },
      options: { timeout: 30000 },
    }),
    code(
      'Resumen de evaluación',
      [1320, 100],
      `const totales = {};
for (const item of $('Evaluar y guardar').all()) for (const [k, v] of Object.entries(item.json.data?.summary ?? {})) totales[k] = (totales[k] ?? 0) + v;
const products = $input.first().json.data ?? [];
const pick = (classification) => products.filter((p) => p.classification === classification).map((p) => ({
  id: p.id,
  externalId: p.externalId,
  nombre: p.name,
  decisionHumana: p.approvalState,
  evaluationId: p.latestEvaluation?.id ?? null,
  rangoPrecio: p.latestEvaluation?.summary?.priceRange ?? null,
  margenMinimoEstimadoPct: p.latestEvaluation?.summary?.minEstimatedProfitMarginPercent ?? null,
  hallazgos: (p.latestEvaluation?.findings ?? []).filter((f) => f.outcome !== 'PASS').map((f) => \`\${f.rule} (\${f.outcome}): \${f.detail}\`),
}));
return [{ json: {
  workflow: 'B - Evaluación',
  generadoEn: new Date().toISOString(),
  evaluadosEnEstaEjecucion: totales.evaluated ?? 0,
  totalesEstaEjecucion: totales,
  aprobadosPorMotor: pick('APPROVED'),
  requierenRevision: pick('REVIEW_REQUIRED'),
  rechazados: pick('REJECTED'),
  recordatorio: 'APPROVED del motor NO autoriza publicar. Una persona debe aprobar con APPROVER_API_KEY: POST /api/v1/products/:id/approve.',
  nota: 'Márgenes y beneficios son estimaciones con los costos configurados; no son ganancias netas definitivas.',
} }];`,
    ),
  ];
  nodes.find((x) => x.name === 'Consultar resultados').executeOnce = true;
  const c = {};
  link(c, 'Ejecutar manualmente', 'Configuración');
  link(c, 'Programación (desactivada)', 'Configuración');
  link(c, 'Configuración', 'Consultar pendientes');
  link(c, 'Consultar pendientes', 'Lotes de pendientes');
  link(c, 'Lotes de pendientes', 'Evaluar y guardar');
  link(c, 'Evaluar y guardar', 'Consultar resultados');
  link(c, 'Consultar resultados', 'Resumen de evaluación');
  writeFileSync(`${OUT}/B-evaluacion.workflow.json`, JSON.stringify(workflow('Fase 2 - B - Evaluación y clasificación', nodes, c), null, 2) + '\n');
}

// ---------------------------------------------------------------- Workflow C
{
  const nodes = [
    manual(100),
    config(
      [220, 100],
      [
        ['baseUrl', 'http://host.docker.internal:3000', 'string'],
        ['createDrafts', false, 'boolean'],
        ['pageSize', 50, 'number'],
      ],
      'createDrafts=false (por defecto): solo valida y prepara (dry-run). En true crea BORRADORES si el backend tiene la tienda y la escritura habilitadas.',
    ),
    http(
      'Aprobados por una persona',
      [440, 100],
      {
        url: '={{ $json.baseUrl }}/api/v1/products/candidates',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'approval', value: 'APPROVED' },
            { name: 'publication', value: 'NONE,FAILED,PRODUCT_CREATED' },
            { name: 'pageSize', value: '={{ $json.pageSize }}' },
          ],
        },
        options: { timeout: 30000 },
      },
      'approval=APPROVED es la decisión HUMANA vigente (no la clasificación del motor).',
    ),
    code(
      'Separar aprobados',
      [660, 100],
      `const products = $input.first().json.data ?? [];
if (products.length === 0) return [{ json: { kind: 'none', message: 'No hay productos aprobados por una persona pendientes de publicar' } }];
return products.map((p) => ({ json: { kind: 'product', id: p.id, externalId: p.externalId, name: p.name, approvalId: p.approval?.id ?? null, publicationStatus: p.publicationStatus } }));`,
    ),
    ifEquals('¿Hay productos?', [880, 0], '={{ $json.kind }}', 'product'),
    http(
      'Validar y preparar (dry-run)',
      [1100, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.baseUrl }}/api/v1/products/{{ $json.id }}/shopify/draft`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={"dryRun": true}',
        options: RESPONSE_OPTS(60000),
      },
      'Valida aprobación e información requerida, busca un producto equivalente en la tienda y prepara el contenido. No escribe.',
    ),
    code(
      'Decidir creación',
      [1320, 0],
      `const config = ${CFG};
const products = $('¿Hay productos?').all();
return $input.all().map((item, index) => {
  const product = products[index]?.json ?? {};
  const data = item.json.body?.data;
  const ok = item.json.statusCode === 200 && data?.outcome === 'DRY_RUN';
  const ready = ok && data.checks.every((c) => c.passed);
  const writable = ok && data.store.mode !== 'disabled' && data.store.writeEnabled === true;
  const action = config.createDrafts === true && ready && writable ? 'create' : 'skip';
  const motivo = action === 'create' ? null
    : !ok ? (data?.outcome === 'ALREADY_EXISTS' ? 'ya existe el borrador' : 'el dry-run devolvió un error')
    : !ready ? 'no supera las verificaciones'
    : !writable ? 'tienda o escritura deshabilitada en el backend'
    : 'createDrafts=false (modo revisión)';
  return { json: {
    action, motivo, ready,
    productId: product.id, externalId: product.externalId, approvalId: product.approvalId,
    statusCode: item.json.statusCode,
    store: data?.store ?? null,
    checks: data?.checks ?? null,
    draft: data?.draft ? { handle: data.draft.handle, title: data.draft.title, status: data.draft.status, variantes: data.draft.variants.length, precios: data.draft.variants.map((v) => v.price) } : null,
    equivalentStoreProduct: data?.equivalentStoreProduct ?? null,
    error: ok ? null : (item.json.body?.error ?? data ?? null),
    idempotencyKey: \`draft-\${product.id}-\${product.approvalId}\`,
  } };
});`,
    ),
    ifEquals('¿Crear borrador?', [1540, 0], '={{ $json.action }}', 'create'),
    http(
      'Crear borrador en Shopify',
      [1760, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.baseUrl }}/api/v1/products/{{ $json.productId }}/shopify/draft`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={"dryRun": false, "confirm": true}',
        options: RESPONSE_OPTS(120000),
      },
      'Solo crea productos en estado DRAFT. En modo live el backend exige además SHOPIFY_WRITE_ENABLED=true.',
    ),
    code(
      'Registrar resultados',
      [880, 300],
      `// Rama inferior: se ejecuta después de la rama de creación (orden de ejecución v1).
${SAFE}
const config = ${CFG};
const decisions = safeAll('Decidir creación').map((i) => i.json);
const toCreate = decisions.filter((d) => d.action === 'create');
const creations = {};
safeAll('Crear borrador en Shopify').forEach((item, index) => {
  const d = toCreate[index];
  if (d) creations[d.productId] = { statusCode: item.json.statusCode, outcome: item.json.body?.data?.outcome ?? null, storeProduct: item.json.body?.data?.storeProduct ?? null, publication: item.json.body?.data?.publication ?? null, error: item.json.body?.error ?? null };
});
const resultados = decisions.map((d) => ({
  productId: d.productId,
  externalId: d.externalId,
  accion: d.action,
  motivo: d.motivo,
  verificaciones: (d.checks ?? []).map((c) => \`\${c.name}: \${c.passed ? 'OK' : 'NO'} — \${c.detail}\`),
  borradorPreparado: d.draft,
  creacion: creations[d.productId] ?? null,
  error: d.error,
}));
return [{ json: {
  workflow: 'C - Preparación para Shopify',
  generadoEn: new Date().toISOString(),
  modo: config.createDrafts ? 'crear borradores si el backend lo permite' : 'solo revisión (dry-run)',
  tienda: decisions[0]?.store ?? null,
  sinProductos: $input.first().json.kind === 'none',
  preparados: decisions.filter((d) => d.ready).length,
  creados: Object.values(creations).filter((c) => c.outcome === 'CREATED').length,
  resultados,
  recordatorio: 'Solo se crean borradores (DRAFT). Activar o publicar en Shopify es una acción manual posterior.',
} }];`,
    ),
  ];
  const c = {};
  link(c, 'Ejecutar manualmente', 'Configuración');
  link(c, 'Configuración', 'Aprobados por una persona');
  link(c, 'Aprobados por una persona', 'Separar aprobados');
  link(c, 'Separar aprobados', '¿Hay productos?');
  link(c, 'Separar aprobados', 'Registrar resultados');
  link(c, '¿Hay productos?', 'Validar y preparar (dry-run)', 0);
  link(c, 'Validar y preparar (dry-run)', 'Decidir creación');
  link(c, 'Decidir creación', '¿Crear borrador?');
  link(c, '¿Crear borrador?', 'Crear borrador en Shopify', 0);
  writeFileSync(`${OUT}/C-shopify-borradores.workflow.json`, JSON.stringify(workflow('Fase 2 - C - Preparación de borradores en Shopify', nodes, c), null, 2) + '\n');
}
console.log('workflows generados en', OUT);
