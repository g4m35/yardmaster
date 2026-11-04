import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git.ts';
import { sha1 } from '../text.ts';

/**
 * File trees whose checks passed on this machine, keyed by tree hash and the exact commands that ran. Lives in the
 * repo's shared git directory, so every worktree (and every agent) sees it, and a re-push of the same files, a
 * rebase that changes nothing, or Yardmaster's already-checked merge train never runs the checks twice.
 */

export function commandsKey(commands: string[]): string {
  return sha1(commands.join('\n')).slice(0, 12);
}

async function ledger(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  return r.code === 0 ? join(r.stdout.trim(), 'yardmaster-verified') : null;
}

export async function treeOf(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isVerified(cwd: string, tree: string, commands: string[]): Promise<boolean> {
  const f = await ledger(cwd);
  if (!f || !existsSync(f)) return false;
  const want = `${tree} ${commandsKey(commands)} `;
  return readFileSync(f, 'utf8').split('\n').some((l) => l.startsWith(want));
}

export async function recordVerified(cwd: string, tree: string, commands: string[]): Promise<void> {
  if (!commands.length) return;
  const f = await ledger(cwd);
  if (!f) return;
  appendFileSync(f, `${tree} ${commandsKey(commands)} ${Date.now()}\n`);
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  if (lines.length > 4000) writeFileSync(f, lines.slice(-2000).join('\n') + '\n');
}

/** For Yardmaster's own runner and merge queue: remember a checked commit without failing the caller. */
export async function rememberChecked(cwd: string, commit: string, commands: string[]): Promise<void> {
  try {
    const tree = await treeOf(cwd, commit);
    if (tree) await recordVerified(cwd, tree, commands);
  } catch {
    // Only an optimization for later pushes.
  }
}
