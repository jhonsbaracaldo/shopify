# Guía de arranque: cómo poner todo en marcha

Todos los comandos son para **PowerShell**, desde `C:\shopify`.

## 1. Encender los servicios (cada vez que reinicies el PC)

1. Abre **Docker Desktop** y espera a que diga *Engine running*. El contenedor `n8n` debería arrancar solo.
2. Inicia la base de datos del proyecto:

   ```powershell
   cd C:\shopify
   npm run db:up
   ```

3. Inicia el backend y **deja esta ventana abierta**:

   ```powershell
   npm run dev
   ```

4. Comprueba que todo responde:

   ```powershell
   curl.exe http://localhost:3000/health
   ```

   Debe mostrar `"status":"ok"`, `"persistence":{"kind":"postgres","ok":true}` y `"store":{"mode":"mock"…}`.

## 2. Configurar n8n (solo la primera vez)

1. Abre `http://localhost:5678`.
2. Crea la credencial: **Credentials → Add credential → Header Auth**.
   - **Name:** `X-Api-Key`
   - **Value:** el valor de `ADMIN_API_KEY` que está en `C:\shopify\.env`
   - **Nombre de la credencial:** `Dropship Backend - Admin (X-Api-Key)`
3. Importa los workflows con **Workflows → Import from File…**:
   - `C:\shopify\n8n\A-importacion.workflow.json`
   - `C:\shopify\n8n\B-evaluacion.workflow.json`
   - `C:\shopify\n8n\C-shopify-borradores.workflow.json`
4. En cada workflow, abre los nodos HTTP marcados con advertencia, selecciona la credencial y guarda.

> **Nunca** pongas la `APPROVER_API_KEY` en n8n: es solo para que una persona apruebe.

## 3. Ciclo de trabajo

| Paso | Dónde | Qué pasa |
| --- | --- | --- |
| 1. Importar | n8n → workflow **A** → *Execute workflow* | Trae los productos del proveedor (hoy: el mock) y los guarda normalizados |
| 2. Evaluar | n8n → workflow **B** | Calcula costos y márgenes y clasifica en APPROVED / REVIEW_REQUIRED / REJECTED |
| 3. Revisar | Salida del último nodo de B | Lista de productos con precio propuesto, margen y motivos |
| 4. Aprobar (persona) | PowerShell (abajo) | Registra tu decisión con la clave de aprobador |
| 5. Preparar | n8n → workflow **C** (por defecto `createDrafts=false`) | Valida y muestra el borrador que se crearía, sin escribir nada |
| 6. Crear borradores | En C, nodo **Configuración** → `createDrafts=true` → ejecutar | Crea borradores `DRAFT` (hoy en la tienda simulada) |

### Aprobar un producto desde PowerShell

```powershell
cd C:\shopify
$approver = (Select-String -Path .env -Pattern '^APPROVER_API_KEY=(.*)$').Matches.Groups[1].Value
$h = @{ 'X-Api-Key' = $approver }

# Ver los candidatos (APPROVED y REVIEW_REQUIRED del motor)
$c = (Invoke-RestMethod 'http://localhost:3000/api/v1/products/candidates?pageSize=100' -Headers $h).data
$c | Select-Object externalId, name, classification, approvalState

# Aprobar uno (cambia MUS-1002 por el que quieras)
$p = $c | Where-Object externalId -eq 'MUS-1002'
$body = @{ evaluationId = $p.latestEvaluation.id; reviewer = 'Tu nombre' } | ConvertTo-Json
Invoke-RestMethod -Method Post "http://localhost:3000/api/v1/products/$($p.id)/approve" -Headers $h -ContentType 'application/json' -Body $body
```

Para un producto **REVIEW_REQUIRED**, agrega `notes = 'qué revisaste y por qué apruebas'` (mínimo 15 caracteres). Los productos REJECTED no se pueden aprobar.

## 4. Apagar

1. En la ventana del backend, pulsa `Ctrl + C`.
2. Si quieres detener la base de datos: `npm run db:down`. Los datos se conservan.

## 5. Problemas comunes

| Síntoma | Solución |
| --- | --- |
| `failed to connect to the docker API` | Docker Desktop está cerrado: ábrelo y espera |
| n8n muestra `ECONNREFUSED` | El backend no está corriendo: `npm run dev` |
| n8n usa `localhost` y falla | Dentro de n8n siempre `http://host.docker.internal:3000` |
| `401 UNAUTHORIZED` en n8n | La credencial Header Auth no está asignada o la clave no coincide con `.env` |
| `503 AUTH_NOT_CONFIGURED` | Faltan `ADMIN_API_KEY` o `APPROVER_API_KEY` en `.env` |
| `409 APPROVAL_REQUIRED` en C | Falta la aprobación humana (paso 4) |
| El backend no arranca por la base de datos | `npm run db:up` y revisa que `DATABASE_URL` en `.env` use el puerto 5433 |

## 6. Verificar que todo sigue bien (opcional)

```powershell
npm run typecheck; npm run lint; npm test
# Pruebas contra PostgreSQL real (con Docker encendido):
$env:TEST_DATABASE_URL = (Select-String -Path .env -Pattern '^TEST_DATABASE_URL=(.*)$').Matches.Groups[1].Value
npm test
```
