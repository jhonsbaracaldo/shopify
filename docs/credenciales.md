# Guía de configuración de credenciales

Ninguna credencial se guarda en el repositorio, en la base de datos ni en los logs.

- **Dónde viven:** solo en `.env`, que está en `.gitignore`, y en el almacén de credenciales cifrado de n8n.
- **Tokens de proveedores y tienda:** CJ y Shopify se guardan **solo en memoria** del proceso.
- **Logs:** los adaptadores nunca registran headers ni cuerpos de las peticiones.

| Credencial                     | Variable                                                                      | Quién la usa                                                  | ¿Obligatoria?                |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| Clave de automatización        | `ADMIN_API_KEY`                                                               | n8n y scripts: importar, evaluar, preparar y crear borradores | Sí, para la Fase 2           |
| Clave de aprobador             | `APPROVER_API_KEY`                                                            | **Solo personas**: aprobar o rechazar productos               | Sí, para aprobar             |
| Contraseña de PostgreSQL local | `POSTGRES_PASSWORD`, `DATABASE_URL`                                           | Backend y Docker Compose                                      | No (sin ella se usa memoria) |
| API key de CJdropshipping      | `CJ_API_KEY`                                                                  | Adaptador CJ                                                  | Solo para usar CJ            |
| App de Shopify                 | `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`, o `SHOPIFY_ADMIN_ACCESS_TOKEN` | Adaptador Shopify (modo `live`)                               | Solo para Shopify real       |

---

## 1. Claves locales del backend (ADMIN y APPROVER)

Genere dos valores aleatorios **distintos** (32 o más caracteres):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Péguelos en `.env`:

```dotenv
ADMIN_API_KEY=<valor 1>
APPROVER_API_KEY=<valor 2>
```

- El backend se niega a arrancar si ambas son iguales.
- Sin una de ellas, los endpoints de ese rol responden `503 AUTH_NOT_CONFIGURED`: fallan cerrados.
- **Nunca** cargue `APPROVER_API_KEY` en n8n. Esa separación garantiza que una automatización no pueda aprobar productos.
- Para rotarlas, cambie el valor en `.env`, reinicie el backend y actualice la credencial de n8n.

## 2. Credencial en n8n (Header Auth)

Los workflows A, B y C usan una credencial de tipo **Header Auth** llamada `Dropship Backend - Admin (X-Api-Key)`.

1. En n8n (`http://localhost:5678`), vaya a **Credentials → Add credential → Header Auth**.
2. Complete los campos:
   - **Name** (nombre del header): `X-Api-Key`
   - **Value**: el valor de `ADMIN_API_KEY`
3. Guárdela con el nombre `Dropship Backend - Admin (X-Api-Key)`.
4. Al importar cada workflow, abra los nodos HTTP marcados con advertencia y seleccione esta credencial (n8n asigna IDs propios a las credenciales).

## 3. PostgreSQL local (Docker Compose)

`docker-compose.yml` crea un contenedor **propio** (`dropship-postgres`) que escucha solo en `127.0.0.1:5433`, porque en este equipo el 5432 ya lo usa otra instalación de PostgreSQL. No afecta al contenedor de n8n.

```dotenv
POSTGRES_PASSWORD=<contraseña aleatoria>
DATABASE_URL=postgres://dropship:<misma contraseña>@127.0.0.1:5433/dropship
TEST_DATABASE_URL=postgres://dropship:<misma contraseña>@127.0.0.1:5433/dropship_test
```

> La contraseña se fija al **crear** el volumen. Si la cambia después, debe cambiarla también dentro de PostgreSQL (`ALTER USER dropship PASSWORD '...'`) o recrear el volumen, lo que **borra los datos**.

## 4. CJdropshipping (requiere cuenta)

Documentación oficial: <https://developers.cjdropshipping.com/en/api/api2/>, verificada el 2026-10-18.

1. Cree o use una cuenta en cjdropshipping.com.
2. En la sección de API del panel de CJ (página "API Key"), pulse **Generate** para obtener la API key.
3. Configure `.env`:

   ```dotenv
   CJ_ENABLED=true
   CJ_API_KEY=<api key>
   CJ_MAX_REQUESTS_PER_SECOND=1   # 1 req/s es el límite documentado para cuentas gratuitas
   ```

4. Reinicie el backend y verifique con `GET /api/v1/suppliers` que `cj` aparece con `enabled: true, configured: true`.
5. Pruebe un listado pequeño: `GET /api/v1/suppliers/cj/products?shipsFrom=US&pageSize=5`.

**Cómo funciona el adaptador:**

- **Autenticación:** `POST /authentication/getAccessToken` con `{ apiKey }`. El token se envía en el header `CJ-Access-Token` y se renueva con el _refresh token_. Nunca se piden tokens más de una vez cada 5 minutos.
- **Endpoints usados:**
  - `GET /product/listV2`: listado con `countryCode=US`.
  - `GET /product/query`: detalle con variantes e inventario por país.
  - `GET /product/stock/queryByVid`: inventario de respaldo cuando el detalle no lo trae.
  - `POST /logistic/freightCalculate`: cotización de envío US→US.
- **Cuotas:** CJ aplica un límite por QPS y una **cuota diaria por puntos**. Cada producto importado consume varias llamadas: detalle, más inventario y cotización por variante (`CJ_MAX_QUOTED_VARIANTS` limita las cotizaciones).

**Pendiente de verificar con una cuenta real:**

- Los nombres exactos de algunos campos opcionales (p. ej. `productKeyEn`, `barcode`).
- La estructura de paginación de `listV2`. El adaptador tolera variaciones y marca como desconocido lo que falte.
- Si su nivel de cuenta permite cotizar envío desde bodegas de EE. UU.

## 5. Shopify Admin API (requiere tienda y app)

Versión configurada: **2026-10**, la estable vigente al 2026-10-18 según <https://shopify.dev/docs/api/usage/versioning>. Shopify publica una versión nueva cada trimestre y cada una tiene un año de soporte, así que revise `SHOPIFY_API_VERSION` periódicamente.

**Permisos (scopes) mínimos de la app:** `write_products` (incluye lectura) y `read_products`. No pida más permisos de los necesarios.

### Opción A — App del Dev Dashboard con _client credentials_ (recomendada para tiendas propias)

Desde el 1 de enero de 2026 no se pueden crear apps personalizadas "legacy" desde el admin de Shopify. Las apps nuevas se crean en el **Dev Dashboard**.

1. Cree una app en el Dev Dashboard de su organización Shopify y configure los scopes `read_products,write_products`.
2. Instálela en la tienda. La tienda debe pertenecer a la **misma organización**; si no, la API responde `shop_not_permitted`.
3. Copie el **Client ID** y el **Client secret** en `.env`:

   ```dotenv
   SHOPIFY_MODE=live
   SHOPIFY_STORE_DOMAIN=su-tienda.myshopify.com
   SHOPIFY_CLIENT_ID=<client id>
   SHOPIFY_CLIENT_SECRET=<client secret>
   SHOPIFY_WRITE_ENABLED=false   # primero solo lectura y dry-run
   ```

4. El backend intercambia el Client ID y el secret por un token en `POST https://{tienda}/admin/oauth/access_token` (`grant_type=client_credentials`). El token dura 24 h, se guarda en memoria y se renueva solo.

Referencia: <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant>

### Opción B — Token de Admin API de una app personalizada existente

Si ya tiene una app personalizada creada antes de 2026 con un token `shpat_...`:

```dotenv
SHOPIFY_MODE=live
SHOPIFY_STORE_DOMAIN=su-tienda.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
```

### Activación segura (orden recomendado)

1. `SHOPIFY_MODE=live` con `SHOPIFY_WRITE_ENABLED=false`. Ejecute el workflow C con `createDrafts=false`: solo consulta productos por handle y prepara el contenido.
2. Revise la carga útil del dry-run (`prepared.operations`).
3. Solo entonces ponga `SHOPIFY_WRITE_ENABLED=true` y, en el nodo **Configuración** del workflow C, `createDrafts=true`.
4. Los productos se crean **siempre** en estado `DRAFT`. Activarlos o publicarlos en canales de venta se hace manualmente en el admin de Shopify.

> **Cobros de Shopify:** este backend no contrata planes, apps ni servicios de pago. Revise usted las tarifas de su plan y su pasarela de pago, y ajuste `config/evaluation-rules.json` a sus valores reales.

## 6. Qué hacer si una credencial se filtra

1. Revóquela en el proveedor: regenere la API key en CJ o el secret de la app en el Dev Dashboard. Para las claves locales, genere valores nuevos.
2. Actualice `.env` y la credencial de n8n, y reinicie el backend.
3. Revise los logs de su proveedor y de Shopify por actividad no esperada.
