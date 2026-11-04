import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import { findArtifacts, gb } from './disk.ts';
import { run } from './proc.ts';

/**
 * Gives a fresh worktree what the main checkout already has installed (node_modules, .venv, target, ...), so the
 * agent starts working instead of reinstalling. Uses copy-on-write clones (APFS on macOS, btrfs/XFS reflinks on
 * Linux): instant, no extra disk until something changes, and the agent can't touch the originals. Without
 * copy-on-write it copies only folders under a size cap.
 */

const cowCache = new Map<string, boolean>();

/** Whether this filesystem can clone files without copying data. Probed once per worktree root. */
async function supportsCow(dir: string): Promise<boolean> {
  if (cowCache.has(dir)) return cowCache.get(dir)!;
  mkdirSync(dir, { recursive: true });
  const probe = mkdtempSync(join(dir, '.cow-probe-'));
  writeFileSync(join(probe, 'a'), 'x');
  const args = process.platform === 'darwin' ? ['-c', join(probe, 'a'), join(probe, 'b')] : ['--reflink=always', join(probe, 'a'), join(probe, 'b')];
  const ok = (await run('cp', args, { timeoutMs: 10_000 }).catch(() => ({ code: 1 }))).code === 0;
  rmSync(probe, { recursive: true, force: true });
  cowCache.set(dir, ok);
  return ok;
}

export interface WarmStartResult {
  cloned: { rel: string; bytes: number }[];
  skipped: { rel: string; why: string }[];
  copied: string[];
  ms: number;
}

export async function warmStart(repoRoot: string, worktree: string, config: Config): Promise<WarmStartResult> {
  const started = Date.now();
  const out: WarmStartResult = { cloned: [], skipped: [], copied: [], ms: 0 };
  const cfg = config.worktree;
  if (cfg.warmStart === 'clone') {
    const dirs = await findArtifacts(repoRoot, cfg.shareDirs, 3);
    const cow = dirs.length ? await supportsCow(dirname(worktree)) : false;
    for (const d of dirs) {
      const target = join(worktree, d.rel);
      if (existsSync(target)) continue;
      // Even if configured: a virtualenv copy keeps pointing at (and installing into) the original environment.
      if (existsSync(join(d.path, 'pyvenv.cfg'))) {
        out.skipped.push({ rel: d.rel, why: 'Python virtual environments hard-code their location; create one per worktree with a `setup` command (for example "uv sync") instead' });
        continue;
      }
      if (!cow && d.bytes > cfg.maxPlainCopyMb * 1e6) {
        out.skipped.push({ rel: d.rel, why: `${gb(d.bytes)} and this disk can't clone copy-on-write` });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const args = process.platform === 'darwin' ? (cow ? ['-cR', d.path, target] : ['-R', d.path, target]) : ['-R', '--reflink=auto', d.path, target];
      const r = await run('cp', args, { timeoutMs: 10 * 60_000 }).catch((err: Error) => ({ code: 1, stderr: err.message, stdout: '' }));
      if (r.code === 0) out.cloned.push({ rel: d.rel, bytes: d.bytes });
      else {
        rmSync(target, { recursive: true, force: true });
        out.skipped.push({ rel: d.rel, why: `copy failed: ${r.stderr.trim().slice(0, 120)}` });
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

/** Whether folders cloned into worktrees under `dir` share disk blocks with the originals (so don't count them). */
export async function clonesAreFree(dir: string): Promise<boolean> {
  return supportsCow(dir).catch(() => false);
}
