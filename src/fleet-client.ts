import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from './api.ts';
import { rpcDeadline } from './rpc.ts';

export interface PrivateTransport { privateNetwork?: boolean }
export interface FleetWorkerIdentity { kind: 'worker'; machineId: string; projectId: string; expiresAt: number }
export type FleetIdentity = { kind: 'owner' } | FleetWorkerIdentity;
export interface SavedWorkerCredential extends FleetWorkerIdentity { version: 1; hub: string; token: string }
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/;
const TOKEN = /^ymw_[A-Za-z0-9_-]{43}$/;

/** Canonical endpoint, never a URL containing a bearer token. HTTP requires loopback or an explicit overlay acknowledgment. */
export function normalizeHubUrl(input: string, opts: PrivateTransport = {}): string {
  if (!/^https?:\/\//i.test(input) || /[\s\\?#]/.test(input)) throw new Error('Hub URL must be an absolute http(s) URL without credentials, query or fragment.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid hub URL. Use https://hub-host:7777.'); }
  if (url.username || url.password || input.split('/')[2]?.includes('@')) throw new Error('Hub URL must not contain credentials.');
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (url.protocol === 'http:' && !loopback && !opts.privateNetwork) {
    throw new Error('Non-loopback HTTP requires --private-network to acknowledge an existing encrypted private overlay. Otherwise use HTTPS.');
  }
  return url.href.replace(/\/+$/, '');
}

/** Do not follow redirects with invitation codes or bearer credentials. */
async function request<T>(hub: string, path: string, params: unknown, token?: string, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${hub}${path}`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params ?? {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json() as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || body.ok !== true) throw new Error(body.error ?? `Hub request refused (${response.status}). Pair again if the credential expired or was revoked.`);
  return body.result as T;
}

export function fleetClient(input: string, token: string, opts: PrivateTransport = {}): Client {
  const hub = normalizeHubUrl(input, opts);
  return new Proxy({} as Client, {
    get: (_target, name: string) => name === 'then' ? undefined : (params: unknown) => {
      if (!/^[a-z][a-zA-Z.]+$/.test(name)) throw new Error('Invalid RPC method');
      return request(hub, `/api/rpc/${name}`, params, token, rpcDeadline(name, params));
    },
  });
}

function workerIdentity(value: unknown): FleetWorkerIdentity {
  const v = value as Partial<FleetWorkerIdentity> | null;
  if (!v || v.kind !== 'worker' || typeof v.machineId !== 'string' || !ID.test(v.machineId) ||
      typeof v.projectId !== 'string' || !ID.test(v.projectId) || !Number.isSafeInteger(v.expiresAt) || v.expiresAt! <= Date.now()) {
    throw new Error('Hub did not return a valid, unexpired worker identity. Pair again.');
  }
  return { kind: 'worker', machineId: v.machineId, projectId: v.projectId, expiresAt: v.expiresAt! };
}

function checkPrivate(path: string, directory: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) ||
      (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) {
    throw new Error(`Unsafe worker credential ${directory ? 'directory' : 'file'}: ${path}. Require owner-only ${directory ? '0700' : '0600'} permissions and no symlinks.`);
  }
}

export function workerCredentialDirectory(): string {
  const home = resolve(process.env.YARDMASTER_HOME ?? join(homedir(), '.yardmaster'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Unlike the shared home helper, fail closed on existing public paths; do not silently change host settings.
  checkPrivate(home, true);
  const dir = join(home, 'worker-credentials');
  mkdirSync(dir, { mode: 0o700, recursive: true });
  checkPrivate(dir, true);
  return dir;
}

export function workerCredentialPath(hub: string, projectId: string, opts: PrivateTransport = {}): string {
  const canonical = normalizeHubUrl(hub, opts);
  if (!ID.test(projectId)) throw new Error('Invalid worker project ID.');
  const key = createHash('sha256').update(JSON.stringify([canonical, projectId])).digest('hex');
  return join(workerCredentialDirectory(), `${key}.json`);
}

export function saveWorkerCredential(value: SavedWorkerCredential, opts: PrivateTransport = {}): string {
  const identity = workerIdentity(value);
  if (!TOKEN.test(value.token)) throw new Error('Refusing to save a non-worker credential.');
  const hub = normalizeHubUrl(value.hub, opts);
  const file = workerCredentialPath(hub, identity.projectId, opts);
  try { checkPrivate(file, false); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, hub, ...identity, token: value.token }) + '\n');
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    return file;
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

export function loadWorkerCredential(hub: string, projectId: string, machineId: string, opts: PrivateTransport = {}): SavedWorkerCredential {
  const canonical = normalizeHubUrl(hub, opts);
  const file = workerCredentialPath(canonical, projectId, opts);
  let fd: number | undefined;
  try {
    checkPrivate(file, false);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || st.size > 8192) throw new Error('Unsafe worker credential file.');
    let value: SavedWorkerCredential;
    try { value = JSON.parse(readFileSync(fd, 'utf8')) as SavedWorkerCredential; } catch { throw new Error('Invalid saved worker credential. Pair again.'); }
    const identity = workerIdentity(value);
    if (value.version !== 1 || value.hub !== canonical || identity.projectId !== projectId || identity.machineId !== machineId || !TOKEN.test(value.token)) {
      throw new Error('Saved worker credential does not match this hub, machine and project. Pair again.');
    }
    return { version: 1, hub: canonical, ...identity, token: value.token };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No saved worker credential for this hub and project. Run ym pair join <code> --hub URL first.');
    throw err;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function joinFleet(input: { hub: string; code: string; machineId: string; projectId?: string } & PrivateTransport): Promise<{ identity: FleetWorkerIdentity; file: string }> {
  const hub = normalizeHubUrl(input.hub, input);
  if (!/^ymi_[A-Za-z0-9_-]{43}$/.test(input.code) || !ID.test(input.machineId)) throw new Error('Invalid pairing code or machine ID. Create a fresh invitation on the owner hub.');
  // Verify storage before consuming the one-use invitation.
  workerCredentialDirectory();
  const result = await request<{ token: string; identity: FleetWorkerIdentity; credential: { projectId: string; machineId: string; expiresAt: number } }>(hub, '/api/pair', { code: input.code, machineId: input.machineId });
  const identity = workerIdentity(result?.identity);
  if (identity.machineId !== input.machineId || (input.projectId && identity.projectId !== input.projectId) ||
      result.credential?.projectId !== identity.projectId || result.credential.machineId !== identity.machineId || result.credential.expiresAt !== identity.expiresAt || !TOKEN.test(result.token)) {
    throw new Error('Pairing response scope does not match. Invitation may be consumed; create a fresh invitation.');
  }
  const live = workerIdentity(await fleetClient(hub, result.token, input)['fleet.identity']({}));
  if (live.machineId !== identity.machineId || live.projectId !== identity.projectId || live.expiresAt !== identity.expiresAt) throw new Error('Pairing identity changed; create a fresh invitation.');
  const file = saveWorkerCredential({ version: 1, hub, ...identity, token: result.token }, input);
  return { identity, file };
}

/** Explicit tokens keep the legacy owner path; failed/unknown credentials never fall back to an owner token. */
export async function connectWorker(input: { hub: string; machineId: string; projectIds: string[]; token?: string } & PrivateTransport) {
  const hub = normalizeHubUrl(input.hub, input);
  if (!ID.test(input.machineId) || !input.projectIds.length || input.projectIds.some(id => !ID.test(id))) throw new Error('A worker needs a valid machine ID and project.');
  if (!input.token && input.projectIds.length !== 1) throw new Error('Paired workers use one project per channel. Run a separate worker for each project.');
  const token = input.token ?? loadWorkerCredential(hub, input.projectIds[0]!, input.machineId, input).token;
  const client = fleetClient(hub, token, input);
  const result = await client['fleet.identity']({});
  let identity: FleetIdentity;
  if (result?.kind === 'owner' && input.token) identity = { kind: 'owner' };
  else {
    identity = workerIdentity(result);
    if (input.projectIds.length !== 1 || identity.machineId !== input.machineId || identity.projectId !== input.projectIds[0]) {
      throw new Error('Worker credential is bound to one different machine/project. Use that repository and machine, or pair again.');
    }
  }
  return { hub, token, identity, client };
}
