import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export function yardHome(): string {
  const home = process.env.YARDMASTER_HOME ?? join(homedir(), '.yardmaster');
  mkdirSync(home, { recursive: true });
  return home;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export const paths = {
  db: () => join(yardHome(), 'yardmaster.db'),
  logs: () => ensureDir(join(yardHome(), 'logs')),
  tmp: () => ensureDir(join(yardHome(), 'tmp')),
  plugins: () => ensureDir(join(yardHome(), 'plugins')),
  globalConfig: () => join(yardHome(), 'config.json'),
  hubInfo: () => join(yardHome(), 'hub.json'),
  hubLog: () => join(yardHome(), 'hub.log'),
};

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Stable per-machine identity, so leases and runs survive restarts. */
export function machineId(): string {
  const file = join(yardHome(), 'machine-id');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const id = `m-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}-${randomBytes(3).toString('hex')}`;
  writeFileSync(file, id + '\n');
  return id;
}

/** Shared secret for the hub API. Created once, readable only by the owner. */
export function hubToken(): string {
  const file = join(yardHome(), 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
