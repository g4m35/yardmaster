import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dirBytes } from './disk.ts';
import { cloneTree, removeFast } from './fastfs.ts';
import { yardHome } from './paths.ts';
import { clonesAreFree, lockHash } from './warmstart.ts';

/**
 * Duplicate dependency installs across every project on this machine, and a recoverable way to share them.
 * Each worktree and clone usually gets its own `npm install`, so the same 1.4 GB node_modules can exist many times.
 * Copies whose installs are provably identical can be replaced by copy-on-write clones of one of them: the
 * projects stay ordinary folders, nothing changes for any tool, and the space comes back.
 *
 * Candidates are found cheaply (same lockfiles and the package manager's own record of what's installed: npm's
 * node_modules/.package-lock.json, pnpm's .modules.yaml, Yarn's state files). Before anything is swapped, the two
 * installs are compared file by file (contents, symlink targets, executable bits); only byte-identical ones are.
 */

const INSTALL_STATE = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity'];
const SKIP_DIRS = new Set(['.git', 'Library', 'Applications', '.Trash', '.cache', '.npm', '.pnpm-store', 'Pictures', 'Music', 'Movies']);

export function defaultScanRoots(): string[] {
  const home = homedir();
  return ['dev', 'Developer', 'code', 'projects', 'src', 'work', 'repos', 'git', '.t3/worktrees', '.yardmaster/worktrees'].map((d) => join(home, d)).filter((d) => existsSync(d));
}

export interface DepsDir {
  /** The node_modules folder. */
  path: string;
  project: string;
  lock: string;
  /** Hash of the package manager's installed-state file; null when there isn't one (can't prove identity). */
  installed: string | null;
  bytes: number;
}

export interface DepsGroup {
  key: string;
  dirs: DepsDir[];
  /** Space a dedupe would return (every copy but one), assuming the copies don't already share blocks. */
  reclaimable: number;
}

export interface ScanResult {
  roots: string[];
  dirs: DepsDir[];
  total: number;
  identical: DepsGroup[];
  /** Same lockfile but different installs: reinstalling them identically would let them share too. */
  sameLock: DepsGroup[];
}

function safeDirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findNodeModules(roots: string[], maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const e of safeDirents(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === 'node_modules') {
        out.push(join(dir, e.name));
        continue; // never descend into an install
      }
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.t3' && e.name !== 'worktrees')) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

function installedHash(nodeModules: string): string | null {
  for (const f of INSTALL_STATE) {
    const p = join(nodeModules, f);
    if (existsSync(p)) return createHash('sha1').update(f).update(readFileSync(p)).digest('hex').slice(0, 16);
  }
  return null;
}

/**
 * A digest of everything in an install: every path, every file's bytes, every symlink's target. Identical lockfiles
 * and package-manager records aren't enough on their own: patched packages, postinstall scripts that generate files,
 * and native addons built under another Node version all leave them unchanged. Only byte-identical installs are
 * ever swapped, so a dedupe can never change what a project runs.
 */
/**
 * Tool caches that live in node_modules but belong to the project, not the install (Vite, Vitest, Babel, ESLint,
 * Turbo, Parcel). They differ in every project, so they're left out of the comparison and each project keeps its
 * own. Generated code such as .prisma stays in the comparison: that is real code.
 */
export const TOOL_CACHES = ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache', '.eslintcache', '.turbo', '.parcel-cache', '.tmp'];

export function contentDigest(nodeModules: string): string {
  const h = createHash('sha256');
  const skip = new Set(TOOL_CACHES);
  const walk = (dir: string, rel: string) => {
    const entries = safeDirents(dir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (rel === '' && skip.has(e.name)) continue;
      const p = join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) h.update(`l${r}\0${readlinkSync(p)}\0`);
      else if (e.isDirectory()) {
        h.update(`d${r}\0`);
        walk(p, r);
      } else if (e.isFile()) {
        const st = statSync(p);
        h.update(`f${r}\0${st.size}\0${st.mode & 0o111 ? 'x' : '-'}\0`).update(readFileSync(p));
      }
    }
  };
  walk(nodeModules, '');
  return h.digest('hex');
}

export async function scanDeps(roots: string[], opts: { maxDepth?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<ScanResult> {
  const paths = findNodeModules(roots, opts.maxDepth ?? 5);
  const dirs: DepsDir[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++]!;
      const project = dirname(p);
      dirs.push({ path: p, project, lock: lockHash(project), installed: installedHash(p), bytes: await dirBytes(p, 0) });
      opts.onProgress?.(++done, paths.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  dirs.sort((a, b) => b.bytes - a.bytes);
  const group = (key: (d: DepsDir) => string | null): DepsGroup[] => {
    const m = new Map<string, DepsDir[]>();
    for (const d of dirs) {
      const k = key(d);
      if (k) m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.entries()]
      .filter(([, ds]) => ds.length > 1)
      .map(([k, ds]) => ({ key: k, dirs: ds, reclaimable: ds.slice(1).reduce((n, d) => n + d.bytes, 0) }))
      .sort((a, b) => b.reclaimable - a.reclaimable);
  };
  const identical = group((d) => (d.installed && d.lock ? `${d.lock}:${d.installed}` : null));
  const inIdentical = new Set(identical.flatMap((g) => g.dirs.map((d) => d.path)));
  const sameLock = group((d) => (d.lock && !inIdentical.has(d.path) ? d.lock : null));
  return { roots, dirs, total: dirs.reduce((n, d) => n + d.bytes, 0), identical, sameLock };
}

// ---------- dedupe (recoverable) ----------

export interface DedupeEntry {
  path: string;
  original: string;
  from: string;
  at: number;
  /** The project's own tool caches, moved from the original into the shared copy. */
  caches?: string[];
}

function trashRoot(): string {
  return join(yardHome(), 'trash', 'dedupe');
}

function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/**
 * Replace each extra copy in a group with a copy-on-write clone of the first, keeping the original in Yardmaster's
 * trash (restorable with `ym disk --restore`) until purged. Copies on another disk, or whose native addons differ,
 * are left alone and reported.
 */
export async function dedupeGroup(g: DepsGroup, opts: { dryRun?: boolean } = {}): Promise<{ replaced: DedupeEntry[]; skipped: { path: string; why: string }[] }> {
  const replaced: DedupeEntry[] = [];
  const skipped: { path: string; why: string }[] = [];
  const [keep, ...rest] = g.dirs;
  if (!keep) return { replaced, skipped };
  let keepDigest: string | null = null;
  if (!(await clonesAreFree(dirname(keep.path)))) {
    for (const d of rest) skipped.push({ path: d.path, why: "this disk can't clone copy-on-write, so sharing wouldn't save space" });
    return { replaced, skipped };
  }
  const batch = join(trashRoot(), String(Date.now()));
  for (const d of rest) {
    if (!sameDevice(keep.path, d.path)) {
      skipped.push({ path: d.path, why: 'on a different disk, so it cannot share blocks' });
      continue;
    }
    if (installedHash(d.path) !== keep.installed || lockHash(d.project) !== keep.lock) {
      skipped.push({ path: d.path, why: 'changed since the scan' });
      continue;
    }
    // Cheap checks first; the full byte comparison only for copies that passed them.
    keepDigest ??= contentDigest(keep.path);
    if (contentDigest(d.path) !== keepDigest) {
      skipped.push({ path: d.path, why: 'its packages differ from the other copy (patched packages, generated code, or native modules built for another Node version)' });
      continue;
    }
    if (opts.dryRun) {
      replaced.push({ path: d.path, original: '', from: keep.path, at: Date.now() });
      continue;
    }
    const fresh = `${d.path}.ym-clone-${process.pid}`;
    const r = await cloneTree(keep.path, fresh);
    if (!r.ok) {
      // Without copy-on-write a "shared" copy would be a full copy: no space saved, so nothing is changed.
      skipped.push({ path: d.path, why: "this disk can't clone copy-on-write, so sharing wouldn't save space" });
      continue;
    }
    mkdirSync(batch, { recursive: true });
    if (!sameDevice(dirname(d.path), batch)) {
      removeFast(fresh, batch);
      skipped.push({ path: d.path, why: "Yardmaster's trash is on another disk, so the original couldn't be kept for undo" });
      continue;
    }
    const original = join(batch, `${replaced.length}-${basename(dirname(d.path))}-node_modules`);
    // Two renames: the project is without node_modules for microseconds, and the original stays restorable.
    renameSync(d.path, original);
    renameSync(fresh, d.path);
    // The project keeps its own caches (not the other copy's).
    const caches: string[] = [];
    for (const c of TOOL_CACHES) {
      if (!existsSync(join(original, c))) continue;
      if (existsSync(join(d.path, c))) removeFast(join(d.path, c), batch);
      renameSync(join(original, c), join(d.path, c));
      caches.push(c);
    }
    replaced.push({ path: d.path, original, from: keep.path, at: Date.now(), caches });
  }
  if (replaced.length && !opts.dryRun) writeFileSync(join(batch, 'manifest.json'), JSON.stringify(replaced, null, 2));
  return { replaced, skipped };
}

export function trashBatches(): { dir: string; at: number; entries: DedupeEntry[] }[] {
  const root = trashRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((b) => join(root, b))
    .filter((dir) => existsSync(join(dir, 'manifest.json')))
    .map((dir) => ({ dir, at: Number(basename(dir)), entries: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as DedupeEntry[] }))
    .sort((a, b) => b.at - a.at);
}

/** Put the originals of the latest dedupe back (the clones move to the trash instead). */
export function restoreLatest(): { restored: string[]; skipped: { path: string; why: string }[] } {
  const latest = trashBatches()[0];
  const restored: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  if (!latest) return { restored, skipped };
  for (const e of latest.entries) {
    if (!existsSync(e.original)) {
      skipped.push({ path: e.path, why: 'its original is no longer in the trash' });
      continue;
    }
    if (existsSync(e.path)) {
      // Caches the project built up since stay with it.
      for (const c of TOOL_CACHES) if (existsSync(join(e.path, c)) && !existsSync(join(e.original, c))) renameSync(join(e.path, c), join(e.original, c));
      removeFast(e.path, latest.dir);
    }
    renameSync(e.original, e.path);
    restored.push(e.path);
  }
  writeFileSync(join(latest.dir, 'manifest.json'), '[]');
  removeFast(latest.dir, dirname(latest.dir));
  return { restored, skipped };
}

/** Delete kept originals for good (that's when the space is actually freed). `olderThanMs` keeps recent batches. */
export function purgeDedupeTrash(olderThanMs = 0): number {
  let n = 0;
  for (const b of trashBatches()) {
    if (Date.now() - b.at < olderThanMs) continue;
    removeFast(b.dir, dirname(b.dir));
    n++;
  }
  return n;
}
