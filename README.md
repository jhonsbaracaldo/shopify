# Backend de automatización para dropshipping (Colombia → EE. UU.)

Backend en Node.js + TypeScript + Fastify. Importa catálogos de proveedores con bodegas en EE. UU., los normaliza y estima su rentabilidad. Con esa información clasifica los productos y, **solo con aprobación humana**, prepara o crea borradores en Shopify. n8n (Docker) orquesta los procesos y el backend aplica todas las reglas de negocio.

- **Fase 1** (evaluación sin estado con datos simulados): sigue disponible sin cambios. Su documentación está en [docs/fase-1.md](docs/fase-1.md).
- **Resumen del avance, guía de arranque y evidencias:** carpeta [avance-del-proyecto/](avance-del-proyecto/README.md).
- **Fase 2** (este documento): proveedores, catálogo normalizado, motor de rentabilidad, clasificación, persistencia, aprobación humana, Shopify y workflows de n8n.

---

## Contenido

1. [Estado de la Fase 2](#estado-de-la-fase-2)
2. [Requisitos e instalación](#requisitos-e-instalación)
3. [Comandos npm](#comandos-npm)
4. [Variables de entorno y credenciales](#variables-de-entorno-y-credenciales)
5. [Arquitectura](#arquitectura)
6. [Catálogo normalizado](#catálogo-normalizado)
7. [Motor de rentabilidad](#motor-de-rentabilidad)
8. [Clasificación y aprobación humana](#clasificación-y-aprobación-humana)
9. [Persistencia](#persistencia)
10. [API REST](#api-rest)
11. [Integración con Shopify](#integración-con-shopify)
12. [Workflows de n8n](#workflows-de-n8n)
13. [Seguridad y confiabilidad](#seguridad-y-confiabilidad)
14. [Pruebas y resultados](#pruebas-y-resultados)
15. [Integraciones que requieren cuentas externas](#integraciones-que-requieren-cuentas-externas)
16. [Limitaciones y pendientes](#limitaciones-y-pendientes)

---

## Estado de la Fase 2

Leyenda: **Real** = verificado contra el sistema real en este equipo. **Mock** = probado con dobles de prueba o fixtures. **Cuenta** = falta probarlo con credenciales externas.

| Componente                                                    | Implementado | Probado                                                       | Pendiente                                                                                                       |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Catálogo normalizado, variantes, deduplicación                | ✅           | Real (PostgreSQL) + unitarias                                 | —                                                                                                               |
| Motor de rentabilidad y clasificación                         | ✅           | Unitarias + integración                                       | Ajustar costos a datos reales                                                                                   |
| Persistencia PostgreSQL con migraciones                       | ✅           | Real: suite de contrato contra PostgreSQL 17.11               | —                                                                                                               |
| Idempotencia (import, evaluación, borradores)                 | ✅           | Real (PostgreSQL) + HTTP                                      | —                                                                                                               |
| Aprobación humana separada del motor                          | ✅           | Real (HTTP) + unitarias                                       | —                                                                                                               |
| API REST protegida (roles admin/approver)                     | ✅           | Integración HTTP + llamadas reales                            | —                                                                                                               |
| Proveedor mock EE. UU. (ficticio)                             | ✅           | Real (usado por n8n)                                          | —                                                                                                               |
| Adaptador **CJdropshipping** API 2.0                          | ✅           | Mock: fixtures de contrato construidas desde la documentación | **Cuenta**: API key de CJ                                                                                       |
| Adaptador **Shopify** Admin GraphQL 2026-10 (solo borradores) | ✅           | Mock: `fetch` simulado                                        | **Cuenta**: tienda y app de Shopify                                                                             |
| Tienda simulada (`SHOPIFY_MODE=mock`)                         | ✅           | Real (usada por n8n)                                          | —                                                                                                               |
| Workflows n8n A, B y C                                        | ✅           | Real: ejecutados con el motor de n8n 2.43.7                   | Importarlos en la interfaz de su n8n                                                                            |
| Otros proveedores con inventario en EE. UU.                   | ❌           | —                                                             | No hay API pública documentada verificable (ver [integraciones](#integraciones-que-requieren-cuentas-externas)) |

## Requisitos e instalación

| Herramienta              | Versión probada                                               |
| ------------------------ | ------------------------------------------------------------- |
| Node.js                  | 22.15 (mínimo 20)                                             |
| npm                      | 11.3                                                          |
| Docker Desktop (Windows) | 29.8                                                          |
| n8n Community            | 2.43.7 (contenedor existente en `http://localhost:5678`)      |
| PostgreSQL               | 17 (contenedor `dropship-postgres`, creado por este proyecto) |

```powershell
cd C:\shopify
npm install
copy .env.example .env          # complete las claves (ver docs/credenciales.md)
npm run db:up                   # crea/inicia SOLO el contenedor dropship-postgres (127.0.0.1:5433)
npm run db:migrate              # aplica migraciones (también se aplican al arrancar si DB_AUTO_MIGRATE=true)
npm run dev                     # o: npm run build && npm start
```

- **Puertos:** el equipo ya tiene un PostgreSQL nativo en el puerto 5432, por eso el contenedor usa el **5433**.
- **Contenedor n8n:** no se modifica ni se recrea.
- **Sin `DATABASE_URL`:** el backend funciona con persistencia **en memoria**, útil para pruebas rápidas; los datos se pierden al reiniciar.

Comprobación rápida:

```powershell
curl.exe http://localhost:3000/health
```

La respuesta incluye `components.persistence`, `store`, `suppliers` y `auth`, sin secretos.

## Comandos npm

| Comando                                                 | Descripción                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                                           | Servidor con recarga automática (`tsx watch`).                                |
| `npm run build` / `npm start`                           | Compila a `dist/` y ejecuta la versión compilada.                             |
| `npm test`                                              | Todas las pruebas. Las de PostgreSQL se omiten si no hay `TEST_DATABASE_URL`. |
| `npm run test:postgres`                                 | Solo la suite de contrato contra PostgreSQL real.                             |
| `npm run test:coverage`                                 | Pruebas con cobertura.                                                        |
| `npm run db:up` / `npm run db:down`                     | Inicia o detiene el contenedor `dropship-postgres`.                           |
| `npm run db:migrate`                                    | Aplica las migraciones pendientes de `migrations/`.                           |
| `npm run typecheck` · `npm run lint` · `npm run format` | Calidad de código.                                                            |

Para ejecutar las pruebas de PostgreSQL desde PowerShell, cargue antes `TEST_DATABASE_URL` desde `.env`:

```powershell
$env:TEST_DATABASE_URL = (Select-String -Path .env -Pattern '^TEST_DATABASE_URL=(.*)$').Matches.Groups[1].Value
npm test
```

## Variables de entorno y credenciales

Todas las variables se validan con Zod al arrancar. Si una es inválida, el proceso termina indicando **cuál** y por qué, sin mostrar su valor. Hay una plantilla comentada en [.env.example](.env.example); cómo obtener cada credencial se explica en **[docs/credenciales.md](docs/credenciales.md)**.

| Grupo        | Variables principales                                                                                                                                                          | Por defecto                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Servidor     | `HOST`, `PORT`, `LOG_LEVEL`                                                                                                                                                    | `127.0.0.1`, `3000`, `info`                   |
| Seguridad    | `ADMIN_API_KEY`, `APPROVER_API_KEY` (32+ caracteres, distintas)                                                                                                                | sin definir → endpoints de la Fase 2 en `503` |
| Persistencia | `DATABASE_URL`, `DB_AUTO_MIGRATE`, `POSTGRES_PASSWORD`, `TEST_DATABASE_URL`                                                                                                    | memoria                                       |
| Reglas       | `RULES_FILE`                                                                                                                                                                   | `config/evaluation-rules.json`                |
| Proveedores  | `MOCK_SUPPLIER_ENABLED`, `CJ_ENABLED`, `CJ_API_KEY`, `CJ_MAX_REQUESTS_PER_SECOND`, `CJ_TIMEOUT_MS`, `CJ_MAX_QUOTED_VARIANTS`                                                   | mock activo, CJ apagado                       |
| Tienda       | `SHOPIFY_MODE` (`disabled`/`mock`/`live`), `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION`, `SHOPIFY_CLIENT_ID`/`SECRET` o `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_WRITE_ENABLED` | `mock`, `2026-10`, escritura **apagada**      |
| Fase 1       | `DEFAULT_TARGET_MARGIN_PERCENT`, `DEFAULT_MAX_DELIVERY_DAYS`, `DEFAULT_REQUIRED_ORIGIN_COUNTRY`                                                                                | 30, 7, US                                     |

> `SHOPIFY_WRITE_ENABLED` solo afecta al modo `live`. En modo `mock` las escrituras van a una tienda simulada en memoria y nunca contactan a Shopify.

## Arquitectura

```
                    ┌────────────── n8n (Docker) ──────────────┐
                    │  A Importación · B Evaluación · C Shopify │  ← orquesta, no decide
                    └───────────────┬──────────────────────────┘
                                    │ HTTP  X-Api-Key (admin)  host.docker.internal:3000
 Persona revisora ── X-Api-Key (approver) ──┐
                                    ▼       ▼
┌──────────────────────── Backend (Windows, 127.0.0.1:3000) ───────────────────────────┐
│ http/       rutas · auth por rol · idempotencia · validación Zod · errores uniformes   │
│ application/ casos de uso: Import · Evaluate · RecordDecision · CreateStoreDraft       │
│             puertos: SupplierPort · StorePort · Persistence · Logger                   │
│ domain/     catálogo · rentabilidad · clasificación · aprobación · borrador (puro)     │
│ adapters/   CJ API 2.0 · proveedor mock · Shopify GraphQL · tienda mock               │
│             PostgreSQL / memoria · cliente HTTP resiliente (timeouts, backoff, límites)│
└────────────────────────────────┬───────────────────────────────────────────────────────┘
                                 ▼
                  PostgreSQL 17 (dropship-postgres, 127.0.0.1:5433)
```

```
src/
├── domain/        catalog.ts · profitability.ts · classification.ts · approval.ts · store-draft.ts
│                  rules.ts · money.ts · text.ts   (+ módulos de la Fase 1: product, pricing, evaluation)
├── application/   ports/ (supplier-port, store-port, persistence, logger) · use-cases/ · supplier-registry.ts
├── adapters/      http/resilient-http-client.ts
│                  suppliers/cj/ (cliente, mapeadores, adaptador) · suppliers/mock-us-supplier.ts
│                  store/shopify/ (auth, graphql client, store) · store/mock-store.ts · store/disabled-store.ts
│                  persistence/memory-persistence.ts · persistence/postgres/ (persistencia, migrador)
├── http/          app.ts · auth.ts · idempotency.ts · routes/ · schemas/ · presenters/
├── config/        env.ts · rules.ts
├── composition.ts (ensambla adaptadores según la configuración) · server.ts · scripts/migrate.ts
config/evaluation-rules.json   reglas editables sin tocar código
migrations/0001_initial_catalog.sql
docker-compose.yml · docker/postgres/init/   (solo PostgreSQL)
n8n/               A-importacion · B-evaluacion · C-shopify-borradores · evaluar-productos (Fase 1)
tests/             phase2/ (unit, adapters, use-cases, integration) · contract/ · postgres/ · Fase 1
```

**Para agregar un proveedor**, implemente `SupplierPort` y regístrelo en `composition.ts`. El puerto cubre listar productos, consultar el detalle, las variantes, el inventario por bodega y las cotizaciones de envío. Cada adaptador declara sus `capabilities`.

## Catálogo normalizado

Cada adaptador traduce la respuesta del proveedor a un modelo común (`src/domain/catalog.ts`), y el backend lo valida y lo normaliza.

| Campo                                              | Detalle                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id` / `externalId`                                | UUID interno / ID del proveedor. Unicidad por **(proveedor, ID externo)**.                                                    |
| `sku`, `name`, `description`, `category`, `images` | Textos recortados; solo imágenes `https`, sin repetir.                                                                        |
| `variants[]`                                       | Unicidad por **(producto, ID externo de variante)**. Incluyen opciones, código de barras, costo, PVP sugerido, peso e imagen. |
| `variants[].inventory[]`                           | Existencias **por bodega** con su país. `null` = desconocido.                                                                 |
| `variants[].shippingQuotes[]`                      | Cotizaciones origen→destino con costo y días. `null` = sin cotización.                                                        |
| `currency`                                         | Solo `USD`: otra moneda deja el producto como INVALID, sin conversión.                                                        |
| `lastSyncedAt`, `version`                          | Fecha de la última sincronización; la versión sube cuando cambia el contenido.                                                |
| `validation.status`                                | `VALID`, `INCOMPLETE` (falta información) o `INVALID` (no utilizable), con la lista de problemas.                             |
| `contentHash`, `dedupeKey`                         | Hash del contenido (detecta cambios e invalida evaluaciones) y huella del nombre (detecta duplicados).                        |

**El país de despacho sale de la bodega, no del proveedor.** Un proveedor "de EE. UU." puede tener una variante solo en China; esa variante se excluye.

Los datos que el proveedor no informa quedan como `null` y el producto pasa a revisión: nunca se inventan valores.

## Motor de rentabilidad

Todo se calcula en **centavos enteros** y **puntos básicos** (sin errores de coma flotante). Las reglas viven en [config/evaluation-rules.json](config/evaluation-rules.json) y se pueden cambiar **sin modificar código**. Cada evaluación guarda el `rulesVersion` y el hash de las reglas que usó.

```
costo puesto        = costo del producto + envío (cotización más barata que cumpla el plazo)
costos variables    = comisión de pago (% + fijo) + reserva de devoluciones (%) + otros costos configurables
contribución        = precio − costo puesto − costos variables                     (antes de marketing)
beneficio estimado  = contribución − CAC (costo de adquisición de cliente por unidad)
precio recomendado  = menor precio con margen de beneficio ≥ objetivo, redondeado hacia arriba a x.99
```

Reglas por defecto. Son **supuestos iniciales** que debe ajustar con sus datos reales:

| Parámetro                                     | Valor                                                            |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Margen objetivo / mínimo (beneficio estimado) | 20 % / 12 %                                                      |
| Comisión de pago                              | 2.9 % + 0.30 USD                                                 |
| Reserva de devoluciones                       | 3 %                                                              |
| CAC por unidad                                | 6.00 USD                                                         |
| Otros costos                                  | comisión de plataforma 1 % (supuesto) + apps 0.25 USD            |
| Precio máximo (techo competitivo)             | 79.99 USD                                                        |
| Envío                                         | origen US, destino US, preparación 2 días, entrega máxima 8 días |
| Inventario                                    | mínimo 10 unidades; aviso por debajo de 30                       |

Ejemplo **real** devuelto por `GET /api/v1/products/:id`, variante `MUS-1001-SLV` del proveedor mock:

```json
{
  "recommendedPrice": 29.99,
  "proposedSalePrice": 29.99,
  "economics": {
    "productCost": 9.8,
    "shippingCost": 4.95,
    "landedCost": 14.75,
    "paymentFee": 1.17,
    "returnsReserve": 0.9,
    "otherVariableCosts": [
      {
        "name": "Comisión de transacción de plataforma (supuesto, verificar plan/pasarela)",
        "amount": 0.3
      },
      { "name": "Apps y herramientas prorrateadas por unidad (supuesto)", "amount": 0.25 }
    ],
    "totalVariableCosts": 2.62,
    "contribution": 12.62,
    "contributionMarginPercent": 42.08,
    "customerAcquisitionCost": 6,
    "estimatedProfit": 6.62,
    "estimatedProfitMarginPercent": 22.07
  }
}
```

> Son **estimaciones**, no ganancias netas definitivas: no incluyen impuestos sobre la renta, costos fijos del negocio, sales tax ni variaciones reales de comisiones. Cada evaluación lo indica en `notes`.

## Clasificación y aprobación humana

Primero se evalúa cada variante (`ELIGIBLE`, `REVIEW` o `EXCLUDED`) y luego el producto:

| Regla                  | REJECT                                                    | REVIEW                                                           |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `DATA_COMPLETENESS`    | datos inválidos (sin variantes, moneda no USD…)           | falta descripción, imágenes o peso                               |
| `CATEGORY_RESTRICTION` | palabra bloqueada (armas, cuchillos, vapeo, suplementos…) | categoría regulada (bebés, juguetes, cosméticos, baterías…)      |
| `SHIPPING_ORIGIN`      | ninguna variante con bodega en EE. UU.                    | origen desconocido                                               |
| `AVAILABILITY`         | agotado o por debajo del mínimo en EE. UU.                | cantidad desconocida                                             |
| `DELIVERY_TIME`        | tránsito + preparación > máximo                           | plazo desconocido                                                |
| `PROFIT_MARGIN`        | margen < mínimo incluso con el precio techo               | margen entre mínimo y objetivo, o falta costo o envío            |
| `DUPLICATE_RISK`       | —                                                         | misma huella de nombre, código de barras o SKU que otro producto |

Si alguna regla da REJECT, el producto es **REJECTED**. Si alguna da REVIEW, o no hay variantes elegibles, es **REVIEW_REQUIRED**. En otro caso es **APPROVED**.

**APPROVED es la clasificación del motor y no autoriza a publicar.** Publicar exige una **decisión humana** aparte:

- Solo se acepta con `APPROVER_API_KEY` en `POST /products/:id/approve`, y n8n no tiene esa clave.
- La decisión queda vinculada a la evaluación que la persona revisó (`evaluationId`).
- Un producto REJECTED no se puede aprobar.
- Aprobar un REVIEW_REQUIRED exige notas de la revisión manual.
- Si el producto o las reglas cambian, la evaluación queda **PENDING** y la aprobación **STALE**: hay que evaluar y aprobar de nuevo.
- Reevaluar sin cambios no crea una evaluación nueva (salvo `force: true`), así no se invalidan aprobaciones sin motivo.

## Persistencia

**Se justificó PostgreSQL** por estas razones:

- Las aprobaciones humanas y el estado de publicación deben sobrevivir a reinicios.
- La idempotencia necesita restricciones `UNIQUE` y operaciones atómicas entre procesos.
- El historial (sincronizaciones y evaluaciones) es auditable.
- Varios clientes (n8n, personas) escriben concurrentemente.

Migraciones versionadas en `migrations/`:

- Se aplican en orden y en transacción, con candado consultivo.
- Cada una se verifica por checksum, porque son inmutables.

| Tabla                                            | Contenido                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `suppliers`, `sync_runs`, `product_sync_history` | Proveedores, ejecuciones de importación y cambios por producto (`created`/`updated`/`unchanged`) |
| `products`, `product_variants`                   | Catálogo normalizado; `UNIQUE (supplier_id, external_id)` y `UNIQUE (product_id, external_id)`   |
| `evaluations`                                    | Resultado completo del motor (JSONB) con hash del producto y de las reglas                       |
| `approvals`                                      | Decisiones humanas (quién, cuándo, notas, evaluación revisada)                                   |
| `store_publications`                             | Estado de publicación por tienda; `UNIQUE (product_id, store)` y `UNIQUE (store, handle)`        |
| `idempotency_keys`                               | Respuestas guardadas por `Idempotency-Key` (TTL 24 h)                                            |

No se guardan secretos en ninguna tabla. Las publicaciones se registran **por tienda** (`shopify:mock` vs `shopify:live:<dominio>`): un borrador simulado no bloquea el real.

## API REST

Todas las respuestas son JSON. Las listas paginadas devuelven `{ data, pagination: { page, pageSize, total, hasMore } }` (`pageSize` máximo 100). Los errores siempre tienen la forma `{ error: { code, message, details?, context? } }`.

| Método y ruta                                      | Rol (`X-Api-Key`) | Idempotency-Key               | Descripción                                                                                        |
| -------------------------------------------------- | ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /health`                                      | —                 | —                             | Estado y componentes                                                                               |
| `GET /api/v1/products`                             | —                 | —                             | **Fase 1**: catálogo simulado plano                                                                |
| `POST /api/v1/products/evaluate` con `{ product }` | —                 | —                             | **Fase 1**: evaluación sin estado (sin cambios)                                                    |
| `POST /api/v1/products/evaluate` sin `product`     | admin             | opcional                      | **Fase 2**: evalúa productos del catálogo y guarda el resultado                                    |
| `GET /api/v1/suppliers`                            | admin, approver   | —                             | Proveedores, estado y capacidades                                                                  |
| `GET /api/v1/store`                                | admin, approver   | —                             | Modo de la tienda y versión de reglas                                                              |
| `GET /api/v1/suppliers/:supplierId/products`       | admin             | —                             | Listado en vivo del proveedor (`page`, `pageSize`, `shipsFrom`, `keyword`, `categoryId`)           |
| `POST /api/v1/products/import`                     | admin             | **obligatoria**               | Importa por IDs externos o productos ya normalizados (máx. 50)                                     |
| `GET /api/v1/products/candidates`                  | admin, approver   | —                             | Filtros: `classification`, `evaluation`, `approval`, `publication`, `supplierId`, `includeDetails` |
| `GET /api/v1/products/:id`                         | admin, approver   | —                             | Detalle: producto, evaluación completa, aprobación y publicación                                   |
| `POST /api/v1/products/:id/approve`                | **approver**      | —                             | Decisión humana `{ evaluationId, reviewer, decision?, notes? }`                                    |
| `POST /api/v1/products/:id/shopify/draft`          | admin             | obligatoria si `dryRun:false` | `{ dryRun = true, confirm = false }` → prepara o crea un **borrador**                              |

**Contratos de entrada principales:**

```jsonc
// POST /products/import — opción 1 (el backend consulta al proveedor)
{ "supplierId": "mock-us", "externalProductIds": ["MUS-1001", "MUS-1002"] }
// POST /products/import — opción 2 (datos ya obtenidos, formato común en USD)
{ "supplierId": "mock-us", "products": [{ "externalId": "X", "name": "…", "currency": "USD",
  "variants": [{ "externalId": "X-1", "cost": 5.5, "inventory": [{ "warehouseId": "nj", "countryCode": "US", "quantity": 50 }] }] }] }
// POST /products/evaluate (persistente)
{ "productIds": ["<uuid>"], "force": false }            // o {} para evaluar los PENDING (limit ≤ 100)
// POST /products/:id/approve
{ "evaluationId": "<uuid de la evaluación revisada>", "reviewer": "Ana", "decision": "APPROVED", "notes": "…" }
```

`GET /products/candidates` sin filtros devuelve los productos con evaluación vigente que el motor **no** rechazó (APPROVED y REVIEW_REQUIRED).

| HTTP            | Códigos típicos                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400             | `VALIDATION_ERROR` (con `details` por campo), `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID`                                                            |
| 401 / 403       | `UNAUTHORIZED` (sin clave o clave inválida) / `FORBIDDEN` (clave de otro rol), `STORE_WRITE_DISABLED`                                                          |
| 404             | `NOT_FOUND`                                                                                                                                                    |
| 409             | `APPROVAL_REQUIRED`, `APPROVAL_STALE`, `EVALUATION_STALE`, `EVALUATION_MISMATCH`, `STORE_PRODUCT_EXISTS`, `PUBLICATION_IN_PROGRESS`, `IDEMPOTENCY_IN_PROGRESS` |
| 422             | `NOT_APPROVABLE`, `REVIEW_NOTES_REQUIRED`, `DRAFT_NOT_READY`, `CONFIRMATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `STORE_USER_ERRORS`                           |
| 429             | `SUPPLIER_RATE_LIMITED`, `STORE_RATE_LIMITED` (con `Retry-After`)                                                                                              |
| 502 / 503 / 504 | errores del proveedor o la tienda (`context.service`, `context.retryable`); `SUPPLIER_NOT_CONFIGURED`, `SUPPLIER_DISABLED`, `AUTH_NOT_CONFIGURED`; timeouts    |

Respuestas **reales** capturadas en este equipo:

```text
POST /products/<MUS-1002>/shopify/draft {}          → 409 {"error":{"code":"APPROVAL_REQUIRED","message":"Falta la aprobación humana explícita"}}
GET  /products/candidates (sin X-Api-Key)           → 401 {"error":{"code":"UNAUTHORIZED","message":"Falta el header X-Api-Key"}}
POST /products/import (sin Idempotency-Key)         → 400 {"error":{"code":"IDEMPOTENCY_KEY_REQUIRED",…}}
GET  /suppliers/cj/products (CJ_ENABLED=false)      → 503 {"error":{"code":"SUPPLIER_DISABLED","message":"El proveedor cj está deshabilitado"}}
POST /products/<id>/approve con la clave admin      → 403 FORBIDDEN
POST /products/<REVIEW_REQUIRED>/approve sin notas  → 422 REVIEW_NOTES_REQUIRED
```

Ejemplo en PowerShell de la **aprobación humana**:

```powershell
$k = @{ 'X-Api-Key' = '<APPROVER_API_KEY>' }
$p = (Invoke-RestMethod 'http://localhost:3000/api/v1/products/candidates?classification=APPROVED' -Headers $k).data[0]
$body = @{ evaluationId = $p.latestEvaluation.id; reviewer = 'Su nombre' } | ConvertTo-Json
Invoke-RestMethod -Method Post "http://localhost:3000/api/v1/products/$($p.id)/approve" -Headers $k -ContentType 'application/json' -Body $body
```

## Integración con Shopify

Adaptador `ShopifyStore` sobre **Admin GraphQL 2026-10**, verificado en shopify.dev el 2026-10-18. Implementa `StorePort`:

| Operación                     | GraphQL                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparar producto (dry-run)   | Devuelve las variables exactas que se enviarían                                                                                                           |
| Consultar por handle / por ID | `productByIdentifier(identifier: { handle })` / `product(id:)`                                                                                            |
| Crear en **borrador**         | `productCreate(product: { …, status: DRAFT, productOptions }, media)`                                                                                     |
| Asociar variantes             | `productVariantsBulkCreate(strategy: REMOVE_STANDALONE_VARIANT)`, o `productVariantsBulkUpdate` para la variante inicial si el producto no tiene opciones |
| Actualizar información        | `productUpdate` (nunca envía `status`)                                                                                                                    |
| Asociar imágenes              | `media` en `productCreate` / `productUpdate`                                                                                                              |

**Barreras para escribir** (todas obligatorias):

1. Aprobación humana vigente.
2. Contenido válido: variantes elegibles y opciones coherentes (máximo 3).
3. Ningún producto equivalente en la tienda: se busca por un **handle determinista** `dsp-<proveedor>-<id externo>`.
4. `dryRun:false` con `confirm:true`.
5. Tienda habilitada y, en modo `live`, `SHOPIFY_WRITE_ENABLED=true`.

El estado `DRAFT` va fijo en el código y el adaptador no tiene ninguna operación para activar ni publicar productos.

**Idempotencia y errores parciales:**

- Hay una sola publicación por (producto, tienda), con reserva atómica.
- Si falla la asociación de variantes, el producto queda `FAILED` en la etapa `ADD_VARIANTS` con su ID, y el reintento **reanuda** esa etapa sin crear otro producto.
- Si la creación expira por timeout (resultado desconocido), el reintento busca por handle y **adopta** el borrador en lugar de duplicarlo.
- Las mutaciones solo se reintentan ante `THROTTLED` o 429, cuando Shopify garantiza que no se ejecutaron.

## Workflows de n8n

| Archivo                                                                          | Flujo                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [n8n/A-importacion.workflow.json](n8n/A-importacion.workflow.json)               | Manual o programación (desactivada) → proveedores habilitados → listado `shipsFrom=US` → lotes de IDs → `POST /products/import` con `Idempotency-Key` → resumen    |
| [n8n/B-evaluacion.workflow.json](n8n/B-evaluacion.workflow.json)                 | Manual o programación (desactivada) → candidatos `evaluation=PENDING` → `POST /products/evaluate` → resumen APPROVED / REVIEW_REQUIRED / REJECTED con hallazgos    |
| [n8n/C-shopify-borradores.workflow.json](n8n/C-shopify-borradores.workflow.json) | Manual → aprobados **por una persona** → dry-run (valida, busca equivalentes, prepara) → si `createDrafts=true` y la tienda lo permite, crea el borrador → resumen |
| [n8n/evaluar-productos.workflow.json](n8n/evaluar-productos.workflow.json)       | Fase 1, sin cambios                                                                                                                                                |

n8n solo **orquesta**: agrupa IDs en lotes, decide qué endpoint llamar y resume. Las reglas de negocio y la normalización viven en el backend. Las respuestas con error se registran en el resumen (`neverError`) en lugar de abortar el flujo.

**Puesta en marcha:**

1. Inicie el backend: `npm run db:up` y luego `npm run dev`. La URL desde n8n es `http://host.docker.internal:3000`; **no use `localhost`** dentro del contenedor.
2. Cree la credencial **Header Auth** `Dropship Backend - Admin (X-Api-Key)` con la `ADMIN_API_KEY` (ver [docs/credenciales.md](docs/credenciales.md#2-credencial-en-n8n-header-auth)).
3. En n8n, use **Workflows → Import from File…** con cada JSON y seleccione la credencial en los nodos HTTP.
4. Ejecute A, después B. Apruebe productos como persona revisora (ejemplo de PowerShell arriba) y ejecute C. C trabaja en modo revisión por defecto; para crear borradores, ponga `createDrafts=true` en su nodo **Configuración**.
5. La programación de A y B viene **desactivada**. Para automatizarla, active el nodo _Programación_ y el workflow.

### Ejecución real (2026-10-18)

Se ejecutó con el motor de n8n 2.43.7 en un contenedor **efímero y separado** (`docker run --rm`), usando `n8n import:credentials`, `n8n import:workflow` y `n8n execute`. El contenedor `n8n` existente no se modificó.

Backend: compilado, con PostgreSQL y tienda mock. Todas las llamadas llegaron con `Host: host.docker.internal:3000`.

| Ejecución                          | Nodos           | Resultado                                                                                                                                 |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A – Importación                    | 9/9 `success`   | 1 proveedor habilitado (CJ excluido por no estar configurado). 10 productos: `created: 10`, estado `COMPLETED`, 1 `INCOMPLETE` (MUS-1010) |
| B – Evaluación                     | 7/7 `success`   | `evaluated: 10` → **APPROVED 2**, **REVIEW_REQUIRED 4**, **REJECTED 4**, con motivos (ver abajo)                                          |
| Aprobación humana (PowerShell)     | —               | Clave admin → 403. REVIEW_REQUIRED sin notas → 422. MUS-1001 y MUS-1005 (con notas) → APPROVED                                            |
| C – Dry-run (`createDrafts=false`) | 9/9 `success`   | 2 preparados, 0 creados; las 3 verificaciones en OK                                                                                       |
| C – Crear (`createDrafts=true`)    | 10/10 `success` | 2 borradores `DRAFT` creados (HTTP 201) y publicaciones `COMPLETED`                                                                       |
| C – Repetición                     | 6/6 `success`   | No hay pendientes: **ningún duplicado**                                                                                                   |

Motivos reales del workflow B:

```text
APPROVED         MUS-1001 Soporte de laptop (29.99, margen 22.07 %) · MUS-1002 Lámpara LED (37.99, margen 21.64 %)
REVIEW_REQUIRED  MUS-1010 datos incompletos, cantidad y plazo desconocidos · MUS-1009 posible duplicado de MUS-1003
                 MUS-1006 precio recomendado 82.99 > techo 79.99 (margen 18.03 %) · MUS-1005 categoría regulada ("baby")
REJECTED         MUS-1008 entrega > 8 días · MUS-1007 margen < 12 % con precio techo
                 MUS-1004 categoría bloqueada ("knives") · MUS-1003 agotado en EE. UU. (la otra variante solo está en China)
```

Tras esa primera ronda, MUS-1002 seguía siendo APPROVED por el motor pero **no se había publicado** porque nadie lo aprobó. MUS-1005, que era REVIEW_REQUIRED, sí se publicó tras aprobarlo una persona con notas.

**Re-ejecución con el build final** (después de las últimas correcciones):

| Ejecución                                 | Resultado                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A – Importación                           | `unchanged: 10`, nueva sincronización `COMPLETED`; las versiones de producto siguen en 1 (idempotencia por contenido) |
| B – Evaluación                            | `evaluated: 0`: nada pendiente, no se crean evaluaciones ni se invalidan aprobaciones                                 |
| Aprobación humana de MUS-1002 + C – Crear | 10/10 nodos `success`; 1 borrador `DRAFT` creado (201)                                                                |

> **Hallazgo corregido en la re-ejecución.** La primera versión del workflow A construía la `Idempotency-Key` solo con `$execution.id`. El n8n efímero reinicia sus IDs, así que el backend devolvió la respuesta guardada (`reproducida: true`, mismo `syncRunId`) en lugar de importar. El backend se comportó correctamente, pero el workflow podía saltarse una importación real durante 24 h si n8n reutilizaba IDs. Ahora la clave incluye `runId` (ID de ejecución + marca de tiempo, calculado una vez en **Configuración**) y se verificó que importa de verdad.

## Seguridad y confiabilidad

- **Validación:** Zod valida todas las entradas, la configuración y las reglas; los errores se informan por campo.
- **Autenticación:**
  - Dos roles con claves separadas, comparadas en tiempo constante.
  - Los endpoints fallan cerrados si falta la clave.
  - La API escucha en `127.0.0.1`.
- **Servicios externos:**
  - Timeouts por llamada y reintentos con backoff exponencial y jitter.
  - Respeto de `Retry-After` y limitación de tasa (CJ 1 req/s, configurable).
  - Manejo de `THROTTLED` de Shopify y de los códigos de límite de CJ (`1600200`).
- **Idempotencia:** `Idempotency-Key` con respuesta guardada, unicidad en la base y reserva atómica de publicaciones.
- **Errores parciales explícitos:**
  - La importación devuelve un resultado por ítem (`created`, `updated`, `unchanged`, `not_found`, `failed`, `skipped`) y el estado `COMPLETED`, `PARTIAL` o `FAILED`.
  - Los borradores informan la etapa en la que fallaron y cómo reanudar.
- **Logs estructurados (pino) sin credenciales:**
  - Se redactan los headers sensibles.
  - Los adaptadores registran solo la ruta sin query.
  - Se verificó que ninguna clave ni contraseña aparece en los logs de la ejecución real.
- **Contenido no confiable:** el HTML de los proveedores se reduce a texto y se reconstruye escapado antes de enviarlo a Shopify.

## Pruebas y resultados

Resultado real del 2026-10-18, con `TEST_DATABASE_URL` apuntando al contenedor:

```
 Test Files  18 passed (18)
      Tests  217 passed (217)
Statements: 88.66 % · Branches: 80.5 % · Functions: 90.28 % · Lines: 89.73 %
npm run typecheck → OK · npm run lint → OK · npm run format:check → OK · npm run build → OK
```

| Suite                                                      | Qué cubre                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/phase2/unit/catalog-normalization`                  | Normalización, variantes repetidas, respuestas incompletas, moneda, imágenes, stock por país, huella de duplicados                                                                                                                                                                   |
| `tests/phase2/unit/profitability`                          | Desglose de costos, contribución vs beneficio, precio mínimo exacto con redondeos, x.99, reglas inviables                                                                                                                                                                            |
| `tests/phase2/unit/classification`                         | Sin bodega en EE. UU., agotados, entrega, margen con techo, envío estimado, categorías, duplicados, catálogo mock                                                                                                                                                                    |
| `tests/phase2/unit/approval-and-draft`                     | Aprobación humana (vigencia, REJECTED, notas), autorización independiente del motor, borrador DRAFT y saneamiento HTML                                                                                                                                                               |
| `tests/phase2/unit/rules-config`                           | Conversión y validación del archivo de reglas, hash                                                                                                                                                                                                                                  |
| `tests/phase2/adapters/*`                                  | Cliente HTTP (backoff, 429, timeouts, límite de tasa), CJ con fixtures de contrato (token, listado, detalle, stock, flete, 1600200, errores), Shopify con `fetch` simulado (DRAFT, variantes, userErrors, THROTTLED, 5xx sin reintento, escritura deshabilitada, client credentials) |
| `tests/phase2/use-cases/catalog-flow`                      | Importación idempotente y parcial, evaluación, aprobación, borradores: dry-run, confirmación, concurrencia, reanudación, adopción tras timeout, conflicto, cambios tras aprobar                                                                                                      |
| `tests/phase2/integration/catalog-api`                     | Endpoints HTTP: roles, 503 sin claves, Fase 1 intacta, paginación, filtros, idempotencia (replay y reuso), flujo completo                                                                                                                                                            |
| `tests/contract` + `persistence-memory` + `tests/postgres` | La **misma** suite de contrato contra memoria y contra **PostgreSQL real**: unicidad e importaciones concurrentes, duplicados, estados derivados, reserva concurrente de publicaciones (10 simultáneas), handle único por tienda, idempotencia                                       |
| Fase 1 (`tests/unit`, `tests/integration`)                 | 66 pruebas originales, todas en verde                                                                                                                                                                                                                                                |

> La suite completa se ejecutó **5 veces seguidas** contra PostgreSQL sin fallos. Antes, una de esas ejecuciones reveló una condición de carrera real en la reserva concurrente de publicaciones: una violación del índice `(store, handle)` se informaba como conflicto de handle. Se corrigió y quedó cubierta por la suite de contrato.
>
> Las fixtures de CJ (`tests/phase2/adapters/cj-contract-fixtures.ts`) están **construidas a partir de la documentación oficial**; no son respuestas reales capturadas. No se hicieron compras ni llamadas reales a CJ ni a Shopify.

## Integraciones que requieren cuentas externas

| Integración                                        | Requiere                                                                                                                                                     | Estado                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CJdropshipping API 2.0                             | Cuenta CJ y API key (gratuita; cuotas por nivel y puntos)                                                                                                    | Adaptador listo, probado con fixtures. **Falta probarlo con una cuenta real**                                                                               |
| Shopify Admin API                                  | Tienda Shopify (plan de pago o tienda de desarrollo) y app del Dev Dashboard con `read_products`/`write_products`, o un token de app personalizada existente | Adaptador listo, probado con `fetch` simulado. **Falta probarlo con una tienda real**                                                                       |
| Pasarela de pago de Shopify                        | Contrato con el procesador                                                                                                                                   | Fuera de alcance: solo se usan sus comisiones estimadas en las reglas                                                                                       |
| Spocket, Doba, Wholesale2B, Inventory Source, etc. | Acuerdos comerciales o planes de pago                                                                                                                        | **No implementados**: no se encontró API pública documentada verificable. Se pueden integrar con un nuevo `SupplierPort` cuando haya documentación y acceso |

## Limitaciones y pendientes

**Limitaciones actuales:**

- Las reglas por defecto son supuestos: ajuste comisiones, CAC, devoluciones y techo de precio con datos reales.
- Solo USD. No hay sales tax por estado ni conversión COP/USD.
- La tienda `mock` vive en memoria: tras reiniciar el backend, sus "productos" desaparecen, aunque las publicaciones registradas en PostgreSQL (`shopify:mock`) se mantienen.
- El adaptador CJ cotiza envío para un máximo de `CJ_MAX_QUOTED_VARIANTS` variantes por producto; las demás quedan "sin cotización" y requieren revisión.
- No se sincroniza el inventario con Shopify (las variantes se crean con `tracked: false`) ni se envían códigos de barras a Shopify.
- El listado de candidatos en n8n procesa una página (máximo 100 productos) por ejecución.
- No hay interfaz gráfica para revisar y aprobar: se usa la API con la clave de aprobador.

**Pendiente para una Fase 3:**

1. Probar CJ y Shopify con cuentas reales y ajustar los mapeadores a las respuestas observadas.
2. Paginación completa en los workflows A y B; cola de trabajos para importaciones grandes de CJ.
3. Sincronización periódica de inventario y precios con Shopify (y `inventoryItem.tracked`).
4. Recepción de pedidos de Shopify por webhooks y envío del pedido al proveedor, siempre con aprobación.
5. Pantalla de revisión y aprobación (o formulario de n8n) con usuarios individuales en lugar de una clave compartida.
6. Sales tax por estado, conversión COP/USD y reportes de rentabilidad real frente a la estimada.
7. Copias de seguridad de PostgreSQL, métricas, alertas (Error Trigger de n8n) y CI con Git.
