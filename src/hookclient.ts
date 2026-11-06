import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from './api.ts';
import { remoteClient } from './rpc.ts';
import { paths, yardHome } from './paths.ts';

/**
 * The hub client for agent hooks, which run on every prompt and file edit: read where the hub is and its token from
 * the home folder, with no liveness check (a hub that's gone just times out, and hooks fail open) and a short timeout.
 */
export function hookClient(): Client | null {
  const remote = process.env.YARDMASTER_HUB;
  const tokenFile = join(yardHome(), 'token');
  const token = process.env.YARDMASTER_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
  if (remote) return remoteClient(remote, token, { timeoutMs: 1500 });
  if (!existsSync(paths.hubInfo()) || !token) return null;
  const { url } = JSON.parse(readFileSync(paths.hubInfo(), 'utf8')) as { url: string };
  return remoteClient(url, token, { timeoutMs: 1500 });
}
