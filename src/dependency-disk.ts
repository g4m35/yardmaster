import { watch, type FSWatcher, type Dirent } from 'node:fs';
import { lstat, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dirBytes, invalidateSize, diskSizeRevision } from './disk.ts';
import type { CloneResult } from './fastfs.ts';

interface Clone {
  stamp: string;
  dirty: boolean;
  watcher: FSWatcher | null;
}
const clones = new Map<string, Clone>();
let revision = 0;
const totals = new Map<string, { at: number; bytes: number; revision: number }>();

async function stamp(path: string): Promise<string> {
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory()) throw new Error('Dependency directory was replaced');
  return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
}

export async function recordDependencyClone(path: string, method: CloneResult['method']): Promise<void> {
  path = resolve(path);
  clones.get(path)?.watcher?.close();
  clones.delete(path);
  totals.clear(); revision++;
  if (method === 'cp') return;
  const record: Clone = { stamp: '', dirty: false, watcher: null };
  const dirty = () => {
    if (record.dirty) return;
    record.dirty = true;
    if (clones.get(path) === record) clones.delete(path);
    record.watcher?.close();
    invalidateSize(path);
    totals.clear(); revision++;
  };
  try {
    // Root mtime alone misses in-place writes in nested packages. Lost monitoring forfeits the exemption.
    const marker = await mkdtemp(join(dirname(path), '.clone-proof-'));
    let clonedAt: bigint;
    try {
      const file = join(marker, 'complete');
      await writeFile(file, '');
      clonedAt = (await lstat(file, { bigint: true })).ctimeNs;
    } finally { await rm(marker, { recursive: true, force: true }); }
    record.watcher = watch(path, { recursive: true }, (_, name) => {
      if (!name) { dirty(); return; }
      // macOS can deliver creation events after watch starts; only later inode changes invalidate the clone.
      void lstat(join(path, name), { bigint: true }).catch((err: NodeJS.ErrnoException) => {
        // FSEvents sometimes names the watched root itself, relative to its parent.
        if (process.platform === 'darwin' && name === basename(path) && err.code === 'ENOENT') return lstat(path, { bigint: true });
        throw err;
      }).then(st => {
        if (st.ctimeNs > clonedAt) dirty();
      }, dirty);
    });
    record.watcher.on('error', dirty);
    record.watcher.on('close', () => { if (!record.dirty) dirty(); });
    record.watcher.unref();
    record.stamp = await stamp(path);
    if (!record.dirty) clones.set(path, record);
  } catch { dirty(); }
}

export async function worktreeBytes(root: string, shareDirs: string[]): Promise<number> {
  root = resolve(root);
  for (const [path, record] of clones) {
    if (!path.startsWith(root + '/')) continue;
    let current: string | null = null;
    try { current = await stamp(path); } catch { /* Missing or replaced installs count normally. */ }
    if (record.dirty || record.stamp !== current) {
      record.dirty = true; record.watcher?.close(); clones.delete(path); totals.clear(); revision++; invalidateSize(path);
    }
  }
  const key = `${root}\0${shareDirs.join('\0')}`;
  const hit = totals.get(key);
  if (hit && hit.revision === diskSizeRevision() && Date.now() - hit.at < 60_000) return hit.bytes;
  const started = revision;
  // Count the small source trees separately so du never enters an unchanged clone.
  let bytes = await dirBytes(root, 60_000, shareDirs);
  const names = new Set(shareDirs);
  const walk = async (path: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const child = join(path, entry.name);
      if (names.has(entry.name)) {
        if (!clones.has(child)) bytes += await dirBytes(child, 60_000);
      } else if (entry.isDirectory()) await walk(child);
    }
  };
  await walk(root);
  if (revision !== started) return worktreeBytes(root, shareDirs);
  totals.set(key, { at: Date.now(), bytes, revision: diskSizeRevision() });
  return bytes;
}
