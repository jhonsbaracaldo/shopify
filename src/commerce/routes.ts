import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthGuard } from '../http/auth.js';
import type { CommerceService } from './service.js';
import { validHmac } from './model.js';
import { assertTransition, states } from './model.js';

export interface CommerceOptions {
  service: CommerceService;
  auth: AuthGuard;
  shop: string;
  secret: string;
}
export async function commerceRoutes(
  app: FastifyInstance,
  options: CommerceOptions,
): Promise<void> {
  const { service, auth, shop, secret } = options;
  // Bounded, per-instance ingress budget. A reverse proxy must enforce the shared production limit.
  let windowStart = Date.now();
  let requests = 0;
  app.addHook('onRequest', async (_req, reply) => {
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 600)
      return reply.header('Retry-After', '60').code(429).send({ error: 'RATE_LIMITED' });
  });
  // Encapsulated parser: retain the exact signed bytes only on the webhook route.
  await app.register((webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    webhook.post('/webhooks/shopify/orders', async (req, reply) => {
      const header = (name: string) => {
        const value = req.headers[name];
        return typeof value === 'string' ? value : '';
      };
      if (
        header('x-shopify-shop-domain') !== shop ||
        !Buffer.isBuffer(req.body) ||
        !validHmac(req.body, header('x-shopify-hmac-sha256'), secret)
      )
        return reply.code(401).send({ error: 'INVALID_WEBHOOK' });
      const delivery = header('x-shopify-webhook-id');
      const event = header('x-shopify-event-id') || delivery;
      const topic = header('x-shopify-topic');
      if (
        !/^[a-zA-Z0-9-]{1,100}$/.test(delivery) ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(event) ||
        !['orders/create', 'orders/paid', 'orders/cancelled', 'orders/updated'].includes(topic)
      )
        return reply.code(400).send({ error: 'INVALID_METADATA' });
      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString('utf8')) as unknown;
      } catch {
        return reply.code(400).send({ error: 'INVALID_JSON' });
      }
      const created = await service.receive(shop, delivery, event, topic, payload);
      return reply.code(200).send({ accepted: true, duplicate: !created });
    });
    return Promise.resolve();
  });

  type Row = Record<string, unknown>;
  await app.register(
    (admin) => {
      admin.addHook('preHandler', auth.require(['admin']));
      admin.get(
        '/orders',
        async () =>
          (
            await service.pool.query<Row>(
              'SELECT shop,id,state,customer_payment,supplier_payment,updated_at FROM commerce_orders WHERE shop=$1 ORDER BY updated_at DESC LIMIT 100',
              [shop],
            )
          ).rows,
      );
      admin.get(
        '/alerts',
        async () =>
          (
            await service.pool.query<Row>(
              'SELECT kind,reference,created_at FROM commerce_alerts WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100',
            )
          ).rows,
      );
      admin.get(
        '/prices',
        async () =>
          (
            await service.pool.query<Row>(
              'SELECT * FROM commerce_price_proposals WHERE shop=$1 ORDER BY id DESC LIMIT 100',
              [shop],
            )
          ).rows,
      );
      admin.get(
        '/shipments',
        async () =>
          (
            await service.pool.query<Row>(
              'SELECT * FROM commerce_fulfillments WHERE shop=$1 ORDER BY updated_at DESC LIMIT 100',
              [shop],
            )
          ).rows,
      );
      admin.get(
        '/economics',
        async () =>
          (
            await service.pool.query<Row>(
              `SELECT l.order_id,
      sum(l.quantity*l.price_cents) AS merchandise_revenue_cents,
      sum(l.quantity*s.cost_cents) AS estimated_product_cost_cents,
      sum(l.quantity*s.shipping_cents) AS estimated_shipping_cents,
      bool_and(s.cost_cents IS NOT NULL AND s.shipping_cents IS NOT NULL) AS complete
      FROM commerce_lines l LEFT JOIN commerce_snapshots s ON s.shop=l.shop AND s.variant_id=l.variant_id
      WHERE l.shop=$1 GROUP BY l.order_id LIMIT 100`,
              [shop],
            )
          ).rows,
      );
      admin.post('/jobs/inventory', async () => service.synchronize());
      admin.post('/jobs/pricing', async () => service.synchronize());
      admin.post('/jobs/orders', async () => {
        let processed = 0;
        while (processed < 50 && (await service.processOne())) processed++;
        return { events: processed, orders: await service.prepareOrders() };
      });
      admin.post('/jobs/tracking', async () => {
        await service.pool.query(`INSERT INTO commerce_alerts(dedupe_key,kind,reference)
        SELECT 'STALLED:'||shop||'/'||id,'ORDER_STALLED',shop||'/'||id FROM commerce_orders
        WHERE state NOT IN ('DELIVERED','CANCELLED') AND updated_at<now()-interval '48 hours'
        ON CONFLICT DO NOTHING`);
        return { simulation: true, liveTrackingSupported: false };
      });
      admin.put('/mappings', async (req, reply) => {
        const parsed = z
          .object({
            variantId: z.string().regex(/^\d+$/),
            productId: z.string().regex(/^\d+$/),
            supplierId: z.string().min(1).max(100),
            supplierProductId: z.string().min(1).max(200),
            supplierVariantId: z.string().min(1).max(200),
          })
          .strict()
          .safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'INVALID_MAPPING' });
        const m = parsed.data;
        await service.pool.query(
          `INSERT INTO commerce_mappings(shop,variant_id,product_id,supplier_id,supplier_product_id,supplier_variant_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [shop, m.variantId, m.productId, m.supplierId, m.supplierProductId, m.supplierVariantId],
        );
        return { registered: true };
      });
      return Promise.resolve();
    },
    { prefix: '/api/v1/commerce' },
  );
  app.post(
    '/api/v1/commerce/orders/:id/simulate',
    { preHandler: auth.require(['approver']) },
    async (req, reply) => {
      const input = z
        .object({
          state: z.enum(states),
          confirm: z.literal(true),
          carrier: z.string().max(100).optional(),
          tracking: z.string().max(150).optional(),
        })
        .strict()
        .safeParse(req.body);
      const params = z.object({ id: z.string().regex(/^\d+$/) }).safeParse(req.params);
      if (!input.success || !params.success)
        return reply.code(400).send({ error: 'INVALID_SIMULATION' });
      const allowed = ['FULFILLMENT_REQUESTED', 'SUPPLIER_CONFIRMED', 'SHIPPED', 'DELIVERED'];
      if (!allowed.includes(input.data.state))
        return reply.code(400).send({ error: 'UNSUPPORTED_SIMULATION_STATE' });
      if (input.data.state === 'SHIPPED' && (!input.data.carrier || !input.data.tracking))
        return reply.code(400).send({ error: 'TRACKING_REQUIRED' });
      const db = await service.pool.connect();
      try {
        await db.query('BEGIN');
        const current = await db.query<{ state: (typeof states)[number] }>(
          'SELECT state FROM commerce_orders WHERE shop=$1 AND id=$2 FOR UPDATE',
          [shop, params.data.id],
        );
        if (!current.rows[0]) {
          await db.query('ROLLBACK');
          return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
        }
        if (current.rows[0].state === input.data.state) {
          await db.query('COMMIT');
          return { simulation: true, duplicate: true };
        }
        try {
          assertTransition(current.rows[0].state, input.data.state);
        } catch {
          await db.query('ROLLBACK');
          return reply.code(409).send({ error: 'INVALID_TRANSITION' });
        }
        await service.transition(db, shop, params.data.id, input.data.state, 'approver:simulation');
        await db.query(
          `UPDATE commerce_fulfillments SET status=$3,carrier=coalesce($4,carrier),tracking=coalesce($5,tracking),updated_at=now()
        WHERE shop=$1 AND order_id=$2`,
          [
            shop,
            params.data.id,
            input.data.state,
            input.data.carrier ?? null,
            input.data.tracking ?? null,
          ],
        );
        await db.query('COMMIT');
        return { simulation: true, shopifyUpdated: false, supplierContacted: false };
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    },
  );
}
