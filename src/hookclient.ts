import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from './api.ts';
import { remoteClient } from './rpc.ts';
import { isLoopbackHub, loadWorkerCredential, normalizeHubUrl, type PrivateTransport } from './fleet-client.ts';
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

export function hookClient(): Client | null {
  const remote = process.env.YARDMASTER_HUB;
  if (!remote && !existsSync(paths.hubInfo())) return null;
  const input = remote ?? (JSON.parse(readFileSync(paths.hubInfo(), 'utf8')) as { url: string }).url;
  const opts = { privateNetwork: process.env.YARDMASTER_PRIVATE_NETWORK === '1', projectId: process.env.YARDMASTER_PROJECT_ID,
    machineId: process.env.YARDMASTER_PROJECT_ID ? machineId() : undefined };
  const { hub, token } = hubCredential(input, process.env.YARDMASTER_TOKEN, opts);
  return token ? remoteClient(hub, token, { ...opts, timeoutMs: 1500 }) : null;
}
