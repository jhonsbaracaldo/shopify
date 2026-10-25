import { describe, expect, it } from 'vitest';
import { ExternalServiceError } from '../../../src/application/errors.js';
import {
  parseRetryAfter,
  RateLimiter,
  ResilientHttpClient,
} from '../../../src/adapters/http/resilient-http-client.js';
import { createFakeFetch, json } from '../fake-fetch.js';

function client(fetchImpl: ReturnType<typeof createFakeFetch>['fetch'], sleeps: number[] = []) {
  return new ResilientHttpClient({
    service: 'test',
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
}

const get = {
  method: 'GET' as const,
  url: 'https://api.test/x',
  timeoutMs: 1000,
  idempotent: true,
  operation: 'x',
};

describe('ResilientHttpClient', () => {
  it('reintenta 503 en operaciones idempotentes con backoff exponencial y jitter', async () => {
    const sleeps: number[] = [];
    const fake = createFakeFetch({
      '/x': [() => json({}, 503), () => json({}, 503), () => json({ ok: true })],
    });
    const res = await client(fake.fetch, sleeps).request(get);
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]); // random 0.5 × (100, 200)
  });

  it('NO reintenta 5xx en operaciones no idempotentes (resultado desconocido)', async () => {
    const fake = createFakeFetch({ '/x': [() => json({}, 503)] });
    const res = await client(fake.fetch).request({ ...get, method: 'POST', idempotent: false });
    expect(res.status).toBe(503);
    expect(fake.calls).toHaveLength(1);
  });

  it('reintenta 429 siempre, respetando Retry-After', async () => {
    const sleeps: number[] = [];
    const fake = createFakeFetch({
      '/x': [() => json({}, 429, { 'retry-after': '2' }), () => json({ ok: 1 })],
    });
    await client(fake.fetch, sleeps).request({ ...get, method: 'POST', idempotent: false });
    expect(sleeps).toEqual([2000]);
  });

  it('agota reintentos con un error tipado y reintentable', async () => {
    const fake = createFakeFetch({ '/x': [() => json({}, 429)] });
    const error = await client(fake.fetch)
      .request(get)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({ kind: 'rate_limited', code: 'RATE_LIMITED', retryable: true });
    expect(fake.calls).toHaveLength(3);
  });

  it('convierte timeouts en UPSTREAM_TIMEOUT y los reintenta solo si es idempotente', async () => {
    const timeout = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fakeA = createFakeFetch({ '/x': [timeout] });
    await expect(client(fakeA.fetch).request(get)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      kind: 'timeout',
    });
    expect(fakeA.calls).toHaveLength(3);

    const fakeB = createFakeFetch({ '/x': [timeout] });
    await expect(client(fakeB.fetch).request({ ...get, idempotent: false })).rejects.toMatchObject({
      retryable: false,
    });
    expect(fakeB.calls).toHaveLength(1);
  });

  it('no expone la query string en los mensajes de error', async () => {
    const fake = createFakeFetch({ '/x': [() => new Error('boom')] });
    const error = (await client(fake.fetch)
      .request({ ...get, url: 'https://api.test/x?token=secreto', idempotent: false })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('secreto');
  });
});

describe('RateLimiter', () => {
  it('espacia el inicio de las peticiones según el máximo por segundo', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      2,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => starts.push(now))));
    expect(starts).toEqual([0, 500, 1000]);
    expect(waits).toEqual([500, 500]);
  });
});

describe('parseRetryAfter', () => {
  it('acepta segundos y fechas HTTP', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('basura')).toBeNull();
  });
});
