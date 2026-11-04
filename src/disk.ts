import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from './proc.ts';
import { git } from './git.ts';
import { removeFast } from './fastfs.ts';

/** Free space on the filesystem holding `path` (or its nearest existing parent). */
export function freeGb(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  try {
    const s = statfsSync(p);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return Infinity;
  }
}

const sizeCache = new Map<string, { at: number; bytes: number }>();

/** Disk used by a directory tree. Uses `du` (fast, handles hard links) with a JS fallback; cached for a minute. */
export async function dirBytes(path: string, maxAgeMs = 60_000, exclude: string[] = []): Promise<number> {
  const key = exclude.length ? `${path}\0${exclude.join(',')}` : path;
  const hit = sizeCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.bytes;
  let bytes = 0;
  if (!existsSync(path)) bytes = 0;
  else if (process.platform !== 'win32') {
    // BSD du (macOS) excludes with -I, GNU du with --exclude.
    const ex = exclude.flatMap((e) => (process.platform === 'darwin' ? ['-I', e] : [`--exclude=${e}`]));
    const r = await run('du', ['-sk', ...ex, path], { timeoutMs: 60_000 }).catch(() => null);
    const kb = Number(r?.stdout.trim().split(/\s+/)[0]);
    bytes = Number.isFinite(kb) ? kb * 1024 : walkBytes(path);
  } else bytes = walkBytes(path);
  sizeCache.set(key, { at: Date.now(), bytes });
  return bytes;
}

function walkBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop()!;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) for (const e of safeReaddir(p)) stack.push(join(p, e));
    else total += st.size;
  }
  return total;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export function invalidateSize(path: string): void {
  for (const k of sizeCache.keys()) if (k === path || k.startsWith(path + '/') || k.startsWith(path + '\0')) sizeCache.delete(k);
}

export interface ArtifactDir {
  path: string;
  rel: string;
  bytes: number;
}

/**
 * Regenerable build output inside a worktree: directories whose name is on the allow-list AND that git
 * ignores. Anything git tracks or would show as untracked work is never a candidate.
 */
export async function findArtifacts(worktree: string, names: string[], maxDepth = 4, opts: { sizes?: boolean } = {}): Promise<ArtifactDir[]> {
  const wanted = new Set(names);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const e of safeReaddir(dir)) {
      if (e === '.git') continue;
      const full = join(dir, e);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (wanted.has(e)) found.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(worktree, 0);
  if (!found.length) return [];
  const rels = found.map((f) => relative(worktree, f));
  const r = await git(worktree, ['check-ignore', '--no-index', '--', ...rels.map((x) => x + '/')], { allowFail: true });
  const ignored = new Set(r.stdout.split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean));
  const out: ArtifactDir[] = [];
  for (const rel of rels) {
    if (!ignored.has(rel)) continue;
    // Belt and braces: git must not track anything under it.
    const tracked = await git(worktree, ['ls-files', '--', rel], { allowFail: true });
    if (tracked.stdout.trim()) continue;
    const path = join(worktree, rel);
    out.push({ path, rel, bytes: opts.sizes === false ? 0 : await dirBytes(path, 0) });
  }
  return out;
}

export function removeArtifact(worktree: string, dir: ArtifactDir): void {
  if (!dir.path.startsWith(worktree + '/')) throw new Error(`${dir.path} is outside ${worktree}`);
  removeFast(dir.path, join(dirname(dirname(worktree)), '.trash'));
  invalidateSize(worktree);
}

export function dirOfLogs(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const f of safeReaddir(path)) {
    try {
      total += statSync(join(path, f)).size;
    } catch {
      // vanished
    }
  }
  return total;
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function gb(bytes: number): string {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
