import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const privateHomes = new Set<string>();

/** Yardmaster's home holds prompts, agent output and the hub token: private to its owner (0700). */
export function yardHome(): string {
  const home = process.env.YARDMASTER_HOME ?? join(homedir(), '.yardmaster');
  if (!privateHomes.has(home)) {
    const created = mkdirSync(home, { recursive: true, mode: 0o700 });
    // Tighten a folder this user owns; leave one owned by someone else (or on a read-only disk) as it is.
    const st = statSync(home);
    if ((created || st.uid === process.getuid?.()) && (st.mode & 0o077) !== 0) {
      try {
        chmodSync(home, 0o700);
      } catch (err) {
        if (!['EPERM', 'EROFS', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      }
    }
    privateHomes.add(home);
  }
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
  /** One managed repo root per line; lets hook guards skip unmanaged folders without starting Node. */
  managedRoots: () => join(yardHome(), 'roots'),
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
