import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import { dirBytes, findArtifacts, gb } from './disk.ts';
import { cloneTree, removeFast } from './fastfs.ts';
import { run, UtilityProcessError } from './proc.ts';

/**
 * Gives a fresh worktree the installed dependencies (node_modules, vendor, target, ...) it needs, so the agent
 * starts working instead of reinstalling. Safe reuse means two things:
 * - The source must match: dependencies come from a checkout whose lockfiles are identical to the new worktree's
 *   (your checkout, or another Yardmaster worktree of the project), so an agent never runs on packages from a
 *   different lockfile without being told.
 * - The copy must be cheap and isolated: copy-on-write clones (APFS on macOS, btrfs/XFS reflinks on Linux) share
 *   disk blocks until something changes, and the agent can't touch the originals. Without copy-on-write, only
 *   folders under a size cap are copied.
 */

const cowCache = new Map<string, boolean>();

/** Whether this filesystem can clone files without copying data. Probed once per worktree root. */
async function supportsCow(dir: string): Promise<boolean> {
  if (cowCache.has(dir)) return cowCache.get(dir)!;
  mkdirSync(dir, { recursive: true });
  const probe = mkdtempSync(join(dir, '.cow-probe-'));
  writeFileSync(join(probe, 'a'), 'x');
  const args = process.platform === 'darwin' ? ['-c', join(probe, 'a'), join(probe, 'b')] : ['--reflink=always', join(probe, 'a'), join(probe, 'b')];
  const ok = (await run('cp', args, { timeoutMs: 10_000 }).catch((err) => { if (err instanceof UtilityProcessError) throw err; return { code: 1 }; })).code === 0;
  rmSync(probe, { recursive: true, force: true });
  cowCache.set(dir, ok);
  return ok;
}

/** Lockfiles that pin a dependency install. */
export const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock',
  'Podfile.lock', 'composer.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Pipfile.lock', 'mix.lock', 'pubspec.lock',
];

/** Include package roots as well as lock contents; independent nested installs must match too. */
export function lockHash(dir: string): string {
  const h = createHash('sha1');
  const excluded = new Set(['.git', 'node_modules', 'vendor', '.bundle', 'target', '.gradle', 'Pods', '.venv']);
  let found = false;
  const walk = (root: string, rel: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !excluded.has(entry.name)) walk(path, key);
      else if ((entry.isFile() || entry.isSymbolicLink()) && LOCKFILES.includes(entry.name)) {
        found = true;
        h.update(key).update('\0').update(readFileSync(path)).update('\0');
      }
    }
  };
  try { walk(dir, ''); } catch { return ''; }
  return found ? h.digest('hex').slice(0, 16) : '';
}

export interface WarmStartResult {
  cloned: { rel: string; bytes: number; method: string }[];
  skipped: { rel: string; why: string }[];
  copied: string[];
  ms: number;
  /** Where the dependencies came from. */
  source: string | null;
  /** True when dependencies were rejected because no source had matching lockfiles. */
  stale: boolean;
}

/** Other folders of the project that may hold matching dependencies, newest first (Yardmaster's own worktrees). */
export function siblingWorktrees(worktree: string, limit = 8): string[] {
  const dir = dirname(worktree);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((e) => join(dir, e))
    .filter((p) => p !== worktree && existsSync(join(p, '.git')))
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.p);
}

async function pickSource(worktree: string, sources: string[], shareDirs: string[]): Promise<{ source: string | null; stale: boolean }> {
  const want = lockHash(worktree);
  let stale = false;
  for (const s of sources) {
    if (!existsSync(s) || s === worktree) continue;
    if ((await findArtifacts(s, shareDirs, 3, { sizes: false })).length === 0) continue;
    if (want && lockHash(s) === want) return { source: s, stale: false };
    stale = true;
  }
  return { source: null, stale };
}

export async function warmStart(repoRoot: string, worktree: string, config: Config, opts: { candidates?: string[] } = {}): Promise<WarmStartResult> {
  const started = Date.now();
  const out: WarmStartResult = { cloned: [], skipped: [], copied: [], ms: 0, source: null, stale: false };
  const cfg = config.worktree;
  if (cfg.warmStart === 'clone') {
    const picked = await pickSource(worktree, [repoRoot, ...(opts.candidates ?? [])], cfg.shareDirs);
    out.stale = picked.stale;
    if (picked.stale) out.skipped.push({ rel: '*', why: 'No checkout has verifiable matching root and nested lockfiles; dependencies were not reused. Run the project setup to install them.' });
    if (picked.source) {
      out.source = picked.source;
      const dirs = await findArtifacts(picked.source, cfg.shareDirs, 3, { sizes: false });
      const cow = dirs.length ? await supportsCow(dirname(worktree)) : false;
      for (const d of dirs) {
        const target = join(worktree, d.rel);
        if (existsSync(target)) continue;
        // Even if configured: a virtualenv copy keeps pointing at (and installing into) the original environment.
        if (existsSync(join(d.path, 'pyvenv.cfg'))) {
          out.skipped.push({ rel: d.rel, why: 'Python virtual environments hard-code their location; create one per worktree with a `setup` command (for example "uv sync") instead' });
          continue;
        }
        // Size only matters when copying for real; with copy-on-write, measuring 80k files would cost more than cloning them.
        const bytes = cow ? 0 : await dirBytes(d.path, 60_000);
        if (!cow && bytes > cfg.maxPlainCopyMb * 1e6) {
          out.skipped.push({ rel: d.rel, why: `${gb(bytes)} and this disk can't clone copy-on-write` });
          continue;
        }
        const r = await cloneTree(d.path, target, { allowPlainCopy: !cow });
        if (r.ok) out.cloned.push({ rel: d.rel, bytes, method: r.method });
        else out.skipped.push({ rel: d.rel, why: `copy failed: ${r.error ?? 'unknown error'}` });
      }
    }
  }
  for (const f of cfg.copy) {
    const from = join(repoRoot, f);
    const to = join(worktree, f);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    out.copied.push(f);
  }
  out.ms = Date.now() - started;
  return out;
}

/**
 * Bring a long-lived worktree's dependencies in line with its lockfiles after they changed (the integration
 * worktree after merging a dependency update): drop the old copies (instantly, in the background) and clone
 * matching ones. Returns null when nothing needed doing.
 */
export async function refreshDeps(repoRoot: string, worktree: string, config: Config, knownHash: string | null, candidates: string[]): Promise<WarmStartResult | null> {
  const now = lockHash(worktree);
  if (knownHash !== null && knownHash === now) return null;
  const trash = join(dirname(dirname(worktree)), '.trash');
  for (const d of await findArtifacts(worktree, config.worktree.shareDirs, 3, { sizes: false })) removeFast(d.path, trash);
  return warmStart(repoRoot, worktree, config, { candidates });
}

/** Clone capability alone cannot establish how many blocks an existing dependency tree still shares. */
export async function clonesAreFree(dir: string): Promise<boolean> {
  return supportsCow(dir).catch((err) => { if (err instanceof UtilityProcessError) throw err; return false; });
}
