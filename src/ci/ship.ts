import type { Config } from '../config.ts';
import { defaultBranch, git, revParse } from '../git.ts';
import { repoSlugFromUrl, type GitHub } from './github.ts';

/**
 * One pull request for a whole batch of finished agent work. Yardmaster already merged and checked these tasks
 * together on its integration branch, so pushing that branch costs one CI run instead of one per task: a merge
 * queue for accounts that don't have GitHub's.
 */

export interface ShipResult {
  pushed: boolean;
  url: string | null;
  created: boolean;
  tasks: string[];
  gateOutput: string;
}

export async function ship(opts: { root: string; config: Config; gh: GitHub | null; remote: string; branch?: string; base?: string; draft?: boolean; title?: string }): Promise<ShipResult> {
  const { root, config } = opts;
  const integration = config.integration.branch;
  if (!(await revParse(root, integration))) throw new Error(`Nothing to ship: ${integration} doesn't exist yet (no finished work has been merged).`);
  const base = opts.base ?? config.baseBranch ?? (await defaultBranch(root));
  const range = `${base}..${integration}`;
  const ahead = Number((await git(root, ['rev-list', '--count', range])).stdout.trim());
  if (!ahead) throw new Error(`${integration} has nothing that ${base} doesn't already have.`);
  const subjects = (await git(root, ['log', '--format=%s', range])).stdout.split('\n');
  const tasks = subjects.filter((s) => s.startsWith('yardmaster: ')).map((s) => s.slice('yardmaster: '.length));
  const url = (await git(root, ['remote', 'get-url', opts.remote])).stdout.trim();
  const slug = repoSlugFromUrl(url);
  const branch = opts.branch ?? integration;

  // The pre-push gate runs here too; the merge train already checked this tree, so it doesn't check again.
  const push = await git(root, ['push', opts.remote, `${integration}:refs/heads/${branch}`], { allowFail: true, timeoutMs: 60 * 60_000 });
  const gateOutput = push.stderr.split('\n').filter((l) => l.startsWith('Yardmaster CI')).join('\n');
  if (push.code !== 0) throw new Error(`git push failed:\n${push.stderr.trim() || push.stdout.trim()}`);

  if (!slug || !opts.gh?.authenticated) {
    const compare = slug ? `https://github.com/${slug}/compare/${base}...${branch}?expand=1` : null;
    return { pushed: true, url: compare, created: false, tasks, gateOutput };
  }
  const owner = slug.split('/')[0]!;
  const open = await opts.gh.get<{ html_url: string }[]>(`/repos/${slug}/pulls`, { head: `${owner}:${branch}`, state: 'open' });
  if (open[0]) return { pushed: true, url: open[0].html_url, created: false, tasks, gateOutput };
  const title = opts.title ?? (tasks.length === 1 ? tasks[0]!.replace(/\s+\([^)]*\)$/, '') : `Yardmaster: ${tasks.length || ahead} changes from agents`);
  const body = [
    'Finished agent work, merged and checked together by Yardmaster, shipped as one pull request so CI runs once for the batch.',
    '',
    ...(tasks.length ? tasks.map((t) => `- ${t}`) : [`${ahead} commit(s)`]),
  ].join('\n');
  const pr = await opts.gh.post<{ html_url: string }>(`/repos/${slug}/pulls`, { title, head: branch, base, body, draft: !!opts.draft });
  return { pushed: true, url: pr.html_url, created: true, tasks, gateOutput };
}
