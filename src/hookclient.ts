import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from './api.ts';
import { remoteClient } from './rpc.ts';
import { isLoopbackHub, isThisMachineAddress, loadWorkerCredential, normalizeHubUrl, type PrivateTransport } from './fleet-client.ts';
import { machineId, paths, yardHome } from './paths.ts';

/** Only an explicitly shared name links a native hook and MCP connection; a common folder proves no identity. */
export function nativeSessionName(fallback: string): string {
  return process.env.YARDMASTER_SESSION || fallback;
}

/** Never open the local owner credential on a remote-hub path, even when no remote credential exists. */
export function hubCredential(input: string, explicit?: string, opts: PrivateTransport & { projectId?: string; machineId?: string } = {}): { hub: string; token: string } {
  const hub = normalizeHubUrl(input, opts);
  if (explicit) return { hub, token: explicit };
  if (!isLoopbackHub(hub) && opts.projectId && opts.machineId) return { hub, token: loadWorkerCredential(hub, opts.projectId, opts.machineId, opts).token };
  if (!isLoopbackHub(hub)) throw new Error('Remote hubs require an explicit credential. Set YARDMASTER_TOKEN (or use ym worker with the saved pairing credential for this exact hub URL). The local owner token is only used for loopback hubs.');
  const tokenFile = join(yardHome(), 'token');
  return { hub, token: existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '' };
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  // The hub runs as this user; EPERM means the pid now belongs to someone else, who could hold the port.
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function hookClient(): Client | null {
  const remote = process.env.YARDMASTER_HUB;
  if (!remote && !existsSync(paths.hubInfo())) return null;
  if (!remote) {
    // The owner token goes only to a hub that is still running here and listening on one of this machine's addresses.
    // A stale or rewritten hub.info pointing anywhere else is treated like any other remote URL.
    const info = JSON.parse(readFileSync(paths.hubInfo(), 'utf8')) as { url: string; pid?: number };
    if (!alive(info.pid) || !isThisMachineAddress(info.url)) return null;
    const tokenFile = join(yardHome(), 'token');
    const token = process.env.YARDMASTER_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
    return token ? remoteClient(info.url, token, { ownerLocal: true, timeoutMs: 1500 }) : null;
  }
  const opts = { privateNetwork: process.env.YARDMASTER_PRIVATE_NETWORK === '1', projectId: process.env.YARDMASTER_PROJECT_ID,
    machineId: process.env.YARDMASTER_PROJECT_ID ? machineId() : undefined };
  const { hub, token } = hubCredential(remote, process.env.YARDMASTER_TOKEN, opts);
  return token ? remoteClient(hub, token, { ...opts, timeoutMs: 1500 }) : null;
}
