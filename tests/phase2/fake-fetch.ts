import type { FetchLike } from '../../src/adapters/http/resilient-http-client.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (call: RecordedCall) => Response | Promise<Response> | Error;

/**
 * fetch simulado: cada llamada consume la siguiente respuesta de la ruta (por subcadena de URL).
 * Permite verificar headers y cuerpos enviados sin red.
 */
export function createFakeFetch(routes: Record<string, Responder[]>) {
  const calls: RecordedCall[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body as string | undefined,
    };
    calls.push(call);
    const key = [...queues.keys()].find((k) => url.includes(k));
    const queue = key ? queues.get(key)! : undefined;
    const responder = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!responder) throw new Error(`fake-fetch: ruta no simulada ${url}`);
    const result = await responder(call);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const noSleep = async () => {};
