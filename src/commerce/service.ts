import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CatalogContext } from '../application/context.js';
import { recommendSalePrice } from '../domain/profitability.js';
import { assertTransition, decrypt, encrypt, orderSchema, type OrderState } from './model.js';

export class CommerceService {
  constructor(readonly pool: Pool, private readonly key: Buffer, private readonly ctx: CatalogContext) {}

  async receive(shop: string, delivery: string, event: string, topic: string, body: unknown): Promise<boolean> {
    const r = await this.pool.query(`INSERT INTO commerce_events(shop,delivery_id,event_id,topic,payload_encrypted)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [shop, delivery, event, topic, encrypt(body, this.key)]);
    return r.rowCount === 1;
  }

  async alert(kind: string, reference: string, db: Pool | PoolClient = this.pool): Promise<void> {
    await db.query(`INSERT INTO commerce_alerts(dedupe_key,kind,reference) VALUES($1,$2,$3)
      ON CONFLICT(dedupe_key) DO UPDATE SET resolved_at=NULL`, [`${kind}:${reference}`, kind, reference]);
  }

  async transition(db: PoolClient, shop: string, id: string, next: OrderState, actor: string): Promise<void> {
    const r = await db.query<{state: OrderState}>('SELECT state FROM commerce_orders WHERE shop=$1 AND id=$2 FOR UPDATE', [shop,id]);
    const from = r.rows[0]?.state;
    if (!from) throw new Error('ORDER_NOT_FOUND');
    assertTransition(from, next);
    await db.query('UPDATE commerce_orders SET state=$3,updated_at=now() WHERE shop=$1 AND id=$2', [shop,id,next]);
    await db.query('INSERT INTO commerce_audit(shop,order_id,action,actor,details) VALUES($1,$2,$3,$4,$5)', [shop,id,'TRANSITION',actor,JSON.stringify({from,to:next})]);
  }

  /** DB row locks survive concurrent workers. A crash rolls back both order and queue acknowledgement. */
  async processOne(): Promise<boolean> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await db.query<{shop:string; delivery_id:string; payload_encrypted:string; attempts:number}>(
        `SELECT * FROM commerce_events WHERE status='PENDING' AND available_at<=now()
         ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const e = result.rows[0];
      if (!e) { await db.query('COMMIT'); return false; }
      await db.query('SAVEPOINT processing');
      try {
        const o = orderSchema.parse(decrypt(e.payload_encrypted, this.key));
        await db.query(`INSERT INTO commerce_orders(shop,id,customer_payment,address_encrypted) VALUES($1,$2,$3,$4)
          ON CONFLICT DO NOTHING`, [e.shop,o.id,o.financial_status,o.shipping_address ? encrypt(o.shipping_address,this.key) : null]);
        const current = await db.query<{state:OrderState}>('SELECT state FROM commerce_orders WHERE shop=$1 AND id=$2 FOR UPDATE',[e.shop,o.id]);
        const state = current.rows[0]!.state;
        if (state === 'RECEIVED' || state === 'PAYMENT_PENDING') {
          for (const l of o.line_items) {
            await db.query(`INSERT INTO commerce_lines(shop,order_id,id,product_id,variant_id,quantity,price_cents)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[e.shop,o.id,l.id,l.product_id,l.variant_id,l.quantity,l.price]);
          }
          if (o.cancelled_at) await this.transition(db,e.shop,o.id,'CANCELLED','webhook-worker');
          else if (!o.shipping_address) {
            await this.transition(db,e.shop,o.id,'MANUAL_REVIEW','webhook-worker');
            await this.alert('ADDRESS_REQUIRED',`${e.shop}/${o.id}`,db);
          } else if (o.financial_status === 'paid') {
            const saved = await db.query<{id:string;product_id:string;variant_id:string;quantity:number;price_cents:string}>('SELECT id,product_id,variant_id,quantity,price_cents FROM commerce_lines WHERE shop=$1 AND order_id=$2',[e.shop,o.id]);
            const changed = saved.rows.length!==o.line_items.length || saved.rows.some(l=>!o.line_items.some(n=>n.id===l.id && n.product_id===l.product_id && n.variant_id===l.variant_id && n.quantity===l.quantity && n.price===Number(l.price_cents)));
            await db.query('UPDATE commerce_orders SET customer_payment=$3,address_encrypted=$4 WHERE shop=$1 AND id=$2',[e.shop,o.id,'paid',encrypt(o.shipping_address,this.key)]);
            await this.transition(db,e.shop,o.id,changed?'MANUAL_REVIEW':'PAID','webhook-worker');
            if(changed) await this.alert('ORDER_LINES_CHANGED',`${e.shop}/${o.id}`,db);
          } else if (state === 'RECEIVED') await this.transition(db,e.shop,o.id,'PAYMENT_PENDING','webhook-worker');
        } else if (o.cancelled_at || ['refunded','voided','partially_refunded'].includes(o.financial_status)) {
          // No automatic cancellation of an order that may already be at the supplier.
          await this.alert('PAYMENT_OR_CANCELLATION_CHANGED',`${e.shop}/${o.id}`,db);
        }
        await db.query("UPDATE commerce_events SET status='DONE',payload_encrypted='',last_error=NULL WHERE shop=$1 AND delivery_id=$2",[e.shop,e.delivery_id]);
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT processing');
        const dead = e.attempts + 1 >= 5;
        await db.query(`UPDATE commerce_events SET attempts=attempts+1,status=$3,last_error='PROCESSING_FAILED',
          available_at=now()+($4 * interval '1 second') WHERE shop=$1 AND delivery_id=$2`,[e.shop,e.delivery_id,dead?'DEAD':'PENDING',Math.min(900,2 ** (e.attempts+1))]);
        if (dead) await this.alert('DEAD_LETTER',`${e.shop}/${e.delivery_id}`,db);
      }
      await db.query('COMMIT');
      return true;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async synchronize(): Promise<unknown> {
    const db = await this.pool.connect();
    let syncId: string | undefined;
    try {
      // One synchronization across all processes; this dedicated connection owns the lock.
      const lock = await db.query<{locked:boolean}>('SELECT pg_try_advisory_lock(727003) AS locked');
      if (!lock.rows[0]?.locked) return {status:'BUSY'};
      const recent = await db.query("SELECT 1 FROM commerce_syncs WHERE started_at>now()-interval '60 seconds' LIMIT 1");
      if (recent.rowCount) return {status:'RATE_LIMITED'};
      syncId = (await db.query<{id:string}>('INSERT INTO commerce_syncs DEFAULT VALUES RETURNING id')).rows[0]!.id;
      const mappings = await db.query<{shop:string;variant_id:string;supplier_id:string;supplier_product_id:string;supplier_variant_id:string}>('SELECT * FROM commerce_mappings ORDER BY shop,variant_id LIMIT 500');
      let failed=0;
      for (const m of mappings.rows) {
        try {
          const supplier = this.ctx.suppliers.require(m.supplier_id);
          const p = await supplier.getProduct(m.supplier_product_id);
          const v = p?.currency === 'USD' ? p.variants.find(v=>v.externalId===m.supplier_variant_id) : undefined;
          const stocks = v ? await supplier.getInventory(v.externalId) : [];
          const us = stocks.filter(s=>s.countryCode==='US');
          const quantity = !us.length || us.some(s=>s.quantity===null) ? 0 : us.reduce((n,s)=>n+(s.quantity??0),0);
          const quotes = v ? await supplier.getShippingQuotes({variantExternalId:v.externalId,originCountry:'US',destinationCountry:'US',quantity:1}) : [];
          const shipping = quotes.filter(q=>q.originCountry==='US' && q.destinationCountry==='US').sort((a,b)=>a.costCents-b.costCents)[0]?.costCents ?? null;
          await db.query(`INSERT INTO commerce_snapshots(shop,variant_id,quantity,cost_cents,shipping_cents) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(shop,variant_id) DO UPDATE SET quantity=$3,cost_cents=$4,shipping_cents=$5,observed_at=now()`,[m.shop,m.variant_id,quantity,v?.costCents??null,shipping]);
          if (!quantity) await this.alert('OUT_OF_STOCK',`${m.shop}/${m.variant_id}`,db);
          if (v?.costCents !== null && v?.costCents !== undefined && shipping !== null) {
            const price = recommendSalePrice(v.costCents,shipping,this.ctx.rules.pricing);
            const fingerprint = createHash('sha256').update(JSON.stringify([m.shop,m.variant_id,v.costCents,shipping,this.ctx.rules.hash])).digest('hex');
            await db.query(`INSERT INTO commerce_price_proposals(shop,variant_id,fingerprint,cost_cents,shipping_cents,recommended_cents)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[m.shop,m.variant_id,fingerprint,v.costCents,shipping,price]);
          }
        } catch {
          failed++;
          // Unknown availability must invalidate earlier positive snapshots immediately.
          await db.query('UPDATE commerce_snapshots SET quantity=0,observed_at=now() WHERE shop=$1 AND variant_id=$2',[m.shop,m.variant_id]);
          await this.alert('SUPPLIER_UNAVAILABLE',`${m.shop}/${m.variant_id}`,db);
        }
      }
      const result = {processed:mappings.rows.length,failed,liveWrites:false};
      await db.query('UPDATE commerce_syncs SET finished_at=now(),status=$2,result=$3 WHERE id=$1',[syncId,failed?'PARTIAL':'COMPLETED',JSON.stringify(result)]);
      return result;
    } finally {
      await db.query('SELECT pg_advisory_unlock(727003)');
      db.release();
    }
  }

  async prepareOrders(): Promise<unknown> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(727003)');
      const orders = await db.query<{shop:string;id:string}>("SELECT shop,id FROM commerce_orders WHERE state='PAID' ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 50");
      for (const o of orders.rows) {
        await this.transition(db,o.shop,o.id,'STOCK_VALIDATION','order-worker');
        // Aggregate duplicate variants and competing orders; snapshots are deliberately short lived.
        const invalid = await db.query(`SELECT l.variant_id FROM commerce_lines l
          LEFT JOIN commerce_snapshots s ON s.shop=l.shop AND s.variant_id=l.variant_id
          LEFT JOIN commerce_mappings m ON m.shop=l.shop AND m.variant_id=l.variant_id
          WHERE l.shop=$1 AND l.order_id=$2
          GROUP BY l.variant_id,s.quantity,s.observed_at,s.cost_cents,s.shipping_cents,m.product_id
          HAVING m.product_id IS NULL OR bool_or(l.product_id<>m.product_id) OR s.quantity IS NULL
            OR s.observed_at<now()-interval '2 minutes' OR s.cost_cents IS NULL OR s.shipping_cents IS NULL
            OR sum(l.quantity)>s.quantity`,[o.shop,o.id]);
        const next = invalid.rowCount ? 'MANUAL_REVIEW' : 'READY_FOR_FULFILLMENT';
        await this.transition(db,o.shop,o.id,next,'order-worker');
        if (next === 'MANUAL_REVIEW') await this.alert('ORDER_BLOCKED',`${o.shop}/${o.id}`,db);
        else {
          // Atomic local reservation. Still no guarantee of stock at the remote supplier.
          const reserved = await db.query(`UPDATE commerce_snapshots s SET quantity=s.quantity-q.qty FROM
            (SELECT variant_id,sum(quantity)::integer qty FROM commerce_lines WHERE shop=$1 AND order_id=$2 GROUP BY variant_id) q
            WHERE s.shop=$1 AND s.variant_id=q.variant_id AND s.quantity>=q.qty RETURNING s.variant_id`,[o.shop,o.id]);
          if (!reserved.rowCount) throw new Error('RESERVATION_FAILED');
          await db.query("INSERT INTO commerce_fulfillments(shop,order_id,mode) VALUES($1,$2,'SIMULATION') ON CONFLICT DO NOTHING",[o.shop,o.id]);
        }
      }
      await db.query('COMMIT');
      return {processed:orders.rows.length,simulation:true};
    } catch(error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}
