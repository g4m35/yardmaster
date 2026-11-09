import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { run, cleanEnv } from './proc.ts';
import { removeWorktreeFast } from './fastfs.ts';

export class GitError extends Error {
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    this.stderr = stderr;
  }
}

const COMMIT_MAKING = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am']);

/**
 * Commands that create commits need a name and email. Many people (and every fresh CI machine) never set one;
 * git then refuses, and the whole merge queue stalls. Use the user's identity when it exists, a neutral one if not.
 */
async function identityFor(cwd: string, args: string[]): Promise<string[]> {
  if (!COMMIT_MAKING.has(args[0] ?? '')) return [];
  const env = cleanEnv({ GIT_TERMINAL_PROMPT: '0' });
  const [name, email] = await Promise.all([
    run('git', ['config', 'user.name'], { cwd, env, timeoutMs: 10_000 }),
    run('git', ['config', 'user.email'], { cwd, env, timeoutMs: 10_000 }),
  ]);
  const out: string[] = [];
  if (name.code !== 0 || !name.stdout.trim()) out.push('-c', 'user.name=Yardmaster');
  if (email.code !== 0 || !email.stdout.trim()) out.push('-c', 'user.email=yardmaster@localhost');
  return out;
}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number; input?: string } = {}) {
  const full = [...(await identityFor(cwd, args)), ...args];
  const r = await run('git', full, { cwd, env: cleanEnv({ GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }), timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input });
  if (r.code !== 0 && !opts.allowFail) throw new GitError(args, r.stderr || r.stdout);
  return r;
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/** The main checkout for a path that may itself be a linked worktree. */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  return basename(common) === '.git' ? dirname(common) : await repoRoot(cwd);
}

/**
 * Project identity that is the same in every clone on every machine: the first root commit.
 * Falls back to a path hash for repos without commits.
 */
export async function projectIdFor(root: string): Promise<string> {
  const r = await git(root, ['rev-list', '--max-parents=0', 'HEAD'], { allowFail: true });
  const roots = r.stdout.trim().split('\n').filter(Boolean).sort();
  if (r.code === 0 && roots[0]) return `p-${roots[0].slice(0, 12)}`;
  throw new Error(`${root} has no commits yet. Make a first commit, then run this again.`);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function defaultBranch(root: string): Promise<string> {
  const remoteHead = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master', 'trunk', 'develop']) {
    if (await branchExists(root, b)) return b;
  }
  return (await currentBranch(root)) ?? 'main';
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })).code === 0;
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await gitOut(cwd, ['status', '--porcelain', '--untracked-files=all'])) === '';
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const committed = await gitOut(cwd, ['diff', '--name-only', `${base}...HEAD`]);
  // Not gitOut: trimming the output strips the leading space of a first " M path" line and corrupts that path.
  const working = (await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).stdout;
  const files = new Set(committed.split('\n').filter(Boolean));
  for (const line of working.split('\n').filter(Boolean)) {
    const p = line.slice(3).split(' -> ').pop();
    if (p) files.add(p.replace(/^"|"$/g, ''));
  }
  return [...files].sort();
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  const out = await gitOut(root, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, locked: false, prunable: false };
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line.startsWith('locked')) cur.locked = true;
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

export async function addWorktree(root: string, path: string, branch: string, startPoint: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const exists = await branchExists(root, branch);
  const args = exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint];
  // `git worktree add` takes a lock on the shared config; concurrent adds can collide, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    const r = await git(root, args, { allowFail: true });
    if (r.code === 0) return;
    if (attempt < 4 && /lock|could not lock|File exists/i.test(r.stderr)) {
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
      continue;
    }
    throw new GitError(args, r.stderr);
  }
}

/**
 * Remove a clean linked worktree. The fast path moves it to the worktree root's trash and deletes it in the
 * background (a big node_modules takes seconds to delete); anything unusual falls back to `git worktree remove`.
 */
export async function removeWorktree(root: string, path: string, opts: { expectedHead?: string; expectedBranch?: string | null; guard?: () => void } = {}): Promise<void> {
  if (!(await isClean(path))) throw new GitError(['worktree', 'remove', path], `${path} has uncommitted changes`);
  // A failed identity/lock check must not fall through to a less guarded deletion.
  removeWorktreeFast(root, path, join(dirname(dirname(path)), '.trash'), opts);
}

/** Confirms a directory is a linked worktree of `root` (and not, say, the user's main checkout). */
export function isLinkedWorktreeOf(path: string, root: string): boolean {
  const dotGit = join(path, '.git');
  if (!existsSync(dotGit)) return false;
  try {
    const content = readFileSync(dotGit, 'utf8');
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (!m) return false;
    return resolve(path, m[1]!.trim()).startsWith(resolve(root, '.git', 'worktrees') + '/');
  } catch {
    return false;
  }
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '-A']);
  // A merge resolved in favor of our side leaves no diff against HEAD but must still be concluded,
  // otherwise the same conflict reappears on the next integration attempt.
  const merging = (await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })).code === 0;
  const staged = await git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0 && !merging) return false;
  // Repo commit hooks still run: they are often the owner's only enforcement that every agent goes through.
  await git(cwd, ['commit', '-q', '-m', message]);
  return true;
}

export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await gitOut(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return out.split('\n').filter(Boolean);
}

export async function hasConflictMarkers(cwd: string, files: string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const f of files) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      if (/^<{7} |^>{7} /m.test(text)) bad.push(f);
    } catch {
      // binary or unreadable; git diff --check covers text files
    }
  }
  return bad;
}
