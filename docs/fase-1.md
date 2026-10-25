# Fase 1 — Documentación original (referencia histórica)

> Este documento conserva la documentación de la Fase 1 tal como se entregó. La documentación vigente está en el [README](../README.md). Los endpoints de la Fase 1 siguen funcionando sin cambios.

MVP backend (Node.js + TypeScript + Fastify) para evaluar la rentabilidad preliminar de productos de dropshipping vendidos desde Colombia a clientes de EE. UU., con proveedores que despachan desde bodegas estadounidenses. Se integra con **n8n** (Docker) mediante una API REST local.

> **Fase 1:** solo datos simulados. No hay integración con Shopify, pasarelas de pago ni proveedores reales.

---

## Contenido

1. [Requisitos](#requisitos)
2. [Instalación](#instalación)
3. [Comandos npm](#comandos-npm)
4. [Variables de entorno](#variables-de-entorno)
5. [Ejecutar el backend](#ejecutar-el-backend)
6. [Arquitectura y estructura](#arquitectura-y-estructura)
7. [Reglas de negocio](#reglas-de-negocio)
8. [API REST](#api-rest)
9. [Integración con n8n](#integración-con-n8n)
10. [Probar la comunicación Docker ↔ Windows](#probar-la-comunicación-docker--windows)
11. [Pruebas](#pruebas)
12. [Limitaciones actuales](#limitaciones-actuales)
13. [Próximos pasos (Fase 2)](#próximos-pasos-fase-2)

---

## Requisitos

| Herramienta              | Versión                  | Notas                                      |
| ------------------------ | ------------------------ | ------------------------------------------ |
| Node.js                  | ≥ 20 (probado con 22.15) | `node --version`                           |
| npm                      | ≥ 10 (probado con 11.3)  |                                            |
| Docker Desktop (Windows) | probado con 29.8         | Solo para n8n                              |
| n8n Community Edition    | probado con 2.43.7       | Ya en ejecución en `http://localhost:5678` |

No se necesitan claves API, bases de datos ni servicios de pago.

## Instalación

```powershell
cd C:\shopify
npm install
copy .env.example .env   # opcional: sin .env se usan los valores por defecto
```

## Comandos npm

| Comando                                   | Descripción                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                             | Inicia el servidor en modo desarrollo con recarga automática (`tsx watch`).           |
| `npm run build`                           | Compila TypeScript a `dist/`.                                                         |
| `npm start`                               | Ejecuta la versión compilada (`node dist/server.js`). Requiere `npm run build` antes. |
| `npm test`                                | Ejecuta todas las pruebas (unitarias + integración) con Vitest.                       |
| `npm run test:watch`                      | Pruebas en modo observación.                                                          |
| `npm run test:coverage`                   | Pruebas con informe de cobertura (`coverage/`).                                       |
| `npm run typecheck`                       | Verificación de tipos sin compilar.                                                   |
| `npm run lint` / `npm run lint:fix`       | ESLint (reglas con información de tipos).                                             |
| `npm run format` / `npm run format:check` | Prettier.                                                                             |

## Variables de entorno

Se leen de `.env` (vía `dotenv`) y se validan con Zod al arrancar. Si alguna es inválida, el proceso termina con un mensaje que indica cuál y por qué.

| Variable                          | Por defecto   | Descripción                                                                            |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | `development` | `development`, `test` o `production`.                                                  |
| `HOST`                            | `127.0.0.1`   | Interfaz de escucha. `127.0.0.1` evita exponer la API a la red local (ver nota abajo). |
| `PORT`                            | `3000`        | Puerto HTTP. Si se cambia, actualizar `baseUrl` en el workflow de n8n.                 |
| `LOG_LEVEL`                       | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                          |
| `DEFAULT_TARGET_MARGIN_PERCENT`   | `30`          | Margen bruto objetivo (0–99.99, máx. 2 decimales).                                     |
| `DEFAULT_MAX_DELIVERY_DAYS`       | `7`           | Plazo máximo de entrega aceptado (días).                                               |
| `DEFAULT_REQUIRED_ORIGIN_COUNTRY` | `US`          | País exigido de la bodega (ISO alfa-2). Vacío o `NONE` desactiva la regla.             |

**Nota sobre `HOST`:** con Docker Desktop, las conexiones a `host.docker.internal` llegan al Windows anfitrión a través del propio Docker Desktop, por lo que n8n puede alcanzar un servidor que escucha solo en `127.0.0.1`. Esto se verificó en este equipo (ver [ejemplo real](#ejemplo-real-de-comunicación-n8n--backend)). Si en otra configuración (p. ej. Docker Engine dentro de WSL sin Docker Desktop) no funciona, use `HOST=0.0.0.0` **y** asegúrese de que el Firewall de Windows no permita ese puerto desde redes públicas.

## Ejecutar el backend

El workflow de n8n **no** arranca el backend: hay que iniciarlo antes en una terminal de Windows y dejarla abierta.

```powershell
cd C:\shopify
npm run dev
```

Salida esperada (logs JSON de Fastify):

```
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3000"}
{"level":30,...,"msg":"Desde n8n (Docker) use: http://host.docker.internal:3000 — no use localhost dentro del contenedor"}
```

Comprobación rápida desde Windows:

```powershell
curl.exe http://localhost:3000/health
```

Para producción local: `npm run build` y luego `npm start`.

## Arquitectura y estructura

Separación ligera por capas (inspirada en arquitectura limpia, sin sobreingeniería):

```
src/
├── domain/                    # Reglas de negocio puras (sin dependencias de frameworks)
│   ├── money.ts               # Centavos enteros, puntos básicos, conversiones seguras
│   ├── product.ts             # Modelo de producto e invariantes
│   ├── pricing.ts             # Costo total, ganancia/margen bruto, precio mínimo
│   ├── evaluation.ts          # Evaluación y elegibilidad preliminar
│   └── errors.ts              # Errores de dominio
├── application/
│   ├── ports/supplier-catalog.ts       # Interfaz para proveedores (mock hoy, reales mañana)
│   └── use-cases/                      # ListProducts, EvaluateProduct
├── adapters/
│   └── suppliers/mock-supplier-catalog.ts   # 5 productos ficticios
├── http/
│   ├── app.ts                 # Composition root (buildApp)
│   ├── errors.ts              # Formato único de errores
│   ├── routes/                # /health, /api/v1/products...
│   ├── schemas/               # Validación de entrada con Zod
│   └── presenters/            # USD decimal ⇄ centavos del dominio
├── config/env.ts              # Validación de variables de entorno
└── server.ts                  # Punto de entrada
tests/
├── unit/                      # money, pricing, evaluation, env, mock
└── integration/api.test.ts    # Endpoints con fastify.inject
n8n/
└── evaluar-productos.workflow.json
```

Para reemplazar el mock por un proveedor real basta con implementar `SupplierCatalog` (`listProducts(): Promise<Product[]>`) e inyectarlo en `src/server.ts`.

## Reglas de negocio

**Dinero:** todos los importes se procesan internamente como **centavos enteros** de USD y los porcentajes como **puntos básicos** enteros (30 % = 3000 pb). La API recibe y devuelve USD con máximo 2 decimales; se rechazan valores con más decimales en lugar de redondearlos en silencio.

| Concepto                  | Fórmula                                            | Redondeo                                               |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Costo total               | costo del producto + costo de envío                | exacto                                                 |
| Ganancia bruta            | precio de venta − costo total (puede ser negativa) | exacto                                                 |
| Margen bruto %            | ganancia bruta / precio de venta × 100             | 2 decimales                                            |
| Precio mínimo recomendado | costo total / (1 − margen objetivo)                | **hacia arriba** al centavo, para garantizar el margen |
| Ganancia neta (opcional)  | ganancia bruta − costos adicionales proporcionados | al centavo                                             |

**Ganancia bruta vs. neta.** La ganancia y el margen **brutos** solo descuentan el costo del producto y del envío. **No** incluyen publicidad, comisiones de Shopify o pasarela, impuestos, devoluciones ni contracargos. La ganancia **neta** solo se calcula si se envían `additionalCosts` en la solicitud, y es una estimación limitada a esos costos; en caso contrario `net` es `null`.

**Elegibilidad preliminar** — el producto es elegible si pasa todas las reglas:

| Regla                 | Condición                                                               |
| --------------------- | ----------------------------------------------------------------------- |
| `MIN_GROSS_MARGIN`    | margen bruto ≥ margen objetivo (comparación exacta, sin redondeo)       |
| `AVAILABILITY`        | estado ≠ `out_of_stock` y cantidad > 0 (`low_stock` genera advertencia) |
| `DELIVERY_TIME`       | días máximos de entrega ≤ `maxDeliveryDays`                             |
| `WAREHOUSE_ORIGIN`    | país de la bodega = `requiredOriginCountry` (omitible con `null`)       |
| `POSITIVE_NET_PROFIT` | solo si hay `additionalCosts`: ganancia neta > 0                        |

**Validaciones:** campos obligatorios vacíos, importes negativos o con más de 2 decimales, precio de venta 0 (evita división por cero), margen objetivo ≥ 100 % (división por cero), moneda distinta de USD, rango de entrega invertido y parámetros desconocidos.

## API REST

Todas las respuestas son JSON. Los errores siempre tienen el formato:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "details": [{ "path": "campo", "message": "..." }]
  }
}
```

| Código HTTP | `code`                    | Cuándo                                                     |
| ----------- | ------------------------- | ---------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`        | Cuerpo ausente o datos inválidos (con `details` por campo) |
| 400         | `BAD_REQUEST`             | JSON mal formado, cuerpo demasiado grande                  |
| 404         | `NOT_FOUND`               | Ruta inexistente                                           |
| 415         | `UNSUPPORTED_MEDIA_TYPE`  | `Content-Type` distinto de `application/json`              |
| 422         | `DOMAIN_VALIDATION_ERROR` | Violación de reglas de dominio no detectada antes          |
| 500         | `INTERNAL_ERROR`          | Error inesperado (sin detalles internos)                   |

### `GET /health`

```powershell
curl.exe http://localhost:3000/health
```

```json
{
  "status": "ok",
  "service": "dropshipping-automation-backend",
  "version": "0.1.0",
  "catalogSource": "mock",
  "uptimeSeconds": 74,
  "timestamp": "2026-10-19T01:16:33.868Z"
}
```

### `GET /api/v1/products`

```powershell
curl.exe http://localhost:3000/api/v1/products
```

Respuesta real (recortada al primer producto de 5):

```json
{
  "data": [
    {
      "sku": "DEMO-AUTO-001",
      "name": "Soporte magnético de celular para auto",
      "description": "Soporte con imán N52 para rejilla de ventilación, rotación 360°, compatible con MagSafe.",
      "category": "Accesorios para auto",
      "supplier": {
        "id": "demo-sup-nj",
        "name": "Demo Supplier New Jersey",
        "warehouseCountry": "US"
      },
      "productCost": 4.2,
      "shippingCost": 3.95,
      "suggestedPrice": 19.99,
      "currency": "USD",
      "estimatedDeliveryDays": { "min": 3, "max": 5 },
      "availability": { "status": "in_stock", "quantity": 850 }
    }
  ],
  "meta": { "count": 5, "source": "mock", "currency": "USD" }
}
```

`availability.status` admite `in_stock`, `low_stock` y `out_of_stock`.

### `POST /api/v1/products/evaluate`

Cuerpo:

| Campo                              | Tipo           | Obligatorio | Descripción                                                                       |
| ---------------------------------- | -------------- | ----------- | --------------------------------------------------------------------------------- |
| `product`                          | objeto         | sí          | Mismo formato que devuelve `GET /api/v1/products`                                 |
| `parameters.targetMarginPercent`   | número         | no          | 0–99.99. Por defecto `DEFAULT_TARGET_MARGIN_PERCENT`                              |
| `parameters.salePrice`             | número         | no          | Precio a evaluar; por defecto `product.suggestedPrice`                            |
| `parameters.maxDeliveryDays`       | entero         | no          | 1–90                                                                              |
| `parameters.requiredOriginCountry` | string \| null | no          | ISO alfa-2; `null` desactiva la regla                                             |
| `parameters.additionalCosts`       | arreglo        | no          | `{ name, type: "fixed", amount }` o `{ name, type: "percent_of_price", percent }` |

**Ejemplo 1: producto descartado por margen** (parámetros por defecto). Desde PowerShell:

```powershell
$products = (Invoke-RestMethod http://localhost:3000/api/v1/products).data
$body = @{ product = $products[2]; parameters = @{ targetMarginPercent = 30 } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/products/evaluate `
  -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 10
```

Respuesta real:

```json
{
  "data": {
    "sku": "DEMO-HOME-003",
    "name": "Tira LED RGB de 5 m con control por app",
    "currency": "USD",
    "pricing": {
      "salePrice": 22.99,
      "priceSource": "suggested",
      "productCost": 11.5,
      "shippingCost": 6.25,
      "totalCost": 17.75
    },
    "gross": { "profit": 5.24, "marginPercent": 22.79 },
    "net": null,
    "targetMarginPercent": 30,
    "minimumRecommendedPrice": 25.36,
    "eligible": false,
    "recommendation": "Descartar por ahora: no cumple MIN_GROSS_MARGIN",
    "checks": [
      {
        "rule": "MIN_GROSS_MARGIN",
        "passed": false,
        "detail": "Margen bruto 22.79 % < objetivo 30.00 %"
      },
      {
        "rule": "AVAILABILITY",
        "passed": true,
        "detail": "Disponible (1200 unidades, estado in_stock)"
      },
      {
        "rule": "DELIVERY_TIME",
        "passed": true,
        "detail": "Entrega estimada 3-6 días; máximo permitido 7"
      },
      { "rule": "WAREHOUSE_ORIGIN", "passed": true, "detail": "Bodega en US; se exige US" }
    ],
    "warnings": ["Para alcanzar el margen objetivo el precio debería ser al menos 25.36 USD"],
    "notes": [
      "La ganancia y el margen brutos solo descuentan costo del producto y envío.",
      "Ganancia neta no calculada: no se proporcionaron costos de publicidad, comisiones de Shopify o pasarela, impuestos ni devoluciones."
    ]
  }
}
```

**Ejemplo 2: precio propio y costos adicionales para estimar la ganancia neta.** Los valores de comisión y publicidad son supuestos del usuario, no tarifas reales de Shopify ni de ninguna pasarela:

```json
{
  "product": { "...": "DEMO-AUTO-001 tal como lo devuelve GET /api/v1/products" },
  "parameters": {
    "targetMarginPercent": 35,
    "salePrice": 21.99,
    "additionalCosts": [
      { "name": "Comisión pasarela (estimada)", "type": "percent_of_price", "percent": 2.9 },
      { "name": "Comisión fija pasarela", "type": "fixed", "amount": 0.3 },
      { "name": "Publicidad por unidad (CPA estimado)", "type": "fixed", "amount": 6 }
    ]
  }
}
```

Respuesta real (extracto):

```json
{
  "data": {
    "pricing": { "salePrice": 21.99, "priceSource": "override", "totalCost": 8.15 },
    "gross": { "profit": 13.84, "marginPercent": 62.94 },
    "net": {
      "additionalCosts": 6.94,
      "breakdown": [
        { "name": "Comisión pasarela (estimada)", "amount": 0.64 },
        { "name": "Comisión fija pasarela", "amount": 0.3 },
        { "name": "Publicidad por unidad (CPA estimado)", "amount": 6 }
      ],
      "profit": 6.9,
      "marginPercent": 31.38
    },
    "minimumRecommendedPrice": 12.54,
    "eligible": true
  }
}
```

**Ejemplo 3: error de validación** (`HTTP 400`):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "La solicitud no es válida",
    "details": [
      {
        "path": "product.name",
        "message": "Entrada inválida: se esperaba texto, recibido indefinido"
      },
      { "path": "product.productCost", "message": "no puede ser negativo" },
      { "path": "parameters.targetMarginPercent", "message": "no puede ser mayor que 99.99" }
    ]
  }
}
```

`minimumRecommendedPrice` siempre se calcula con el margen **bruto** objetivo; no incluye los costos adicionales.

## Integración con n8n

### Por qué `host.docker.internal` y no `localhost`

n8n se ejecuta **dentro** de un contenedor Docker. Dentro del contenedor, `localhost` es el propio contenedor, no Windows. Docker Desktop expone el equipo anfitrión con el nombre `host.docker.internal`, por eso el workflow usa:

```
http://host.docker.internal:3000
```

El puerto `3000` es el `PORT` del backend. El contenedor n8n existente **no necesita** cambios (no hace falta publicar puertos adicionales ni recrearlo: la conexión sale del contenedor hacia Windows).

### Importar el workflow

1. Iniciar el backend (`npm run dev`) y dejar la terminal abierta.
2. Abrir `http://localhost:5678`.
3. **Workflows → Create workflow** → menú `⋯` (arriba a la derecha) → **Import from File…**
4. Seleccionar `C:\shopify\n8n\evaluar-productos.workflow.json`.
5. Revisar el nodo **Configuración** (`baseUrl`, `targetMarginPercent`, `maxDeliveryDays`) y guardar.
6. Pulsar **Execute workflow**.

### Qué hace el workflow

```
Ejecutar manualmente → Configuración → Obtener productos (GET)
  → Separar productos (Split Out sobre "data")
  → Evaluar producto (POST, una vez por producto)
  → Resumen elegibles y descartados (Code)
```

El nodo **Evaluar producto** se ejecuta automáticamente una vez por cada item, así que recorre todos los productos sin necesidad de un bucle explícito. El último nodo devuelve un único item con `cumplenMargenMinimo`, `noCumplenMargenMinimo`, `elegibles`, `descartados` y los motivos de descarte.

> `cumplenMargenMinimo` y `elegibles` no son lo mismo: un producto puede cumplir el margen y aun así descartarse por inventario, plazo de entrega u origen.

Si se cambia el puerto del backend o se usa otro margen, basta con editar el nodo **Configuración**.

### Ejemplo real de comunicación n8n ↔ backend

Verificado el 2026-10-18 en este equipo (Windows 11, Docker Desktop 29.8, n8n 2.43.7):

1. Backend compilado en ejecución en Windows (`npm start`, escuchando en `127.0.0.1:3000`).
2. Desde el contenedor `n8n`: `host.docker.internal:3000/health` → `200`; `localhost:3000/health` → `ECONNREFUSED`, como se esperaba.
3. El workflow se importó y ejecutó con el motor de n8n por CLI (`n8n import:workflow` + `n8n execute`) en un **contenedor efímero y separado** (`docker run --rm`) de la misma imagen, para no alterar el contenedor ni los datos existentes. Los 6 nodos terminaron en `success` (1 → 1 → 1 → 5 → 5 → 1 items).

Logs del backend durante la ejecución (las 6 peticiones llegaron con `Host: host.docker.internal:3000`):

```
GET  /api/v1/products           -> 200
POST /api/v1/products/evaluate  -> 200   (x5)
```

Salida del nodo **Resumen elegibles y descartados** (recortada):

```json
{
  "backend": "http://host.docker.internal:3000",
  "margenObjetivoPct": 30,
  "totalEvaluados": 5,
  "cumplenMargenMinimo": ["DEMO-AUTO-001", "DEMO-HLTH-002", "DEMO-KTCH-004", "DEMO-KTCH-005"],
  "noCumplenMargenMinimo": ["DEMO-HOME-003"],
  "totalElegibles": 2,
  "totalDescartados": 3,
  "elegibles": [
    {
      "sku": "DEMO-AUTO-001",
      "margenBrutoPct": 59.23,
      "precioMinimoRecomendado": 11.65,
      "advertencias": []
    },
    {
      "sku": "DEMO-HLTH-002",
      "margenBrutoPct": 38.78,
      "precioMinimoRecomendado": 21.86,
      "advertencias": ["Inventario bajo en el proveedor: verificar antes de publicar"]
    }
  ],
  "descartados": [
    {
      "sku": "DEMO-HOME-003",
      "motivosDescarte": ["MIN_GROSS_MARGIN: Margen bruto 22.79 % < objetivo 30.00 %"]
    },
    {
      "sku": "DEMO-KTCH-004",
      "motivosDescarte": ["AVAILABILITY: Sin inventario disponible en el proveedor"]
    },
    {
      "sku": "DEMO-KTCH-005",
      "motivosDescarte": ["DELIVERY_TIME: Entrega estimada 6-10 días; máximo permitido 7"]
    }
  ],
  "nota": "Márgenes BRUTOS: no incluyen publicidad, comisiones de Shopify/pasarela, impuestos ni devoluciones."
}
```

## Probar la comunicación Docker ↔ Windows

Con el backend en marcha, desde PowerShell:

```powershell
# 1. Desde Windows
curl.exe http://localhost:3000/health

# 2. Desde DENTRO del contenedor n8n (solo lectura: no modifica el contenedor)
docker exec n8n node -e "fetch('http://host.docker.internal:3000/health').then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1)})"
```

Problemas comunes:

| Síntoma                                     | Causa probable                                                          | Solución                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED` en n8n                       | El backend no está en ejecución o usa otro puerto                       | `npm run dev`; revisar `PORT` y `baseUrl`                                                           |
| `ECONNREFUSED` usando `localhost` en n8n    | `localhost` apunta al contenedor                                        | Usar `host.docker.internal`                                                                         |
| `ENOTFOUND host.docker.internal`            | Docker sin Docker Desktop (p. ej. Engine en WSL)                        | Añadir `--add-host=host.docker.internal:host-gateway` al crear el contenedor, o usar la IP del host |
| Funciona desde Windows pero no desde Docker | El backend escucha solo en `127.0.0.1` y la red de Docker no lo reenvía | `HOST=0.0.0.0` restringiendo el puerto en el Firewall de Windows                                    |

## Pruebas

```powershell
npm test
```

Último resultado (Vitest 5.0.5):

```
 Test Files  6 passed (6)
      Tests  66 passed (66)
```

| Archivo                                    | Qué cubre                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/money.test.ts`                 | Conversión USD ↔ centavos, precisión (0.1 + 0.2, 4.35), decimales, negativos, NaN/Infinity                                                    |
| `tests/unit/pricing.test.ts`               | Costo total, ganancia y margen bruto, precio mínimo (redondeo hacia arriba), margen 0 %, 99.99 % y 100 %, división por cero, límite exacto    |
| `tests/unit/evaluation.test.ts`            | Productos rentables y no rentables, pérdida, inventario, plazo, origen, varios motivos, ganancia neta, datos inválidos                        |
| `tests/unit/env.test.ts`                   | Valores por defecto, conversión de tipos, errores de configuración                                                                            |
| `tests/unit/mock-supplier-catalog.test.ts` | 5 productos válidos, inmutabilidad, resultado esperado 2/3                                                                                    |
| `tests/integration/api.test.ts`            | Los 3 endpoints con `fastify.inject`: 200, 400 (validación, JSON mal formado, cuerpo vacío), 404, 415, 500, y el flujo GET → POST que usa n8n |

Cobertura (`npm run test:coverage`): 93.2 % de sentencias, 87.97 % de ramas y 100 % de funciones.

## Limitaciones actuales

- Catálogo **ficticio** de 5 productos (proveedores "Demo Supplier …", SKU `DEMO-*`); no representan precios de mercado reales.
- Solo se calculan ganancia y margen **brutos**; la ganancia neta depende de los costos adicionales que se envíen manualmente.
- Sin base de datos: no hay historial de evaluaciones.
- Sin autenticación: la API está pensada para uso local (`127.0.0.1`). No exponerla a Internet.
- Solo USD; sin conversión COP/USD ni cálculo de impuestos de EE. UU. (sales tax).
- Los tiempos de entrega son los declarados por el proveedor, sin verificación.
- Sin integración con Shopify ni con proveedores reales.

## Próximos pasos (Fase 2)

**Proveedores reales (bodegas en EE. UU.)**

- Elegir uno o dos proveedores con API documentada y bodegas en EE. UU., y crear un adaptador que implemente `SupplierCatalog`.
- Mapear sus datos (costo, envío a la dirección del cliente, plazo, inventario) al modelo `Product`, con pruebas de contrato.
- Manejar timeouts, reintentos, límites de peticiones (rate limits) y caché.
- Guardar las credenciales en variables de entorno o en las credenciales de n8n, nunca en el código.

**Persistencia e historial**

- Base de datos (p. ej. PostgreSQL o SQLite) para el catálogo, las evaluaciones y los cambios de precio y stock.
- Endpoints de consulta: historial y productos aprobados.

**Rentabilidad neta**

- Perfiles de costos configurables: comisión de la pasarela de Shopify, apps, CPA de publicidad, reserva para devoluciones y contracargos.
- Sales tax de EE. UU. por estado y conversión COP/USD para la contabilidad local.
- Opción de elegibilidad basada en el margen neto.

**Shopify**

- App personalizada con Admin API (GraphQL): crear productos en borrador con el precio recomendado.
- Sincronización periódica de inventario y precios con un workflow de n8n programado (Schedule Trigger).
- Webhooks de pedidos (`orders/create`) para enviar el pedido al proveedor y hacer seguimiento del envío (tracking).

**Operación y seguridad**

- Autenticación sencilla entre n8n y el backend (API key en un header) antes de exponer cualquier endpoint fuera del equipo.
- Validación de esquemas de respuesta, OpenAPI/Swagger y métricas.
- Dockerfile del backend y `docker-compose` opcional junto a n8n (sin tocar el contenedor actual hasta decidirlo).
- Flujo de error en n8n (Error Trigger) y notificaciones.
- CI (lint + typecheck + tests) al versionar con Git.
