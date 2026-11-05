import { GitHubError, type GitHub } from './github.ts';

/**
 * The CI guard Action. "check" decides whether this workflow run can skip its heavy jobs because this exact file
 * tree already passed this exact workflow. "record" (a final step after the jobs pass) writes down which tree passed.
 *
 * Why record instead of trusting run history: a pull request run tests the merge of the PR into its base, not the
 * PR head, so the head's tree says nothing about what passed. The record step stores the tree that was really tested
 * (as a commit status on the PR head), and the run after merging finds it through the commit's pull request.
 *
 * A status is only a claim, and anything holding `statuses: write` can post one. So a recorded pass counts only when
 * the run it points to backs it up: a run of this same workflow file, for the commit the status is on, in which every
 * job had passed (none skipped, failed or unfinished) by the time the status was posted. A run that skipped its own
 * suite therefore can't vouch for anything, and neither can a person or another workflow.
 *
 * Opt-in "trust local": a "yardmaster/verified" status posted from a developer machine (by `ym ci signoff` after
 * local checks) also counts, if a login named in `trusted-users` posted it and the tree matches exactly.
 */

export interface GuardContext {
  repo: string;
  sha: string;
  event: string;
  /** The webhook payload (GITHUB_EVENT_PATH). */
  payload: { pull_request?: { number?: number; head?: { sha?: string }; base?: { ref?: string } }; after?: string; head_commit?: { tree_id?: string } | null };
  /** GITHUB_REF: the branch a push landed on. */
  ref?: string;
  workflowPath: string;
  runId: number;
  serverUrl: string;
}

export interface GuardInputs {
  trustLocal: boolean;
  trustedUsers: string[];
  waitSeconds: number;
  /** Jobs that may be skipped in a recorded run without voiding it (say, a deploy job that only runs on main). */
  allowSkipped?: string[];
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
  created_at?: string;
  creator?: { login?: string; type?: string } | null;
}

interface Run {
  id: number;
  event: string;
  path?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  run_started_at?: string;
  html_url: string;
  repository?: { full_name?: string };
  head_commit?: { tree_id?: string } | null;
  /** The open pull requests GitHub links to this run (empty once they close, and for forks). */
  pull_requests?: { number: number; base?: { ref?: string; repo?: { url?: string } } }[];
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** Events whose GITHUB_SHA is the code under test. Others (pull_request_target, workflow_run, ...) test main's sha. */
export const GUARDED_EVENTS = new Set(['push', 'pull_request', 'merge_group']);
export const VERIFIED_CONTEXT = 'yardmaster/verified';
const ACTIONS_BOT = 'github-actions[bot]';
/** Upper bound on candidates checked against their runs, per kind and decision (each costs one or two API reads). */
const MAX_VALIDATIONS = 3;

export function testedContext(workflowPath: string): string {
  return `yardmaster/tested (${workflowPath.split('/').pop() ?? workflowPath})`;
}

export function treeDescription(tree: string, extra = ''): string {
  return `tree ${tree}${extra ? ` ${extra}` : ''}`.slice(0, 140);
}

function mentionsTree(s: Status, tree: string): boolean {
  return (s.description ?? '').split(/\s+/).includes(tree);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The run id in a link to a run of this repo, or null for anything else. */
export function runIdFromUrl(url: string | null | undefined, serverUrl: string, repo: string): number | null {
  const m = (url ?? '').match(new RegExp(`^${escapeRe(serverUrl.replace(/\/+$/, ''))}/${escapeRe(repo)}/actions/runs/(\\d+)$`, 'i'));
  return m ? Number(m[1]) : null;
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
    ref: env.GITHUB_REF,
  };
}

export async function treeFor(gh: GitHub, repo: string, sha: string): Promise<string> {
  return (await gh.get<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${sha}`)).tree.sha;
}

/** A push's payload already names its tree, which saves a lookup on the most common skip path. */
function knownTree(ctx: GuardContext): string | undefined {
  return ctx.event === 'push' && ctx.payload.after === ctx.sha ? ctx.payload.head_commit?.tree_id || undefined : undefined;
}

async function statusesOf(gh: GitHub, repo: string, sha: string): Promise<Status[]> {
  return gh.paginate<Status>(`/repos/${repo}/commits/${sha}/statuses`, null, {}, 300).catch(() => []);
}

const baseName = (job: string) => job.replace(/ \(.*\)$/, '');

/**
 * Every job of the run had passed by `before` (ms), except at most one that finished later or is still going: the job
 * that posted the status. That one must have started after all the others finished, as a job that needs them all
 * does, so a test job still running can't stand in for it. Skipped jobs void the run, unless listed in `allowSkipped`.
 */
async function jobsPassed(gh: GitHub, repo: string, runId: number, before: number, allowSkipped: Set<string>): Promise<boolean> {
  const jobs = await gh.paginate<Job>(`/repos/${repo}/actions/runs/${runId}/jobs`, 'jobs', { filter: 'latest' }, 500).catch(() => null);
  if (!jobs?.length) return false;
  const open: Job[] = [];
  let lastDone = 0;
  for (const j of jobs) {
    if (j.conclusion === 'skipped' && allowSkipped.has(baseName(j.name))) continue;
    const done = j.status === 'completed' && !!j.completed_at && Date.parse(j.completed_at) <= before;
    if (done && j.conclusion !== 'success') return false;
    if (done) lastDone = Math.max(lastDone, Date.parse(j.completed_at!));
    else open.push(j);
  }
  if (open.length > 1) return false;
  const last = open[0];
  if (!last) return true;
  if (last.status === 'completed' && last.conclusion !== 'success') return false;
  return Date.parse(last.started_at ?? '') >= lastDone;
}

/**
 * Which pull request and base this run's pass must come from, when that can be known. A pull request run uses the
 * workflow file of its merge with the base, so a run of a pull request into some other branch may have run any
 * workflow at all: it vouches for nothing here.
 */
function expectedBase(ctx: GuardContext): { number?: number; ref: string } | null {
  if (ctx.event === 'pull_request') {
    const pr = ctx.payload.pull_request;
    return pr?.base?.ref ? { number: pr.number, ref: pr.base.ref } : null;
  }
  const branch = ctx.ref?.startsWith('refs/heads/') ? ctx.ref.slice('refs/heads/'.length) : null;
  return branch ? { ref: branch } : null;
}

function sameBase(run: Run, ctx: GuardContext): boolean {
  const want = expectedBase(ctx);
  const linked = run.pull_requests ?? [];
  const ours = (p: (typeof linked)[number]) =>
    (p.base?.repo?.url ?? '').toLowerCase().endsWith(`/repos/${ctx.repo.toLowerCase()}`) && p.base?.ref === want?.ref && (want?.number === undefined || p.number === want.number);
  // While a pull request is open GitHub links its runs to it, so a pull request run must show it's this one.
  if (ctx.event === 'pull_request') return !!want && linked.some(ours);
  // After a merge the link is gone. A run still linked to an open pull request into another branch is a decoy.
  return !linked.length || (!!want && linked.some(ours));
}

/** The run behind a recorded pass, if it really backs the claim; null otherwise. */
async function backingRun(gh: GitHub, ctx: GuardContext, s: Status, onSha: string, tree: string, allowSkipped: Set<string>): Promise<Run | null> {
  const id = runIdFromUrl(s.target_url, ctx.serverUrl, ctx.repo);
  const posted = Date.parse(s.created_at ?? '');
  if (!id || id === ctx.runId || !Number.isFinite(posted)) return null;
  const run = await gh.get<Run>(`/repos/${ctx.repo}/actions/runs/${id}`).catch(() => null);
  if (!run) return null;
  if ((run.repository?.full_name ?? '').toLowerCase() !== ctx.repo.toLowerCase()) return null;
  if (run.path !== ctx.workflowPath || !GUARDED_EVENTS.has(run.event) || run.head_sha !== onSha) return null;
  if (!(posted >= Date.parse(run.run_started_at ?? ''))) return null;
  if (run.status === 'completed' && run.conclusion !== 'success') return null;
  // A push or merge queue run tests its own commit, whose tree GitHub reports: the claim must be that tree.
  if (run.event !== 'pull_request' && run.head_commit?.tree_id !== tree) return null;
  if (run.event === 'pull_request' && !sameBase(run, ctx)) return null;
  return (await jobsPassed(gh, ctx.repo, id, posted, allowSkipped)) ? run : null;
}

/** Who may sign off locally: only logins the workflow names. Bots never count; they aren't someone's machine. */
export function makeTrust(trustedUsers: string[]) {
  const listed = new Set(trustedUsers.map((u) => u.toLowerCase()).filter((u) => !u.endsWith('[bot]')));
  return (login: string | undefined): boolean => !!login && !login.toLowerCase().endsWith('[bot]') && listed.has(login.toLowerCase());
}

export async function decide(gh: GitHub, ctx: GuardContext, inputs: GuardInputs): Promise<Decision> {
  const guarded = GUARDED_EVENTS.has(ctx.event);
  const file = ctx.workflowPath.split('/').pop()!;
  const runsOf = (query: Record<string, string | number>) =>
    gh.get<{ workflow_runs: Run[] }>(`/repos/${ctx.repo}/actions/workflows/${encodeURIComponent(file)}/runs`, { status: 'success', ...query }).then((r) => r.workflow_runs, () => [] as Run[]);
  const head = ctx.payload.pull_request?.head?.sha;
  const wantsLocal = inputs.trustLocal && inputs.trustedUsers.length > 0;

  // Everything this decision may need, at once: one round trip in the common case.
  const [tree, pushRuns, queueRuns, sameShaRuns, prHeads, headTree] = await Promise.all([
    knownTree(ctx) ?? treeFor(gh, ctx.repo, ctx.sha),
    guarded ? runsOf({ event: 'push', per_page: 50 }) : [],
    // Merge queue runs test their own commit too; the same tree may come back under another sha.
    guarded ? runsOf({ event: 'merge_group', per_page: 20 }) : [],
    ctx.event === 'push' || ctx.event === 'merge_group' ? runsOf({ head_sha: ctx.sha, per_page: 20 }) : [],
    ctx.event === 'push' || ctx.event === 'merge_group'
      ? gh.get<{ head: { sha: string } }[]>(`/repos/${ctx.repo}/commits/${ctx.sha}/pulls`).then((p) => p.slice(0, 5).map((x) => x.head.sha), () => [] as string[])
      : [],
    wantsLocal && head ? treeFor(gh, ctx.repo, head).catch(() => '') : '',
  ]);
  if (!guarded) return { skip: false, reason: `${ctx.event || 'this'} runs always run (the guard only skips push, pull_request and merge_group runs)`, tree };

  const shas = [...new Set([ctx.sha, ...(head ? [head] : []), ...prHeads])];
  const allowSkipped = new Set(inputs.allowSkipped ?? []);
  const statusesP = Promise.all(shas.map((sha) => statusesOf(gh, ctx.repo, sha)));
  let runChecks = 0;
  let statusChecks = 0;
  let rejected = false;

  // 1. A push (or merge queue) run of this workflow already tested exactly this tree, and really ran its jobs.
  const sameTree = [...pushRuns, ...queueRuns, ...sameShaRuns].filter((r) => r.id !== ctx.runId && (r.event === 'push' || r.event === 'merge_group') && r.head_commit?.tree_id === tree);
  for (const r of [...new Map(sameTree.map((r) => [r.id, r])).values()]) {
    if (runChecks++ >= MAX_VALIDATIONS) break;
    if (await jobsPassed(gh, ctx.repo, r.id, Infinity, allowSkipped)) return { skip: true, reason: 'this exact file tree already passed this workflow', tree, url: r.html_url };
    rejected = true;
  }

  // 2. A recorded pass (pull request runs record the merge result they tested), backed by its run.
  const tested = testedContext(ctx.workflowPath);
  const trust = makeTrust(inputs.trustedUsers);
  const lookup = async (lists: Status[][], local: boolean): Promise<Decision | null> => {
    for (let i = 0; i < lists.length; i++) {
      for (const s of lists[i]!) {
        if (s.state !== 'success' || !mentionsTree(s, tree)) continue;
        if (s.context === tested && s.creator?.login === ACTIONS_BOT) {
          if (statusChecks++ >= MAX_VALIDATIONS) continue;
          const run = await backingRun(gh, ctx, s, shas[i]!, tree, allowSkipped);
          if (run) return { skip: true, reason: 'this exact file tree already passed this workflow (recorded pass)', tree, url: run.html_url };
          rejected = true;
        }
        if (local && s.context === VERIFIED_CONTEXT && trust(s.creator?.login)) {
          return { skip: true, reason: `checks passed on ${s.creator?.login}'s machine for this exact file tree (trust-local)`, tree };
        }
      }
    }
    return null;
  };
  const found = await lookup(await statusesP, wantsLocal);
  if (found) return found;

  // 3. Trust-local: the signoff is posted right after the push, so it may land a few seconds after this job starts.
  // A signoff carries its own commit's tree, so wait only on a commit whose tree is the one under test.
  const signable = ctx.event === 'pull_request' ? (head && headTree === tree ? head : null) : ctx.sha;
  if (wantsLocal && signable && inputs.waitSeconds > 0) {
    const deadline = Date.now() + inputs.waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, inputs.pollMs ?? 5000));
      const again = await lookup([await statusesOf(gh, ctx.repo, signable)], true);
      if (again) return again;
    }
  }
  const why = rejected ? 'an earlier pass of this tree was found, but its run skipped or failed jobs, so it does not count' : 'no earlier pass of this exact file tree';
  const local = inputs.trustLocal && !inputs.trustedUsers.length ? ' (trust-local is on but ignored: it needs trusted-users)' : '';
  return { skip: false, reason: `${why}${local}`, tree };
}

export interface RecordResult {
  posted: boolean;
  sha: string;
  reason: string;
}

/** After the gated jobs pass: remember which tree passed, on the commit a later run will look at. */
export async function record(gh: GitHub, ctx: GuardContext): Promise<RecordResult> {
  const target = ctx.payload.pull_request?.head?.sha ?? ctx.sha;
  // Other events test some other commit than GITHUB_SHA, so their tree would be the wrong one to vouch for.
  if (!GUARDED_EVENTS.has(ctx.event)) return { posted: false, sha: target, reason: `${ctx.event || 'this'} runs are never recorded` };
  const tree = knownTree(ctx) ?? (await treeFor(gh, ctx.repo, ctx.sha));
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
