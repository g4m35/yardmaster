import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { run, spawnDetached } from './proc.ts';

/**
 * File work that scales with folder size, done the fast way:
 * - Clone a whole folder in one step. On macOS (APFS) a single clonefile(2) call copies a 79k-file node_modules in
 *   about 1 to 2.7 s; `cp -cR` copies file by file (11.8 s), Node's fs.cp takes 25 s. Node can't call clonefile,
 *   but macOS's built-in JavaScript for Automation can, with nothing to install (0.13 s to start).
 * - Delete by moving aside, then removing in the background. Deleting that node_modules takes about 7 s; a rename
 *   is instant, so nothing waits on it. Anything still in the trash at startup is purged.
 */

const JXA_CLONE = `function run(argv) {
  ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'unsigned int']]);
  return String($.clonefile(argv[0], argv[1], 0));
}`;

export interface CloneResult {
  ok: boolean;
  method: 'clonefile' | 'cp-clone' | 'cp-reflink' | 'cp';
  ms: number;
  error?: string;
}

/** Copy `src` (a directory) to `dst`, which must not exist yet, as cheaply as the filesystem allows. */
export async function cloneTree(src: string, dst: string, opts: { allowPlainCopy?: boolean } = {}): Promise<CloneResult> {
  const started = Date.now();
  mkdirSync(dirname(dst), { recursive: true });
  if (process.platform === 'darwin') {
    const r = await run('osascript', ['-l', 'JavaScript', '-e', JXA_CLONE, src, dst], { timeoutMs: 5 * 60_000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout.trim() === '0') return { ok: true, method: 'clonefile', ms: Date.now() - started };
    // clonefile refuses across volumes and on non-APFS disks; a partial result is never left behind by it, but be sure.
    rmSync(dst, { recursive: true, force: true });
    const cp = await run('cp', ['-cR', src, dst], { timeoutMs: 10 * 60_000 }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
    if (cp.code === 0) return { ok: true, method: 'cp-clone', ms: Date.now() - started };
    rmSync(dst, { recursive: true, force: true });
    if (!opts.allowPlainCopy) return { ok: false, method: 'cp-clone', ms: Date.now() - started, error: cp.stderr.trim().slice(0, 200) };
  } else {
    const args = opts.allowPlainCopy ? ['-R', '--reflink=auto', src, dst] : ['-R', '--reflink=always', src, dst];
    const cp = await run('cp', args, { timeoutMs: 10 * 60_000 }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
    if (cp.code === 0) return { ok: true, method: opts.allowPlainCopy ? 'cp' : 'cp-reflink', ms: Date.now() - started };
    rmSync(dst, { recursive: true, force: true });
    return { ok: false, method: 'cp-reflink', ms: Date.now() - started, error: cp.stderr.trim().slice(0, 200) };
  }
  const cp = await run('cp', ['-R', src, dst], { timeoutMs: 10 * 60_000 }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
  if (cp.code === 0) return { ok: true, method: 'cp', ms: Date.now() - started };
  rmSync(dst, { recursive: true, force: true });
  return { ok: false, method: 'cp', ms: Date.now() - started, error: cp.stderr.trim().slice(0, 200) };
}

function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** Move `path` into `trash` (same disk, so it's a rename) and delete it in the background. Falls back to a plain delete. */
export function removeFast(path: string, trash: string): void {
  if (!existsSync(path)) return;
  mkdirSync(trash, { recursive: true });
  if (!sameDevice(dirname(path), trash)) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  const target = join(trash, `${basename(path)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
  try {
    renameSync(path, target);
  } catch {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  purgeLater(target);
}

function purgeLater(target: string): void {
  if (process.env.YARDMASTER_SYNC_DELETE) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  // A detached, low-priority `rm` keeps going even if Yardmaster exits, and never blocks its event loop.
  const nice = process.platform === 'win32' ? null : 'nice';
  try {
    const child = nice ? spawnDetached(nice, ['-n', '10', 'rm', '-rf', target], { stdio: 'ignore' }) : spawnDetached('cmd', ['/c', 'rmdir', '/s', '/q', target], { stdio: 'ignore' });
    child.on('error', () => rmSync(target, { recursive: true, force: true }));
    child.unref();
  } catch {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Delete whatever a previous run left in the trash (it was killed, or the machine slept mid-delete). */
export function purgeTrash(trash: string): number {
  if (!existsSync(trash)) return 0;
  let n = 0;
  for (const e of readdirSync(trash)) {
    purgeLater(join(trash, e));
    n++;
  }
  return n;
}

/**
 * Remove a linked git worktree instantly: move its folder to the trash, then remove only its own entry under
 * .git/worktrees (not `git worktree prune`, which would also forget other tools' worktrees that are merely missing,
 * say on an unplugged drive). Callers must already have checked it's clean and merged.
 */
export function removeWorktreeFast(repoRoot: string, worktree: string, trash: string): void {
  const dotGit = join(worktree, '.git');
  let admin: string | null = null;
  try {
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (m) admin = resolve(worktree, m[1]!.trim());
  } catch {
    // not a linked worktree
  }
  const adminRoot = resolve(repoRoot, '.git', 'worktrees') + '/';
  if (!admin || !admin.startsWith(adminRoot)) throw new Error(`${worktree} is not a linked worktree of ${repoRoot}`);
  removeFast(worktree, trash);
  rmSync(admin, { recursive: true, force: true });
}
