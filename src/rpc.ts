import type { Client } from './api.ts';

/**
 * HTTP client for the hub API. Kept free of heavy imports (zod, the MCP SDK, the coordinator) so short-lived
 * processes such as hooks start fast.
 */
export function remoteClient(baseUrl: string, token: string, opts: { timeoutMs?: number } = {}): Client {
  const url = baseUrl.replace(/\/$/, '');
  return new Proxy({} as Client, {
    get: (_t, name: string) =>
      name === 'then'
        ? undefined
        : async (params: unknown) => {
            const res = await fetch(`${url}/api/rpc/${name}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify(params ?? {}),
              signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
            });
            const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
            if (!body.ok) throw new Error(body.error ?? `Hub returned ${res.status}`);
            return body.result;
          },
  });
}
