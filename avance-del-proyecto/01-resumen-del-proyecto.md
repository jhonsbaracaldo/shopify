# Resumen del proyecto: todo lo que llevamos

_Actualizado: 2026-10-19._

## Objetivo del negocio

Vender a clientes de **Estados Unidos**, desde **Colombia**, productos de proveedores que despachan desde **bodegas en EE. UU.** (dropshipping). La plataforma automatiza este proceso de punta a punta:

1. Descubrir productos.
2. Evaluar costos y márgenes.
3. Seleccionar los rentables.
4. Prepararlos para Shopify.

Siempre con control humano antes de publicar.

**Tecnologías:** Node.js + TypeScript (Fastify), n8n Community en Docker, PostgreSQL, Vitest y Shopify (Admin GraphQL API).

---

## Estado en una mirada

| Fase | Estado | Resumen |
| --- | --- | --- |
| **Fase 1**: MVP de evaluación | ✅ Terminada y verificada | API con 3 endpoints, cálculo de márgenes brutos, 5 productos simulados, workflow n8n funcionando |
| **Fase 2**: proveedores, catálogo, Shopify | 🟡 Implementada y verificada con simulaciones; **falta probar con cuentas reales** | Catálogo normalizado, motor de rentabilidad, clasificación, aprobación humana, PostgreSQL, CJ y Shopify preparados, workflows A/B/C |
| **Fase 3** | ⏳ Por definir | Ver "Próximos pasos" al final |

---

## Fase 1 (2026-10-18)

**Qué se construyó**

- Backend Fastify en `127.0.0.1:3000` con:
  - `GET /health`
  - `GET /api/v1/products`: 5 productos ficticios.
  - `POST /api/v1/products/evaluate`: costo total, ganancia y margen **brutos**, precio mínimo y elegibilidad.
- Dinero en **centavos enteros**: sin errores de redondeo.
- Workflow n8n `evaluar-productos`: consulta, evalúa y resume elegibles y descartados.

**Verificado**

- 66/66 pruebas.
- n8n (Docker) llega al backend en Windows por `host.docker.internal:3000`; `localhost` no funciona dentro del contenedor.
- El workflow se ejecutó de verdad: 2 productos elegibles y 3 descartados.

**Corregido durante la verificación**

- Una petición `text/plain` respondía 400 en lugar de 415.

La documentación original completa está en [`docs/fase-1.md`](../docs/fase-1.md).

---

## Fase 2 (2026-10-18)

### Qué se construyó

| Pieza | Qué hace |
| --- | --- |
| **Catálogo normalizado** | Modelo común para cualquier proveedor: variantes, imágenes, costo, envío, **inventario por bodega con su país**, plazo de entrega, fecha de sincronización y estado de validación. Evita duplicados por proveedor, producto y variante. |
| **Motor de rentabilidad** | Producto + envío + comisión de pago + otros costos + reserva de devoluciones + costo de adquisición de cliente (CAC). Calcula el precio recomendado (x.99), el margen de contribución y el beneficio estimado. Los valores se configuran en `config/evaluation-rules.json`, sin tocar código. |
| **Clasificación** | APPROVED, REVIEW_REQUIRED o REJECTED, según margen, disponibilidad, bodega en EE. UU., plazo de entrega, datos incompletos, categorías restringidas y posibles duplicados. |
| **Aprobación humana** | Separada del motor. Solo una persona con la **clave de aprobador** puede aprobar; n8n no tiene esa clave. Si el producto o las reglas cambian, la aprobación deja de valer. |
| **PostgreSQL** | Productos, variantes, evaluaciones, aprobaciones, historial de sincronización, publicaciones e idempotencia. Migraciones versionadas. |
| **Proveedor CJdropshipping** | Adaptador real según la documentación oficial de la API 2.0: token, listado, detalle, inventario, cotización de envío y límite de 1 petición por segundo. |
| **Proveedor mock** | 10 productos ficticios que cubren todos los casos (aprobado, agotado, solo en China, categoría bloqueada, margen bajo, entrega lenta, duplicado, incompleto). |
| **Shopify** | Adaptador Admin GraphQL **2026-10** que **solo crea borradores**. También hay una tienda simulada en memoria (`SHOPIFY_MODE=mock`). |
| **API protegida** | Dos claves (automatización y aprobador), `Idempotency-Key`, paginación, filtros y errores uniformes. Los endpoints de la Fase 1 siguen funcionando igual. |
| **Workflows n8n** | **A** importación, **B** evaluación, **C** preparación y creación de borradores (modo revisión por defecto). |

### Qué está verificado y cómo

| Componente | Verificación |
| --- | --- |
| Catálogo, motor, clasificación, aprobación, idempotencia | **Real**, con PostgreSQL 17 |
| Workflows A, B y C | **Real**: ejecutados con el motor de n8n 2.43.7 |
| API y seguridad (claves, 401/403/409/422) | **Real**, con llamadas HTTP al backend |
| Adaptador CJdropshipping | Solo con datos de prueba armados desde la documentación. **Falta la API key** |
| Adaptador Shopify | Solo con respuestas simuladas. **Falta una tienda y una app** |
| Otros proveedores (Spocket, Doba…) | No implementados: no se encontró API pública documentada verificable |

**Resultado del flujo completo con el proveedor mock**

- **Workflow A:** importó 10 productos.
- **Workflow B:** 2 APPROVED, 4 REVIEW_REQUIRED y 4 REJECTED.
- **Aprobación humana:** una persona aprobó MUS-1001 y MUS-1005, este último con notas.
- **Workflow C:** creó 2 borradores. Al repetirlo, no duplicó nada.
- MUS-1002 era APPROVED por el motor, pero **no se publicó** hasta que una persona lo aprobó.

Pruebas automatizadas: **217/217** con PostgreSQL real, en 5 corridas seguidas sin fallos.

### Errores encontrados y corregidos al probar de verdad

| # | Problema | Efecto | Corrección |
| --- | --- | --- | --- |
| 1 | Al rechazar CJ el token, el adaptador descartaba también el de renovación | No podía recuperarse durante 5 minutos | Solo se invalida el token de acceso y se renueva |
| 2 | Dos pedidos simultáneos de borrador para el mismo producto | Uno recibía un error equivocado ("handle en uso"); no había duplicados | Se distingue la reserva concurrente del conflicto real; prueba con 10 pedidos simultáneos |
| 3 | La respuesta de creación informaba 1 variante en vez de 2 | Dato incorrecto en el resumen | Se relee el producto al terminar |
| 4 | La clave de idempotencia del workflow A dependía del número de ejecución de n8n | Si n8n reinicia la numeración, una importación real se saltaba durante 24 h | La clave incluye un `runId` único por ejecución; verificado |

### Decisiones tomadas y por qué

- **PostgreSQL en un contenedor propio**, en el puerto **5433**. Las aprobaciones, el historial y la idempotencia deben sobrevivir a reinicios, y el puerto 5432 ya lo usa un PostgreSQL nativo de Windows.
- **No se modificó el contenedor `n8n`.** Para probar los workflows se usó un contenedor temporal aparte.
- **APPROVED del motor ≠ autorización para publicar.** Publicar exige aprobación humana más tres condiciones adicionales: `SHOPIFY_WRITE_ENABLED=true`, confirmación explícita (`confirm: true`) y que no exista ya un producto equivalente.
- **Siempre borradores (DRAFT).** Activar o publicar en Shopify queda como acción manual.
- **El país de despacho se toma de la bodega**, no del país del proveedor.
- **Los datos que el proveedor no informa quedan como "desconocido"** y el producto pasa a revisión; no se inventan valores.

---

## Lo que necesito de ti para cerrar la Fase 2

1. **Revisar los costos** de `config/evaluation-rules.json`. Son supuestos míos:
   - comisión de pago 2,9 % + 0,30 USD;
   - CAC 6 USD;
   - devoluciones 3 %;
   - precio máximo 79,99 USD;
   - margen objetivo 20 % y mínimo 12 %.
2. **API key de CJdropshipping**, para probar el adaptador real.
3. **Tienda y app de Shopify** (Dev Dashboard, permisos `read_products` y `write_products`), para probar los borradores reales. Primero en modo lectura y después con escritura.
4. **Importar los workflows en tu n8n** y crear la credencial *Header Auth*. No lo verifiqué en la interfaz gráfica.

El paso a paso de cada credencial está en [`docs/credenciales.md`](../docs/credenciales.md).

## Próximos pasos (Fase 3, propuesta)

1. Probar CJ y Shopify con cuentas reales y ajustar los mapeadores a las respuestas reales.
2. Paginación completa en los workflows y una cola para importaciones grandes de CJ.
3. Sincronizar inventario y precios con Shopify.
4. Recibir pedidos de Shopify y enviarlos al proveedor, siempre con aprobación.
5. Pantalla o formulario para revisar y aprobar, con usuarios individuales.
6. Sales tax por estado, conversión COP/USD y reportes de rentabilidad real frente a la estimada.
7. Copias de seguridad, alertas y control de versiones con Git.

---

## Datos del entorno (este PC)

| Elemento | Valor |
| --- | --- |
| Carpeta del proyecto | `C:\shopify` |
| Backend | `http://127.0.0.1:3000` (desde n8n: `http://host.docker.internal:3000`) |
| n8n | contenedor `n8n`, `http://localhost:5678`, versión 2.43.7 |
| PostgreSQL del proyecto | contenedor `dropship-postgres`, `127.0.0.1:5433`, bases `dropship` y `dropship_test` |
| PostgreSQL nativo de Windows | puerto 5432; **no es del proyecto, no se toca** |
| Secretos | `C:\shopify\.env` (claves y contraseña local). **No lo compartas ni lo subas a Git.** |
| Versiones | Node 22.15 · npm 11.3 · Docker 29.8 · PostgreSQL 17 · Shopify API 2026-10 |
