# Evidencias

Salidas **reales** capturadas durante la verificación de las fases 1 y 2. Se guardan sin modificar: Prettier no las reformatea. Antes de copiarlas se comprobó que ninguna contiene claves ni contraseñas.

En los archivos `n8n-*.json` cada uno es la salida del **último nodo** del workflow. Los workflows se ejecutaron con el motor de n8n 2.43.7 en un contenedor efímero aparte (`docker run --rm`), contra el backend corriendo en Windows con PostgreSQL y la tienda *mock*. El contenedor `n8n` original no se tocó.

## Fase 1 (2026-10-18)

| Archivo | Qué muestra |
| --- | --- |
| `fase1/n8n-resumen-evaluacion-fase1.json` | Workflow de la Fase 1: 5 productos simulados, 2 elegibles y 3 descartados, con el motivo de cada uno |

## Fase 2 (2026-10-18)

| Archivo | Qué muestra |
| --- | --- |
| `fase2/01-n8n-A-importacion.json` | Workflow A: 10 productos importados (`created: 10`); MUS-1010 queda `INCOMPLETE` |
| `fase2/02-n8n-B-evaluacion.json` | Workflow B: 2 APPROVED, 4 REVIEW_REQUIRED y 4 REJECTED, con los hallazgos de cada producto |
| `fase2/03-n8n-C-dry-run.json` | Workflow C en modo revisión: 2 productos aprobados por una persona, preparados y sin crear nada |
| `fase2/04-n8n-C-crear-borradores.json` | Workflow C con `createDrafts=true`: 2 borradores `DRAFT` creados (HTTP 201) |
| `fase2/05-n8n-C-repeticion-sin-duplicados.json` | Workflow C repetido: no hay pendientes, así que no se crea ningún duplicado |
| `fase2/06-n8n-A-reejecucion-respuesta-reproducida.json` | **Hallazgo:** la clave de idempotencia se repitió (`reproducida: true`, mismo `syncRunId`), por lo que la importación no se ejecutó |
| `fase2/07-n8n-B-reejecucion-sin-pendientes.json` | Workflow B repetido: 0 evaluaciones; no invalida aprobaciones |
| `fase2/08-n8n-C-reejecucion-crea-MUS-1002.json` | Tras aprobar MUS-1002, C crea su borrador |
| `fase2/09-n8n-A-clave-corregida.json` | Workflow A corregido: importación real con `unchanged: 10` y una sincronización nueva |
| `fase2/10-api-detalle-producto-MUS-1001.json` | Respuesta real de `GET /api/v1/products/:id`: evaluación, desglose de costos, aprobación y publicación |
| `fase2/11-estado-base-de-datos-2026-10-18.txt` | Contenido de PostgreSQL: lo decidido por el motor frente a lo decidido por la persona |
| `verificacion-2026-10-19.txt` | Typecheck, lint, formato, build y pruebas ejecutados hoy, con sus códigos de salida |

## Pruebas automatizadas

| Fecha | Resultado |
| --- | --- |
| 2026-10-18, Fase 1 | 66/66 |
| 2026-10-18, Fase 2 con PostgreSQL real | 217/217, en 5 corridas seguidas sin fallos; cobertura del 88,66 % de sentencias |
| 2026-10-19, sin Docker | 202 pasadas y 1 omitida (la suite de PostgreSQL, porque Docker Desktop estaba apagado) |
