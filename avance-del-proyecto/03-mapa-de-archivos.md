# Mapa de archivos: dónde está cada cosa en `C:\shopify`

```
C:\shopify
├── avance-del-proyecto\        ← ESTA CARPETA: resumen, guía, evidencias y herramientas
├── README.md                   Documentación técnica completa (Fase 2)
├── docs\
│   ├── fase-1.md               Documentación original de la Fase 1
│   └── credenciales.md         Cómo obtener y configurar cada clave (CJ, Shopify, n8n, locales)
├── .env                        SECRETOS locales (claves, contraseña de la base). No compartir.
├── .env.example                Plantilla comentada de todas las variables
├── config\
│   └── evaluation-rules.json   Reglas de negocio editables: márgenes, comisiones, CAC, categorías…
├── n8n\                        Workflows para importar en n8n
│   ├── A-importacion.workflow.json
│   ├── B-evaluacion.workflow.json
│   ├── C-shopify-borradores.workflow.json
│   └── evaluar-productos.workflow.json   (Fase 1)
├── migrations\
│   └── 0001_initial_catalog.sql          Estructura de la base de datos
├── docker-compose.yml          Contenedor PostgreSQL del proyecto (puerto 5433)
├── docker\postgres\init\       Crea la base de pruebas dropship_test
├── src\                        Código del backend
│   ├── domain\                 Reglas de negocio puras
│   │   ├── catalog.ts            catálogo normalizado y validación
│   │   ├── profitability.ts      costos, márgenes y precio recomendado
│   │   ├── classification.ts     APPROVED / REVIEW_REQUIRED / REJECTED
│   │   ├── approval.ts           reglas de la aprobación humana
│   │   ├── store-draft.ts        borrador para la tienda (siempre DRAFT)
│   │   └── money.ts, pricing.ts, evaluation.ts, product.ts   (Fase 1)
│   ├── application\            Casos de uso y contratos (puertos)
│   ├── adapters\               Conexiones externas
│   │   ├── suppliers\cj\         CJdropshipping (real, falta API key)
│   │   ├── suppliers\mock-us-supplier.ts   proveedor ficticio
│   │   ├── store\shopify\        Shopify (real, falta tienda y app)
│   │   ├── store\mock-store.ts   tienda simulada
│   │   └── persistence\          PostgreSQL y memoria
│   ├── http\                   API: rutas, seguridad, idempotencia, errores
│   ├── config\                 Variables de entorno y carga de reglas
│   ├── composition.ts          Une todas las piezas según la configuración
│   └── server.ts               Punto de entrada
├── tests\                      217 pruebas automatizadas
│   ├── unit\, integration\       Fase 1
│   ├── phase2\                   Fase 2: unitarias, adaptadores, casos de uso, HTTP
│   ├── contract\                 Misma suite para memoria y PostgreSQL
│   └── postgres\                 Ejecuta el contrato contra PostgreSQL real
├── package.json                Comandos npm (dev, build, test, db:up, db:migrate…)
└── dist\, node_modules\, coverage\   Generados; se pueden borrar y regenerar
```

## Contenido de esta carpeta

| Archivo | Para qué |
| --- | --- |
| `README.md` | Índice de la carpeta |
| `01-resumen-del-proyecto.md` | Todo lo hecho, el estado, las decisiones, lo que falta y lo que necesito de ti |
| `02-guia-de-arranque.md` | Cómo encender, usar y apagar todo, paso a paso |
| `03-mapa-de-archivos.md` | Este archivo |
| `evidencias\` | Salidas reales de las ejecuciones (n8n, API, base de datos, pruebas) |
| `herramientas\generar-workflows-n8n.mjs` | Script que genera los JSON de los workflows A, B y C. Uso: `node avance-del-proyecto\herramientas\generar-workflows-n8n.mjs n8n` |
| `herramientas\ejecutar-workflows-en-n8n-efimero.sh` | Script que se usó **dentro** de un contenedor n8n temporal para importar y ejecutar los workflows sin tocar el n8n original |
| `herramientas\extraer-resultado-n8n.cjs` | Extrae el estado de cada nodo y la salida final de una ejecución de n8n por consola |
