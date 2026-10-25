-- 0001: catálogo normalizado, sincronizaciones, evaluaciones, aprobaciones humanas,
-- publicaciones en tienda e idempotencia. No se almacenan credenciales ni tokens.

CREATE TABLE suppliers (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id           uuid PRIMARY KEY,
  supplier_id  text NOT NULL REFERENCES suppliers (id),
  trigger      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  stats        jsonb,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE products (
  id                 uuid PRIMARY KEY,
  supplier_id        text NOT NULL REFERENCES suppliers (id),
  external_id        text NOT NULL,
  sku                text,
  name               text NOT NULL,
  description        text,
  category           text,
  images             jsonb NOT NULL DEFAULT '[]'::jsonb,
  currency           char(3) NOT NULL,
  validation_status  text NOT NULL CHECK (validation_status IN ('VALID', 'INCOMPLETE', 'INVALID')),
  validation_issues  jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash       text NOT NULL,
  dedupe_key         text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  first_seen_at      timestamptz NOT NULL,
  last_synced_at     timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  -- Evita duplicados por proveedor + producto.
  CONSTRAINT products_supplier_external_uq UNIQUE (supplier_id, external_id)
);
CREATE INDEX products_dedupe_key_idx ON products (dedupe_key);
CREATE INDEX products_last_synced_idx ON products (last_synced_at DESC, id);

CREATE TABLE product_variants (
  id                      uuid PRIMARY KEY,
  product_id              uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  position                integer NOT NULL,
  external_id             text NOT NULL,
  sku                     text,
  name                    text,
  options                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  barcode                 text,
  cost_cents              integer CHECK (cost_cents >= 0),
  suggested_retail_cents  integer CHECK (suggested_retail_cents >= 0),
  weight_grams            integer CHECK (weight_grams > 0),
  image_url               text,
  inventory               jsonb,   -- NULL = desconocido
  shipping_quotes         jsonb,   -- NULL = sin cotización
  -- Evita duplicados por producto + variante.
  CONSTRAINT product_variants_product_external_uq UNIQUE (product_id, external_id)
);
CREATE INDEX product_variants_barcode_idx ON product_variants (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX product_variants_sku_idx ON product_variants (sku) WHERE sku IS NOT NULL;

CREATE TABLE product_sync_history (
  id             bigserial PRIMARY KEY,
  product_id     uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sync_run_id    uuid REFERENCES sync_runs (id),
  change_type    text NOT NULL CHECK (change_type IN ('created', 'updated', 'unchanged')),
  previous_hash  text,
  new_hash       text NOT NULL,
  synced_at      timestamptz NOT NULL
);
CREATE INDEX product_sync_history_product_idx ON product_sync_history (product_id, id DESC);

CREATE TABLE evaluations (
  seq                   bigserial UNIQUE,
  id                    uuid PRIMARY KEY,
  product_id            uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  product_content_hash  text NOT NULL,
  rules_version         text NOT NULL,
  rules_hash            text NOT NULL,
  classification        text NOT NULL CHECK (classification IN ('APPROVED', 'REVIEW_REQUIRED', 'REJECTED')),
  result                jsonb NOT NULL,
  created_at            timestamptz NOT NULL
);
CREATE INDEX evaluations_product_idx ON evaluations (product_id, seq DESC);

-- Decisiones HUMANAS, separadas de la clasificación automática.
CREATE TABLE approvals (
  seq                   bigserial UNIQUE,
  id                    uuid PRIMARY KEY,
  product_id            uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  evaluation_id         uuid NOT NULL REFERENCES evaluations (id),
  decision              text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reviewer              text NOT NULL,
  notes                 text,
  product_content_hash  text NOT NULL,
  rules_hash            text NOT NULL,
  created_at            timestamptz NOT NULL
);
CREATE INDEX approvals_product_idx ON approvals (product_id, seq DESC);

CREATE TABLE store_publications (
  id                   uuid PRIMARY KEY,
  product_id           uuid NOT NULL REFERENCES products (id),
  store                text NOT NULL,
  status               text NOT NULL CHECK (status IN ('IN_PROGRESS', 'PRODUCT_CREATED', 'COMPLETED', 'FAILED', 'CONFLICT')),
  handle               text NOT NULL,
  external_product_id  text,
  approval_id          uuid NOT NULL REFERENCES approvals (id),
  evaluation_id        uuid NOT NULL REFERENCES evaluations (id),
  draft_hash           text NOT NULL,
  attempts             integer NOT NULL DEFAULT 1,
  stage                text CHECK (stage IN ('CREATE_PRODUCT', 'ADD_VARIANTS', 'DONE')),
  last_error           text,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  -- Una sola publicación por producto y tienda; un handle no puede reutilizarse.
  CONSTRAINT store_publications_product_store_uq UNIQUE (product_id, store),
  CONSTRAINT store_publications_store_handle_uq UNIQUE (store, handle)
);

CREATE TABLE idempotency_keys (
  scope            text NOT NULL,
  key              text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
