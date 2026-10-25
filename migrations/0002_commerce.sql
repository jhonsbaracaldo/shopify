CREATE TABLE commerce_events (
  shop text NOT NULL, delivery_id text NOT NULL, event_id text NOT NULL, topic text NOT NULL,
  payload_encrypted text NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(), last_error text,
  PRIMARY KEY(shop, delivery_id)
);
CREATE INDEX commerce_queue ON commerce_events(available_at) WHERE status='PENDING';
CREATE TABLE commerce_orders (
  shop text NOT NULL, id text NOT NULL, state text NOT NULL DEFAULT 'RECEIVED'
    CHECK(state IN ('RECEIVED','PAYMENT_PENDING','PAID','STOCK_VALIDATION','READY_FOR_FULFILLMENT','FULFILLMENT_REQUESTED','SUPPLIER_CONFIRMED','SHIPPED','DELIVERED','CANCELLED','FAILED','MANUAL_REVIEW')),
  customer_payment text NOT NULL, supplier_payment text NOT NULL DEFAULT 'NOT_AUTHORIZED',
  address_encrypted text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(shop,id)
);
CREATE TABLE commerce_lines (
  shop text NOT NULL, order_id text NOT NULL, id text NOT NULL, product_id text NOT NULL,
  variant_id text NOT NULL, quantity integer NOT NULL CHECK(quantity>0), price_cents bigint NOT NULL CHECK(price_cents>=0),
  PRIMARY KEY(shop,order_id,id), FOREIGN KEY(shop,order_id) REFERENCES commerce_orders(shop,id)
);
CREATE TABLE commerce_mappings (
  shop text NOT NULL, variant_id text NOT NULL, product_id text NOT NULL,
  supplier_id text NOT NULL, supplier_product_id text NOT NULL, supplier_variant_id text NOT NULL,
  PRIMARY KEY(shop,variant_id)
);
CREATE TABLE commerce_snapshots (
  shop text NOT NULL, variant_id text NOT NULL, quantity integer NOT NULL,
  cost_cents bigint, shipping_cents bigint, observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(shop,variant_id), FOREIGN KEY(shop,variant_id) REFERENCES commerce_mappings(shop,variant_id)
);
CREATE TABLE commerce_price_proposals (
  id bigserial PRIMARY KEY, shop text NOT NULL, variant_id text NOT NULL, fingerprint text NOT NULL UNIQUE,
  cost_cents bigint NOT NULL, shipping_cents bigint NOT NULL, recommended_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commerce_audit (
  id bigserial PRIMARY KEY, shop text NOT NULL, order_id text, action text NOT NULL,
  actor text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commerce_alerts (
  dedupe_key text PRIMARY KEY, kind text NOT NULL, reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE commerce_syncs (
  id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING', result jsonb
);
CREATE TABLE commerce_fulfillments (
  shop text NOT NULL, order_id text NOT NULL, mode text NOT NULL CHECK(mode='SIMULATION'),
  supplier_reference text, carrier text, tracking text, status text NOT NULL DEFAULT 'PREPARED',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(shop,order_id),
  FOREIGN KEY(shop,order_id) REFERENCES commerce_orders(shop,id)
);
