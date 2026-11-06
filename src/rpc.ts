import type { Client } from './api.ts';

/**
 * HTTP client for the hub API. Kept free of heavy imports (zod, the MCP SDK, the coordinator) so short-lived
 * processes such as hooks start fast.
 */
/** A hub that stops answering must not hang the CLI, a worker or an agent's MCP call forever. */
export const RPC_TIMEOUT_MS = 60_000;

/** How long one call may take: task.wait waits by design, everything else answers quickly. */
export function rpcDeadline(name: string, params: unknown, override?: number): number {
  if (override) return override;
  if (name === 'task.wait') {
    const sec = Number((params as { timeoutSec?: unknown } | null)?.timeoutSec ?? 60);
    return (Number.isFinite(sec) ? sec : 60) * 1000 + 15_000;
  }
  return RPC_TIMEOUT_MS;
}

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
              signal: AbortSignal.timeout(rpcDeadline(name, params, opts.timeoutMs)),
            });
            const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
            if (!body.ok) throw new Error(body.error ?? `Hub returned ${res.status}`);
            return body.result;
          },
  });
}
