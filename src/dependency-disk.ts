import { watch, rmSync, type FSWatcher, type Dirent } from 'node:fs';
import { lstat, readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run, UtilityProcessError } from './proc.ts';
import { dirBytes, dirBytesMany, invalidateSize, diskSizeRevision } from './disk.ts';
import type { CloneResult } from './fastfs.ts';

interface Source {
  path: string;
  stamp: string;
  id: number;
  dirty: boolean;
  changedAt?: bigint;
  uncertain: boolean;
  users: number;
  marker: string;
  ready: Promise<void>;
  stop(): void;
  invalidate(at?: bigint, uncertain?: boolean): void;
}
interface Clone {
  stamp: string;
  dirty: boolean;
  stop(): void;
  source: Source;
  shared: boolean;
  copiedAt: bigint;
}
const clones = new Map<string, Clone>();
const sources = new Map<string, Source>();
const proofs = new Set<string>();
process.once('exit', () => { for (const proof of proofs) rmSync(proof, { recursive: true, force: true }); });
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

async function monitor(path: string, since: bigint, invalidate: (at?: bigint, uncertain?: boolean) => void): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  let closed = false;
  const stop = () => { closed = true; for (const watcher of watchers.splice(0)) watcher.close(); };
  const fail = (at?: bigint, uncertain = false) => { if (!closed) { stop(); invalidate(at, uncertain); } };
  const observe = (dir: string, recursive: boolean) => {
    const watcher = watch(dir, { recursive }, (_, name) => {
      if (!name) { fail(undefined, true); return; }
      const file = join(dir, name);
      void lstat(file, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
        // FSEvents may name the watched root relative to its parent.
        if (process.platform === 'darwin' && name === basename(dir) && err.code === 'ENOENT') return lstat(dir, { bigint: true });
        if (err.code === 'ENOENT') return lstat(dirname(file), { bigint: true });
        throw err;
      }).then(st => {
        if (st.ctimeNs > since) fail(st.ctimeNs);
      }, (err: NodeJS.ErrnoException) => { fail(undefined, err.code !== 'ENOENT'); });
    });
    watcher.on('error', () => fail(undefined, true)); watcher.on('close', () => fail(undefined, true));
    watcher.unref(); watchers.push(watcher);
  };
  try {
    if (process.platform !== 'linux') observe(path, true);
    else {
      // Node 22's recursive watcher also watches every file. Directory watches already report file writes.
      const pending = [path];
      while (pending.length && !closed) {
        const dir = pending.pop()!;
        observe(dir, false);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (closed) break;
          const file = join(dir, entry.name);
          if (entry.isDirectory()) pending.push(file);
        }
      }
    }
  } catch { fail(undefined, true); }
  return stop;
}

async function verifySource(source: Source): Promise<boolean> {
  if (source.dirty) return false;
  try {
    if (source.stamp !== await stamp(source.path)) { source.invalidate(); return false; }
    // Native metadata traversal closes notification startup gaps without reading dependency file contents.
    const result = await run('find', [source.path, '-cnewer', source.marker, '-print0', '-quit'], { timeoutMs: 30_000 });
    if (result.code !== 0) { source.invalidate(undefined, true); return false; }
    const path = result.stdout.split('\0')[0];
    if (path) {
      const at = await lstat(path, { bigint: true }).then(st => st.ctimeNs, () => undefined);
      source.invalidate(at); return false;
    }
    return !source.dirty;
  } catch (err) {
    source.invalidate(undefined, (err as NodeJS.ErrnoException).code !== 'ENOENT');
    if (err instanceof UtilityProcessError) throw err;
    return false;
  }
}

async function acquireSource(path: string): Promise<Source> {
  path = resolve(path);
  const current = await stamp(path);
  const previous = sources.get(path);
  if (previous && previous.stamp === current && await verifySource(previous)) {
    previous.users++; await previous.ready; return previous;
  }
  previous?.invalidate();
  const proof = await mkdtemp(join(tmpdir(), 'yardmaster-clone-proof-'));
  proofs.add(proof);
  const marker = join(proof, 'started');
  await writeFile(marker, '');
  const since = (await lstat(marker, { bigint: true })).mtimeNs;
  const cleanup = () => { void rm(proof, { recursive: true, force: true }).then(() => proofs.delete(proof), () => {}); };
  const source: Source = { path, stamp: current, id: ++sourceEpoch, dirty: false, uncertain: false, users: 1, marker,
    ready: Promise.resolve(), stop: () => {}, invalidate: (at, uncertain = false) => {
      if (source.dirty) return;
      source.dirty = true; source.changedAt = at; source.uncertain = uncertain; source.stop(); cleanup();
      if (sources.get(path) === source) sources.delete(path);
      changed(path);
    } };
  sources.set(path, source);
  source.ready = monitor(path, since, source.invalidate).then(stop => { source.stop = () => { stop(); cleanup(); }; });
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

async function clock(parent: string): Promise<bigint> {
  const marker = await mkdtemp(join(parent, '.clone-proof-'));
  try {
    const file = join(marker, 'complete');
    await writeFile(file, '');
    return (await lstat(file, { bigint: true })).ctimeNs;
  } finally { await rm(marker, { recursive: true, force: true }); }
}

async function recordDependencyClone(path: string, source: Source, copiedAt: bigint): Promise<void> {
  let record: Clone | null = null;
  try {
    record = { stamp: await stamp(path), dirty: false, stop: () => {}, source, shared: true, copiedAt };
    const clone = record;
    record.stop = await monitor(path, copiedAt, () => discard(path, clone));
    if (!await verifySource(source) || record.stamp !== await stamp(path)) discard(path, record);
    if (!record.dirty) clones.set(path, record);
  } catch (err) {
    if (record) discard(path, record);
    else releaseSource(source);
    if (err instanceof UtilityProcessError) throw err;
  }
}

export async function cloneDependency(sourcePath: string, path: string, copy: () => Promise<CloneResult>): Promise<CloneResult> {
  path = resolve(path);
  const previous = clones.get(path);
  if (previous) discard(path, previous);
  changed(path);
  await mkdir(dirname(path), { recursive: true });
  // The source monitor must cover both copying and the target monitor's setup.
  let held: Source | null = await acquireSource(sourcePath).catch(err => {
    if (err instanceof UtilityProcessError) throw err;
    return null;
  });
  try {
    const result = await copy();
    if (result.ok && result.method !== 'cp' && held && await verifySource(held)) {
      const copiedAt = await clock(dirname(path));
      const source = held; held = null;
      await recordDependencyClone(path, source, copiedAt);
    }
    return result;
  } finally { if (held) releaseSource(held); }
}

export async function worktreeBytes(root: string, shareDirs: string[]): Promise<number> {
  root = resolve(root);
  const key = `${root}\0${shareDirs.join('\0')}`;
  const cached = totals.get(key);
  if (!cached || cached.revision !== diskSizeRevision() || Date.now() - cached.at >= 60_000) {
    const relevant = new Set([...clones].filter(([path]) => path.startsWith(root + '/')).map(([, record]) => record.source));
    for (const source of relevant) await verifySource(source);
  }
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
    if (record.source.dirty && (record.source.uncertain || (record.source.changedAt !== undefined && record.copiedAt >= record.source.changedAt))) {
      // A delayed notification can describe a write during copying; these copies cannot share an exemption cohort.
      discard(path, record); continue;
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
