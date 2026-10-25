import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { commerceRoutes } from '../../src/commerce/routes.js';
import { createAuthGuard } from '../../src/http/auth.js';
import { CommerceService } from '../../src/commerce/service.js';

describe('webhook HTTP boundary (mock persistence)',()=>{
  it('acknowledges duplicates, verifies store and signature, preserves body',async()=>{
    const receive=vi.spyOn(CommerceService.prototype,'receive').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const app=Fastify();
    const service=Object.create(CommerceService.prototype) as CommerceService;
    await app.register(commerceRoutes,{service,auth:createAuthGuard({}),shop:'test.myshopify.com',secret:'secret'});
    const payload='{ "id": "42" }';
    const headers={'content-type':'application/json','x-shopify-shop-domain':'test.myshopify.com','x-shopify-webhook-id':'delivery-1','x-shopify-topic':'orders/create','x-shopify-hmac-sha256':createHmac('sha256','secret').update(payload).digest('base64')};
    try {
      expect((await app.inject({method:'POST',url:'/webhooks/shopify/orders',headers,payload})).json()).toEqual({accepted:true,duplicate:false});
      expect((await app.inject({method:'POST',url:'/webhooks/shopify/orders',headers,payload})).json()).toEqual({accepted:true,duplicate:true});
      expect((await app.inject({method:'POST',url:'/webhooks/shopify/orders',headers,payload:'{"id":"42"}'})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/webhooks/shopify/orders',headers:{...headers,'x-shopify-shop-domain':'other.myshopify.com'},payload})).statusCode).toBe(401);
      expect(receive).toHaveBeenCalledTimes(2);
    } finally { await app.close(); receive.mockRestore(); }
  });
});
