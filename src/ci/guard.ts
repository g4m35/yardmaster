import { GitHubError, type GitHub } from './github.ts';

/**
 * The CI guard Action. "check" decides whether this workflow run can skip its heavy jobs because this exact file
 * tree already passed this exact workflow. "record" (a final step after the jobs pass) writes down which tree passed.
 *
 * Why record instead of trusting run history: a pull request run tests the merge of the PR into its base, not the
 * PR head, so the head's tree says nothing about what passed. The record step stores the tree that was really tested
 * (as a commit status on the PR head), and the run after merging finds it through the commit's pull request.
 *
 * Opt-in "trust local": a "yardmaster/verified" status posted from a developer machine (by `ym ci signoff` after
 * local checks) also counts, if whoever posted it can write to the repo and the tree matches exactly.
 */

export interface GuardContext {
  repo: string;
  sha: string;
  event: string;
  /** The webhook payload (GITHUB_EVENT_PATH). */
  payload: { pull_request?: { head?: { sha?: string } } };
  workflowPath: string;
  runId: number;
  serverUrl: string;
}

export interface GuardInputs {
  trustLocal: boolean;
  trustedUsers: string[];
  waitSeconds: number;
  /** Poll interval while waiting for a local signoff (tests shorten it). */
  pollMs?: number;
}

export interface Decision {
  skip: boolean;
  reason: string;
  tree: string;
  url?: string;
}

interface Status {
  state: string;
  context: string;
  description: string | null;
  target_url: string | null;
  creator?: { login?: string; type?: string } | null;
}

const INTENTIONAL = new Set(['workflow_dispatch', 'schedule', 'repository_dispatch']);
export const VERIFIED_CONTEXT = 'yardmaster/verified';
const ACTIONS_BOT = 'github-actions[bot]';

export function testedContext(workflowPath: string): string {
  return `yardmaster/tested (${workflowPath.split('/').pop() ?? workflowPath})`;
}

export function treeDescription(tree: string, extra = ''): string {
  return `tree ${tree}${extra ? ` ${extra}` : ''}`.slice(0, 140);
}

function mentionsTree(s: Status, tree: string): boolean {
  return (s.description ?? '').split(/\s+/).includes(tree);
}

export function contextFromEnv(env: NodeJS.ProcessEnv, payload: GuardContext['payload']): GuardContext {
  const ref = env.GITHUB_WORKFLOW_REF ?? '';
  // "owner/repo/.github/workflows/ci.yml@refs/heads/main"
  const m = ref.match(/^[^/]+\/[^/]+\/(.+?)@/);
  return {
    repo: env.GITHUB_REPOSITORY ?? '',
    sha: env.GITHUB_SHA ?? '',
    event: env.GITHUB_EVENT_NAME ?? '',
    payload,
    workflowPath: m?.[1] ?? env.GITHUB_WORKFLOW ?? 'workflow',
    runId: Number(env.GITHUB_RUN_ID ?? 0),
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
  };
}

export async function treeFor(gh: GitHub, repo: string, sha: string): Promise<string> {
  return (await gh.get<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${sha}`)).tree.sha;
}

/** Commits whose statuses may describe this run's tree: the commit itself, the PR head, and PRs a merge came from. */
async function candidates(gh: GitHub, ctx: GuardContext): Promise<string[]> {
  const out = new Set<string>([ctx.sha]);
  const head = ctx.payload.pull_request?.head?.sha;
  if (head) out.add(head);
  if (ctx.event === 'push' || ctx.event === 'merge_group') {
    const prs = await gh.get<{ head: { sha: string } }[]>(`/repos/${ctx.repo}/commits/${ctx.sha}/pulls`).catch(() => []);
    for (const pr of prs.slice(0, 5)) out.add(pr.head.sha);
  }
  return [...out];
}

async function statusesOf(gh: GitHub, repo: string, sha: string): Promise<Status[]> {
  return gh.paginate<Status>(`/repos/${repo}/commits/${sha}/statuses`, null, {}, 300).catch(() => []);
}

export function makeTrust(gh: GitHub, repo: string, trustedUsers: string[]) {
  const cache = new Map<string, boolean>();
  const listed = new Set(trustedUsers.map((u) => u.toLowerCase()));
  return async (login: string | undefined): Promise<boolean> => {
    if (!login) return false;
    const key = login.toLowerCase();
    if (listed.size) return listed.has(key);
    if (cache.has(key)) return cache.get(key)!;
    const p = await gh.get<{ permission?: string; role_name?: string }>(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`).catch(() => null);
    const ok = !!p && (['admin', 'write'].includes(p.permission ?? '') || ['admin', 'maintain', 'write'].includes(p.role_name ?? ''));
    cache.set(key, ok);
    return ok;
  };
}

export async function decide(gh: GitHub, ctx: GuardContext, inputs: GuardInputs): Promise<Decision> {
  const tree = await treeFor(gh, ctx.repo, ctx.sha);
  if (INTENTIONAL.has(ctx.event)) return { skip: false, reason: `${ctx.event} runs are deliberate, so they always run`, tree };
  const file = ctx.workflowPath.split('/').pop()!;

  // 1. A push (or merge queue) run of this workflow already tested exactly this tree.
  const runs = await gh
    .get<{ workflow_runs: { id: number; event: string; html_url: string; head_commit?: { tree_id?: string } | null }[] }>(`/repos/${ctx.repo}/actions/workflows/${encodeURIComponent(file)}/runs`, { status: 'success', per_page: 50 })
    .catch(() => ({ workflow_runs: [] }));
  const sameTree = runs.workflow_runs.find((r) => r.id !== ctx.runId && (r.event === 'push' || r.event === 'merge_group') && r.head_commit?.tree_id === tree);
  if (sameTree) return { skip: true, reason: 'this exact file tree already passed this workflow', tree, url: sameTree.html_url };

  // 2. A recorded pass (pull request runs record the merge result they tested).
  const shas = await candidates(gh, ctx);
  const trust = makeTrust(gh, ctx.repo, inputs.trustedUsers);
  const tested = testedContext(ctx.workflowPath);
  const lookup = async (local: boolean): Promise<Decision | null> => {
    for (const sha of shas) {
      for (const s of await statusesOf(gh, ctx.repo, sha)) {
        if (s.state !== 'success' || !mentionsTree(s, tree)) continue;
        if (s.context === tested && (s.creator?.login === ACTIONS_BOT || (await trust(s.creator?.login)))) {
          return { skip: true, reason: 'this exact file tree already passed this workflow (recorded pass)', tree, url: s.target_url ?? undefined };
        }
        if (local && s.context === VERIFIED_CONTEXT && s.creator?.login !== ACTIONS_BOT && (await trust(s.creator?.login))) {
          return { skip: true, reason: `checks passed on ${s.creator?.login}'s machine for this exact file tree (trust-local)`, tree, url: s.target_url ?? undefined };
        }
      }
    }
    return null;
  };
  const found = await lookup(inputs.trustLocal);
  if (found) return found;

  // 3. Trust-local: the signoff is posted right after the push, so it may land a few seconds after this job starts.
  if (inputs.trustLocal && inputs.waitSeconds > 0) {
    const deadline = Date.now() + inputs.waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, inputs.pollMs ?? 5000));
      const again = await lookup(true);
      if (again) return again;
    }
  }
  return { skip: false, reason: 'no earlier pass of this exact file tree', tree };
}

export interface RecordResult {
  posted: boolean;
  sha: string;
  reason: string;
}

/** After the gated jobs pass: remember which tree passed, on the commit a later run will look at. */
export async function record(gh: GitHub, ctx: GuardContext): Promise<RecordResult> {
  const tree = await treeFor(gh, ctx.repo, ctx.sha);
  const target = ctx.payload.pull_request?.head?.sha ?? ctx.sha;
  try {
    await gh.post(`/repos/${ctx.repo}/statuses/${target}`, {
      state: 'success',
      context: testedContext(ctx.workflowPath),
      description: treeDescription(tree),
      target_url: `${ctx.serverUrl}/${ctx.repo}/actions/runs/${ctx.runId}`,
    });
    return { posted: true, sha: target, reason: `recorded that tree ${tree.slice(0, 12)} passed` };
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
      return { posted: false, sha: target, reason: 'the token cannot write commit statuses (a fork pull request, or the job lacks "permissions: statuses: write"); nothing recorded' };
    }
    throw err;
  }
}
