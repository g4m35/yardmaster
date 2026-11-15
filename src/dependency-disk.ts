import { watch, type FSWatcher, type Dirent } from 'node:fs';
import { lstat, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dirBytes, dirBytesMany, invalidateSize, diskSizeRevision } from './disk.ts';
import type { CloneResult } from './fastfs.ts';

interface Source {
  path: string;
  stamp: string;
  id: number;
  dirty: boolean;
  users: number;
  ready: Promise<void>;
  stop(): void;
  invalidate(): void;
}
interface Clone {
  stamp: string;
  dirty: boolean;
  stop(): void;
  source: Source;
  shared: boolean;
}
const clones = new Map<string, Clone>();
const sources = new Map<string, Source>();
let sourceEpoch = 0;
let revision = 0;
const totals = new Map<string, { at: number; bytes: number; revision: number }>();

async function stamp(path: string): Promise<string> {
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory()) throw new Error('Dependency directory was replaced');
  return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
}

function changed(path: string): void {
  invalidateSize(path); totals.clear(); revision++;
}

async function monitor(path: string, since: bigint, invalidate: () => void): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  let closed = false;
  const stop = () => { closed = true; for (const watcher of watchers) watcher.close(); };
  const fail = () => { if (!closed) { stop(); invalidate(); } };
  const observe = (dir: string, recursive: boolean) => {
    const watcher = watch(dir, { recursive }, (_, name) => {
      if (!name) { fail(); return; }
      void lstat(join(dir, name), { bigint: true }).catch((err: NodeJS.ErrnoException) => {
        // FSEvents may name the watched root relative to its parent.
        if (process.platform === 'darwin' && name === basename(dir) && err.code === 'ENOENT') return lstat(dir, { bigint: true });
        throw err;
      }).then(st => {
        // Delayed creation events from before the clone finished are harmless.
        if (st.ctimeNs > since) fail();
      }, fail);
    });
    watcher.on('error', fail); watcher.on('close', fail); watcher.unref(); watchers.push(watcher);
  };
  try {
    if (process.platform !== 'linux') observe(path, true);
    else {
      // Node 22's recursive watcher also watches every file. Inotify directory watches already report file writes.
      const pending = [path];
      while (pending.length && !closed) {
        const dir = pending.pop()!;
        observe(dir, false);
        for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(dir, entry.name));
      }
    }
  } catch { fail(); }
  return stop;
}

async function acquireSource(path: string, since: bigint): Promise<Source> {
  path = resolve(path);
  const current = await stamp(path);
  const previous = sources.get(path);
  if (previous && !previous.dirty && previous.stamp === current) {
    previous.users++; await previous.ready; return previous;
  }
  previous?.invalidate();
  const source: Source = { path, stamp: current, id: ++sourceEpoch, dirty: false, users: 1,
    ready: Promise.resolve(), stop: () => {}, invalidate: () => {
      if (source.dirty) return;
      source.dirty = true; source.stop();
      if (sources.get(path) === source) sources.delete(path);
      changed(path);
    } };
  sources.set(path, source);
  source.ready = monitor(path, since, source.invalidate).then(stop => { source.stop = stop; });
  await source.ready;
  return source;
}

function releaseSource(source: Source): void {
  if (--source.users) return;
  source.stop();
  if (sources.get(source.path) === source) sources.delete(source.path);
}

function discard(path: string, record: Clone): void {
  if (record.dirty) return;
  record.dirty = true; record.stop(); releaseSource(record.source);
  if (clones.get(path) === record) clones.delete(path);
  changed(path);
}

export async function recordDependencyClone(path: string, method: CloneResult['method'], sourcePath: string): Promise<void> {
  path = resolve(path);
  const previous = clones.get(path);
  if (previous) discard(path, previous);
  totals.clear(); revision++;
  if (method === 'cp') return;
  let record: Clone | null = null;
  let source: Source | null = null;
  try {
    const marker = await mkdtemp(join(dirname(path), '.clone-proof-'));
    let since: bigint;
    try {
      const file = join(marker, 'complete');
      await writeFile(file, ''); since = (await lstat(file, { bigint: true })).ctimeNs;
    } finally { await rm(marker, { recursive: true, force: true }); }
    source = await acquireSource(sourcePath, since);
    record = { stamp: await stamp(path), dirty: false, stop: () => {}, source, shared: true };
    const clone = record;
    record.stop = await monitor(path, since, () => discard(path, clone));
    if (source.dirty || record.stamp !== await stamp(path)) discard(path, record);
    if (!record.dirty) clones.set(path, record);
  } catch {
    if (record) discard(path, record);
    else if (source) releaseSource(source);
  }
}

export async function worktreeBytes(root: string, shareDirs: string[]): Promise<number> {
  root = resolve(root);
  const started = revision;
  const exempt = new Set<string>();
  const orphans = new Set<number>();
  const stamps = new Map<string, Promise<string | null>>();
  const currentStamp = (path: string) => {
    let value = stamps.get(path);
    if (!value) { value = stamp(path).catch(() => null); stamps.set(path, value); }
    return value;
  };
  for (const [path, record] of [...clones].sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith(root + '/')) continue;
    if (record.dirty || record.stamp !== await currentStamp(path)) {
      discard(path, record);
      continue;
    }
    if (record.shared && (record.source.dirty || record.source.stamp !== await currentStamp(record.source.path))) {
      record.source.invalidate();
      record.shared = false; totals.clear(); revision++; invalidateSize(root);
    }
    if (!record.shared) {
      // Siblings still share the original source epoch; one survivor must pay for those blocks.
      const family = record.source.id;
      if (!orphans.has(family)) { orphans.add(family); continue; }
    }
    exempt.add(path);
  }
  const key = `${root}\0${shareDirs.join('\0')}`;
  if (revision !== started) return worktreeBytes(root, shareDirs);
  const hit = totals.get(key);
  if (hit && hit.revision === diskSizeRevision() && Date.now() - hit.at < 60_000) return hit.bytes;
  const measure = async (path: string, exclusions: string[]): Promise<number> => {
    if (exempt.has(path)) return 0;
    if (!exclusions.length) return dirBytes(path, 60_000);
    let entries: Dirent[];
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return dirBytes(path, 60_000); }
    const charged: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      const nested = exclusions.filter(exclusion => exclusion === child || exclusion.startsWith(child + '/'));
      if (nested.length) bytes += await measure(child, nested);
      else charged.push(child);
    }
    return bytes + await dirBytesMany(charged, 60_000);
  };
  // Only visit ancestors of warm-start's recorded artifacts, already limited by findArtifacts' depth.
  const bytes = await measure(root, [...exempt]);
  if (revision !== started) return worktreeBytes(root, shareDirs);
  totals.set(key, { at: Date.now(), bytes, revision: diskSizeRevision() });
  return bytes;
}
