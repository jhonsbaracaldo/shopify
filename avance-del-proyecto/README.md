# Avance del proyecto: plataforma de dropshipping Colombia → EE. UU.

Carpeta con **todo lo que llevamos** a la fecha (2026-10-19). Empieza por el resumen.

| # | Documento | Contenido |
| --- | --- | --- |
| 1 | [01-resumen-del-proyecto.md](01-resumen-del-proyecto.md) | Qué se hizo en las Fases 1 y 2, qué está verificado, errores corregidos, decisiones, lo que falta y lo que necesito de ti |
| 2 | [02-guia-de-arranque.md](02-guia-de-arranque.md) | Cómo encender todo, usar los workflows, aprobar productos y apagar |
| 3 | [03-mapa-de-archivos.md](03-mapa-de-archivos.md) | Dónde está cada cosa dentro de `C:\shopify` |
| 4 | [evidencias/](evidencias/README.md) | Resultados reales: ejecuciones de n8n, respuestas de la API, estado de la base de datos y pruebas |
| 5 | `herramientas/` | Scripts usados para generar y verificar los workflows de n8n |

## Estado en una línea

- **Fase 1:** terminada y verificada.
- **Fase 2:** implementada y verificada con PostgreSQL real y n8n real, usando un proveedor y una tienda **simulados**.
- **Falta:** probar CJdropshipping y Shopify con cuentas reales (API key de CJ y tienda/app de Shopify).

## Documentación técnica relacionada

- [README principal](../README.md): arquitectura, API, reglas, seguridad y pruebas.
- [docs/credenciales.md](../docs/credenciales.md): cómo obtener y configurar cada credencial.
- [docs/fase-1.md](../docs/fase-1.md): documentación original de la Fase 1.
