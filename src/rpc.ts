import { normalizeHubUrl, type PrivateTransport } from './fleet-client.ts';
import type { Client } from './api.ts';

/**
 * HTTP client for the hub API. Kept free of heavy imports (zod, the MCP SDK, the coordinator) so short-lived
 * processes such as hooks start fast.
 */
/** A hub that stops answering must not hang the CLI, a worker or an agent's MCP call forever. */
export const RPC_TIMEOUT_MS = 60_000;

/** How long one call may take: task.wait waits by design, everything else answers quickly. */
export function rpcDeadline(name: string, params: unknown, override?: number): number {
  if (override) return Math.ceil(override);
  if (name === 'task.wait') {
    const sec = Number((params as { timeoutSec?: unknown } | null)?.timeoutSec ?? 60);
    // AbortSignal.timeout only takes whole milliseconds; a fractional wait (1.5 s) must not throw.
    return Math.ceil((Number.isFinite(sec) ? sec : 60) * 1000) + 15_000;
  }
  return RPC_TIMEOUT_MS;
}

/**
 * `ownerLocal` marks the URL this machine's own hub wrote to hub.info in the owner-only home. That hub may be bound to
 * a private overlay address (`ym hub run --host 100.x`), which is still this owner's hub: the remote-endpoint gate
 * exists for URLs a user or environment supplies, not for the one the local hub published.
 */
export function remoteClient(baseUrl: string, token: string, opts: { timeoutMs?: number; ownerLocal?: boolean } & PrivateTransport = {}): Client {
  const url = normalizeHubUrl(baseUrl, opts.ownerLocal ? { privateNetwork: true } : opts);
  return new Proxy({} as Client, {
    get: (_t, name: string) =>
      name === 'then'
        ? undefined
        : async (params: unknown) => {
            const res = await fetch(`${url}/api/rpc/${name}`, {
              method: 'POST', redirect: 'error',
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
