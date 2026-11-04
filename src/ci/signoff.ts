import { loadConfig } from '../config.ts';
import { mainRepoRoot, repoRoot } from '../git.ts';
import { checkCommit, gateCommands } from './gate.ts';
import { GitHubError, type GitHub } from './github.ts';
import { treeDescription, VERIFIED_CONTEXT } from './guard.ts';
import { isVerified, recordVerified, treeOf } from './verified.ts';

/**
 * Posts "yardmaster/verified" on a pushed commit once its exact tree passed the repo's checks on this machine.
 * Workflows that opt in (`trust-local: true` on the guard) then skip their suite for that tree. Never signs a tree
 * that hasn't passed: unverified trees are checked first.
 */
export async function signoff(gh: GitHub, opts: { cwd: string; slug: string; sha: string; waitSeconds: number; log?: (s: string) => void }): Promise<{ ok: boolean; message: string }> {
  const log = opts.log ?? (() => undefined);
  const root = (await mainRepoRoot(opts.cwd)) ?? opts.cwd;
  const here = (await repoRoot(opts.cwd)) ?? root;
  const config = loadConfig(root);
  const commands = gateCommands(config, root);
  if (!commands.length) return { ok: false, message: 'No checks are configured (set "verify" in yardmaster.json), so there is nothing to sign off.' };
  const tree = await treeOf(here, opts.sha);
  if (!tree) return { ok: false, message: `Unknown commit ${opts.sha}` };
  if (!(await isVerified(here, tree, commands))) {
    log(`checking ${opts.sha.slice(0, 12)} first (${commands.join(' && ')})`);
    const r = await checkCommit(root, here, opts.sha, commands, config);
    if (!r.ok) return { ok: false, message: `Checks failed (\`${r.command}\`); not signing off.` };
    await recordVerified(here, tree, commands);
  }
  // The status can only be attached once GitHub has the commit, which may be a moment after `git push` returns.
  const deadline = Date.now() + opts.waitSeconds * 1000;
  for (;;) {
    const known = await gh.get(`/repos/${opts.slug}/commits/${opts.sha}`).then(() => true, () => false);
    if (known) break;
    if (Date.now() > deadline) return { ok: false, message: `GitHub doesn't have ${opts.sha.slice(0, 12)} yet. Push it, then run this again.` };
    await new Promise((r) => setTimeout(r, 2000));
  }
  try {
    await gh.post(`/repos/${opts.slug}/statuses/${opts.sha}`, {
      state: 'success',
      context: VERIFIED_CONTEXT,
      description: treeDescription(tree, `(${commands.join(' && ')})`),
    });
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) return { ok: false, message: 'Your GitHub login cannot write commit statuses on this repo.' };
    throw err;
  }
  return { ok: true, message: `Signed off ${opts.sha.slice(0, 12)}: tree ${tree.slice(0, 12)} passed ${commands.join(' && ')} on this machine.` };
}
