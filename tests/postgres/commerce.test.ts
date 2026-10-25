import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/adapters/persistence/postgres/migrator.js';
import { MIGRATIONS_DIR } from '../../src/composition.js';
import { CommerceService } from '../../src/commerce/service.js';
import { createTestContext } from '../phase2/helpers.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('commerce PostgreSQL (dedicated test database)',()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const service=new CommerceService(pool,randomBytes(32),createTestContext());
  const shop=`${randomUUID()}.myshopify.com`;
  beforeAll(async()=>{await runMigrations(pool,MIGRATIONS_DIR);});
  afterAll(async()=>{
    await pool.query('DELETE FROM commerce_events WHERE shop=$1',[shop]);
    await pool.query('DELETE FROM commerce_lines WHERE shop=$1',[shop]);
    await pool.query('DELETE FROM commerce_audit WHERE shop=$1',[shop]);
    await pool.query('DELETE FROM commerce_orders WHERE shop=$1',[shop]);
    await pool.query('DELETE FROM commerce_alerts WHERE reference LIKE $1',[`${shop}/%`]);
    await pool.end();
  });
  it('deduplicates deliveries and orders, preserves unpaid status, blocks unknown inventory',async()=>{
    const body={id:'123',currency:'USD',financial_status:'pending',shipping_address:{first_name:'Test',last_name:'Only',address1:'Private',city:'Test',province_code:'CA',zip:'90001',country_code:'US'},line_items:[{id:'1',product_id:'2',variant_id:'3',quantity:2,price:'10.00'}]};
    expect(await service.receive(shop,'delivery-1','event-1','orders/create',body)).toBe(true);
    expect(await service.receive(shop,'delivery-1','event-1','orders/create',body)).toBe(false);
    // Drain only in an isolated database: the worker intentionally serves all shops.
    while(await service.processOne()) { /* drain ready jobs */ }
    expect((await pool.query('SELECT state FROM commerce_orders WHERE shop=$1',[shop])).rows[0].state).toBe('PAYMENT_PENDING');
    await service.prepareOrders();
    expect((await pool.query('SELECT state FROM commerce_orders WHERE shop=$1',[shop])).rows[0].state).toBe('PAYMENT_PENDING');
    await service.receive(shop,'delivery-2','event-2','orders/paid',{...body,financial_status:'paid'});
    while(await service.processOne()) { /* drain ready jobs */ }
    await service.prepareOrders();
    const orders=await pool.query('SELECT state FROM commerce_orders WHERE shop=$1',[shop]);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0].state).toBe('MANUAL_REVIEW');
    expect((await pool.query('SELECT * FROM commerce_lines WHERE shop=$1',[shop])).rows).toHaveLength(1);
  });
  it('schedules retries for malformed signed payloads without leaking payload to errors',async()=>{
    await service.receive(shop,'invalid','invalid','orders/create',{secret:'Private'});
    while(await service.processOne()) { /* drain ready jobs */ }
    const r=await pool.query('SELECT attempts,status,last_error FROM commerce_events WHERE shop=$1 AND delivery_id=$2',[shop,'invalid']);
    expect(r.rows[0]).toMatchObject({attempts:1,status:'PENDING',last_error:'PROCESSING_FAILED'});
  });
});
