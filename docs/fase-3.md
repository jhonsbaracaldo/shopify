# Fase 3 — implementación inicial, pendiente de validación ejecutable

Fecha de inspección: 2026-10-19. Este informe reemplaza cualquier interpretación de los resultados históricos del README como evidencia de este equipo.

## Auditoría antes de programar

Se inspeccionaron `src`, `tests`, `migrations`, configuración y composición HTTP. Fase 1 tiene evaluación sin estado y pruebas. Fase 2 tiene puertos para proveedores, adaptador CJ de catálogo/stock/cotización, cliente HTTP con límites y reintentos, persistencia en memoria/PostgreSQL, migrador con checksums, aprobación humana y creación de borradores Shopify. Hay suites unitarias, HTTP, contratos de persistencia y fixtures de proveedores. Existía una migración, `0001_initial_catalog.sql`.

No existían pedidos, webhooks, cola persistente de pedidos, estados de cumplimiento, sincronización operativa con Shopify ni adaptadores de compra/tracking. Las variantes de los borradores anteriores se crean sin seguimiento de inventario. Los resultados históricos de PostgreSQL/n8n del README no se reprodujeron aquí.

Plan aplicado: (1) modelo, firma, cifrado y migración; (2) recepción/cola y estados; (3) observaciones de stock y propuestas; (4) preparación y simulación de seguimiento; (5) workflows y pruebas. La integración real requiere una siguiente etapa de implementación y validación. Esta entrega **no completa el flujo comercial real solicitado**.

## Arquitectura y operación

`POST /webhooks/shopify/orders` usa parser Buffer encapsulado, HMAC SHA-256 del cuerpo original y comparación constante. Valida tienda configurada, identificador de entrega y topic. Admite `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`. Guarda el JSON cifrado antes de devolver 200; una falla PostgreSQL impide confirmar recepción. La validación de negocio ocurre después para evitar perder eventos firmados inválidos: llegan a revisión técnica/dead letter.

La clave de deduplicación es tienda+delivery ID. Event ID se conserva para correlación y la unicidad tienda+order ID evita crear dos pedidos para distintas entregas del mismo pedido. Un worker interno procesa un evento por segundo independientemente de n8n. `FOR UPDATE SKIP LOCKED`, transacción y savepoint permiten concurrencia, rollback tras caída y cinco intentos con retraso exponencial; el quinto fallo genera dead letter y alerta. Nunca se guardan mensajes externos de error ni payloads en logs. Eventos completados eliminan su cuerpo cifrado.

Las direcciones se guardan con AES-256-GCM y clave externa de 32 bytes. Las consultas administrativas no devuelven dirección ni cuerpos de webhooks. Respaldar la clave separada de la base. Pendiente: rotación de claves, eliminación programada de direcciones/dead letters, cifrado de discos/backups y política de retención antes de producción.

Estados y transiciones están en `src/commerce/model.ts`; toda transición implementada registra auditoría. Un pedido pendiente de pago nunca se prepara. Pagos parciales/autorizados no equivalen a `paid`. Cambios de cancelación/reembolso posteriores a PAID producen una alerta y requieren reconciliación humana: todavía no resuelven automáticamente pedidos en curso. `supplier_payment=NOT_AUTHORIZED` nunca cambia: cobrar al cliente no autoriza pagar al proveedor.

Sincronización: mapeo explícito de IDs Shopify a proveedor; consultas a puertos existentes de detalle, inventario y métodos de envío; observaciones con fecha; cantidad desconocida o fallo => cero; propuestas deduplicadas por costos+reglas. Exclusión mutua PostgreSQL y máximo una sincronización cada 60 segundos; clientes CJ conservan su limitador/reintentos. Máximo 500 mapeos por corrida: falta cursor para catálogos mayores. Los snapshots no son una garantía de inventario remoto en tiempo real.

Preparación: consume solo PAID, exige mapeos coherentes, stock observado hace menos de dos minutos y costos conocidos; agrega cantidades por variante. Reserva localmente la observación y crea un registro SIMULATION único por pedido. **No es una reserva en el proveedor. La siguiente sincronización reemplaza las cantidades observadas; falta un libro de reservas persistentes separado antes de habilitar compras reales.** Se debe revalidar al autorizar cada compra real.

Precios: reutiliza el motor configurable de Fase 2 y `config/evaluation-rules.json`; registra costos y precio recomendado sin escribir precios públicos. Los márgenes del motor son estimados; la contribución allí se presenta antes de CAC, y el beneficio estimado después de CAC no es utilidad neta. `/economics` devuelve ingresos de mercancía y costos observados estimados, no un estado financiero: faltan descuentos, impuestos, reembolsos, fletes reales y libro contable inmutable. No interpretar sus resultados como margen realizado.

## Instalación y configuración manual

1. Instalar Node >=20, npm y Docker Desktop. Ejecutar `npm ci`, `npm run db:up`, configurar `.env` y ejecutar `npm run db:migrate`.
2. Definir `DATABASE_URL`, claves distintas `ADMIN_API_KEY` y `APPROVER_API_KEY`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_WEBHOOK_SECRET` y `COMMERCE_ENCRYPTION_KEY` (64 hex aleatorios). La configuración falla cerrada si se habilita comercio sin ellos. Generación: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Definir `COMMERCE_ENABLED=true`. Arrancar con `npm run dev`. Sin PostgreSQL este módulo no se habilita, aunque Fase 2 admite memoria.
4. Configurar app/tienda Shopify de desarrollo, acceso a pedidos y aprobación de datos de clientes protegidos cuando corresponda. Usar el secreto de la app para webhooks; no confundir con el token Admin API. Registrar los cuatro topics anteriores con callback HTTPS `/webhooks/shopify/orders`. Implementar proxy HTTPS con autenticación administrativa, límites compartidos y reglas de acceso. Mantener n8n privado. Probar con pedidos de prueba, nunca cobros reales.
5. Registrar cada variante en `PUT /api/v1/commerce/mappings`, header `X-Api-Key` admin, cuerpo `{ "variantId":"123", "productId":"456", "supplierId":"mock-us", "supplierProductId":"MUS-1001", "supplierVariantId":"ID-REAL-DEL-CATALOGO" }`. Confirmar IDs consultando el catálogo; el ejemplo no garantiza que esos IDs existan. Los mapeos son inmutables con este endpoint; comprobar la base antes de usar. Falta API auditada de corrección.
6. Para CJ: configurar credenciales Fase 2, revisar cuota/almacén US y validar catálogo/stock/cotizaciones en cuenta autorizada. No hay llamadas nuevas de compra CJ, ni endpoints inventados. La documentación de pedidos no pudo verificarse durante esta ejecución; su integración está pendiente.
7. Importar workflows D–H en n8n. Seleccionar credencial Header Auth con `X-Api-Key` admin en cada nodo Backend. No incluir la clave approver en n8n. Todos son manuales e inactivos; la programación se configura manualmente después de probarlos. H consulta alertas; falta canal de entrega (correo/Slack/etc.).
8. Ejecutar inventario antes de pedidos; usar `/api/v1/commerce/orders`, `/prices`, `/shipments`, `/economics`, `/alerts` para inspección administrativa (máximo 100 registros).
9. Simular estados con clave approver en `POST /api/v1/commerce/orders/:id/simulate`, `{ "state":"FULFILLMENT_REQUESTED", "confirm":true }`, luego SUPPLIER_CONFIRMED, SHIPPED (requiere carrier y tracking), DELIVERED. Estas operaciones solo escriben simulación local; no envían PII, compras, pagos ni notificaciones Shopify.

## Estado verificable y pendientes

Implementado en código: recepción HMAC, cifrado, inbox persistente/reintentos/dead letter, transiciones/auditoría, observaciones y propuestas de precio, preparación simulada, consultas administrativas, alertas deduplicadas, detección de pedidos detenidos a las 48 horas, barreras de configuración. Límite HTTP de 600/minuto por instancia del módulo; falta limitación distribuida y por identidad para producción.

Simulado: cumplimiento y seguimiento mediante endpoint humano. No existe consulta de estados logísticos del proveedor, normalización de su respuesta, ni mutación real de fulfillment Shopify. No existe actualización de inventario público ni lectura del estado publicado. Por tanto **todavía no se evita que Shopify venda sin stock confirmado**: mantener productos sin publicar hasta implementar y verificar inventario rastreado, política DENY y sincronización Shopify. No activar tiendas reales con esta fase como única protección.

Pendiente: adaptadores de compra y tracking documentados, aprobación vinculada a importe/destino/hash con vencimiento, reservas durables, conciliación de eventos fuera de orden/ediciones de pedidos, reconciliación periódica con Shopify, recuperación de resultados ambiguos antes de reintentar mutaciones, fulfillment orders y ubicaciones, exclusión de envíos parciales duplicados, política de aprobación de precios y actualización real, costos históricos por pedido, margen bajo objetivo sobre precio público, paginación, canal externo de alertas, pruebas PostgreSQL/reinicio/concurrencia/red/inventario/tracking y ejecución n8n. No existe endpoint que autorice compras/pagos reales.

## Validación de esta entrega

Se añadieron pruebas unitarias de firma, bytes alterados, cifrado autenticado, transiciones y validación de entrada, y prueba HTTP con persistencia mock para firma/tienda/deduplicación. **No ejecutadas**: Node/npm y Docker no están en PATH ni en ubicaciones estándar comprobadas. La descarga de Node falló inicialmente por conexión; no hay evidencia de compilación, lint o tests exitosos. Los cinco JSON se analizaron con PowerShell y se comprobó su conexión Manual → Backend; no se importaron ni ejecutaron en n8n. La migración 0002 no se aplicó a una base real.

También se añadió una suite PostgreSQL opcional para deduplicación de entregas/pedidos, pago pendiente, stock desconocido y reintentos de payload inválido; tampoco fue ejecutada. Requiere una base de pruebas aislada: sus workers consumen todos los eventos de esa base.

Comandos pendientes: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run test:postgres` con base exclusiva de pruebas, e importación/ejecución D–H en n8n contra mocks. No se hicieron transacciones reales ni llamadas comerciales con PII.

Fuentes oficiales consultadas: [firma, entrega rápida y duplicados Shopify](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [fulfillmentCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentCreate). La segunda referencia describe la operación futura, no evidencia una integración implementada.
