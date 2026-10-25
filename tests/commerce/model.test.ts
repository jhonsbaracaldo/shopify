import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { assertTransition, decrypt, encrypt, validHmac, orderSchema } from '../../src/commerce/model.js';

describe('commerce security and states',()=>{
  it('checks the original bytes and rejects malformed or altered signatures',()=>{
    const raw=Buffer.from('{ "id": 1 }');
    const signature=createHmac('sha256','secret').update(raw).digest('base64');
    expect(validHmac(raw,signature,'secret')).toBe(true);
    expect(validHmac(Buffer.from('{"id":1}'),signature,'secret')).toBe(false);
    expect(validHmac(raw,'invalid','secret')).toBe(false);
  });
  it('encrypts personal information with authenticated encryption',()=>{
    const key=randomBytes(32);
    const address={address1:'Private street'};
    const data=encrypt(address,key);
    expect(data).not.toContain('Private');
    expect(decrypt(data,key)).toEqual(address);
    expect(()=>decrypt(data,randomBytes(32))).toThrow();
  });
  it('rejects unpaid fulfillment and terminal transitions',()=>{
    expect(()=>assertTransition('PAYMENT_PENDING','FULFILLMENT_REQUESTED')).toThrow();
    expect(()=>assertTransition('DELIVERED','PAID')).toThrow();
    expect(()=>assertTransition('PAID','STOCK_VALIDATION')).not.toThrow();
  });
  it('rejects unsafe numeric Shopify identifiers and invalid quantities',()=>{
    expect(orderSchema.safeParse({id:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
    expect(orderSchema.safeParse({id:'1',currency:'USD',financial_status:'paid',shipping_address:null,line_items:[{id:'2',product_id:'3',variant_id:'4',quantity:0,price:'10.00'}]}).success).toBe(false);
  });
});
