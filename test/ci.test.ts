import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, sh, tempDir } from './helpers.ts';
import { runnerKind, jobCost, billedMinutes } from '../src/ci/cost.ts';
import { analyze } from '../src/ci/analyze.ts';
import type { RepoHistory, RunRec, JobRec } from '../src/ci/history.ts';
import { lintWorkflow } from '../src/ci/workflows.ts';
import { createGitHub } from '../src/ci/github.ts';
import { decide, record, testedContext, type GuardContext } from '../src/ci/guard.ts';
import { computeBudget, currentMonth, verdict, writeBudget } from '../src/ci/budget.ts';
import { loadJobs } from '../src/ci/history.ts';
import { parsePushInput, runGate } from '../src/ci/gate.ts';
import { installGateHook, uninstallGateHook } from '../src/ci/hookfile.ts';
import { rememberChecked } from '../src/ci/verified.ts';
import { ship } from '../src/ci/ship.ts';
import { loadConfig } from '../src/config.ts';
import { repoSlugFromUrl } from '../src/ci/github.ts';

/** CI cost control: cost model, audit, workflow advice, the guard Action, the budget, the push gate, ship. */

// Every GitHub call in this file goes to a local mock; no real token or network is ever used.
process.env.GH_TOKEN = 'test-token';
process.env.YM_CI_NO_BACKGROUND = '1';

type Handler = (req: IncomingMessage, body: unknown, url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function mockGitHub(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const key = `${req.method} ${url.pathname}`;
      calls.push(key);
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.method === 'POST') posts.push({ path: url.pathname, body });
      assert.equal(req.headers.authorization, 'Bearer test-token');
      const h = routes[key];
      const r = h ? h(req, body, url) : undefined;
      if (!r) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, calls, posts, gh: createGitHub('test-token', { base, retryDelayMs: 1 }) };
}

// ---------- cost model ----------

test('runner labels map to GitHub rates; rounding is per job', () => {
  assert.equal(runnerKind(['ubuntu-latest']), 'linux');
  assert.equal(runnerKind(['ubuntu-24.04']), 'linux');
  assert.equal(runnerKind(['ubuntu-24.04-arm']), 'linux-arm');
  assert.equal(runnerKind(['ubuntu-slim']), 'linux-slim');
  assert.equal(runnerKind(['macos-15']), 'macos');
  assert.equal(runnerKind(['macos-latest-xlarge']), 'macos-xlarge');
  assert.equal(runnerKind(['macos-15-large']), 'macos-large');
  assert.equal(runnerKind(['xcode-27']), 'macos');
  assert.equal(runnerKind(['windows-2025-vs2026']), 'windows');
  assert.equal(runnerKind(['windows-11-vs2026-arm']), 'windows-arm');
  assert.equal(runnerKind(['windows-11-arm']), 'windows-arm');
  assert.equal(runnerKind(['windows-2025']), 'windows');
  assert.equal(runnerKind(['self-hosted', 'linux']), 'other');
  assert.equal(runnerKind(['blacksmith-2vcpu-ubuntu-2404']), 'other');
  const job = (sec: number, labels = ['ubuntu-latest']) => ({ labels, startedAt: '2026-11-01T00:00:00Z', completedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + sec * 1000).toISOString() });
  assert.equal(billedMinutes(job(61)), 2);
  assert.equal(billedMinutes(job(60)), 1);
  assert.equal(billedMinutes(job(0)), 0);
  assert.equal(jobCost(job(61), true).usd, 0.012);
  assert.equal(jobCost(job(61), false).usd, 0, 'standard runners are free in public repos');
  assert.equal(jobCost(job(30, ['macos-latest']), true).usd, 0.062);
  assert.equal(jobCost(job(600, ['self-hosted']), true).usd, 0);
});

// ---------- audit analysis ----------

function fixtureHistory(): RepoHistory {
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const m = 60_000;
  const run = (id: number, p: Partial<RunRec>): RunRec => ({ id, workflow: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request', branch: 'feat', sha: `s${id}`, tree: `t${id}`, status: 'completed', conclusion: 'success', actor: 'dev', createdAt: t0, updatedAt: t0 + 5 * m, url: '', ...p });
  const jobs = (runId: number, start: number, minutesEach: number[], labels = ['ubuntu-latest']): JobRec[] =>
    minutesEach.map((mm, i) => ({ runId, name: `j${i}`, labels, startedAt: new Date(start).toISOString(), completedAt: new Date(start + mm * m).toISOString(), conclusion: 'success' }));
  const runs = [
    run(1, { tree: 'TA', createdAt: t0, updatedAt: t0 + 5 * m }),
    run(2, { event: 'push', branch: 'main', tree: 'TA', createdAt: t0 + 10 * m, updatedAt: t0 + 15 * m }), // re-tests TA
    run(3, { tree: 'TC', conclusion: 'failure', createdAt: t0 + 20 * m, updatedAt: t0 + 30 * m }), // fails, then outdated
    run(4, { sha: 'D', tree: 'TD', createdAt: t0 + 25 * m, updatedAt: t0 + 27 * m }),
    run(5, { event: 'push', sha: 'D', tree: 'TD', createdAt: t0 + 26 * m, updatedAt: t0 + 28 * m }), // same commit twice
    run(6, { event: 'dynamic', workflow: 'npm in /', path: '', actor: 'dependabot[bot]', branch: 'dependabot/npm/x' }),
    run(7, { event: 'schedule', branch: 'main', tree: 'TA', createdAt: t0 + 40 * m, updatedAt: t0 + 45 * m }), // deliberate
    run(8, { branch: 'claude/fix-login', tree: 'TZ', createdAt: t0 + 50 * m, updatedAt: t0 + 52 * m }),
  ];
  const jobMap = new Map<number, JobRec[]>([
    [1, jobs(1, t0, [3.5, 3.5])],
    [2, jobs(2, t0 + 10 * m, [4])],
    [3, jobs(3, t0 + 20 * m, [10])],
    [4, jobs(4, t0 + 25 * m, [2])],
    [5, jobs(5, t0 + 26 * m, [2])],
    [6, jobs(6, t0, [1])],
    [7, jobs(7, t0 + 40 * m, [4])],
    [8, jobs(8, t0 + 50 * m, [1.5], ['self-hosted'])],
  ]);
  return { repo: 'acme/app', private: true, defaultBranch: 'main', since: t0, runs, jobs: jobMap };
}

test('audit finds re-tested trees, failures, outdated runs, duplicates and rounding', () => {
  const a = analyze(fixtureHistory(), 30);
  assert.equal(a.runs, 8);
  assert.deepEqual([a.retested.runs, a.retested.minutes], [1, 4], 'the push to main re-tested tree TA');
  assert.deepEqual([a.failed.runs, a.failed.minutes], [1, 10]);
  assert.deepEqual([a.superseded.runs, a.superseded.minutes], [1, 10], 'run 3 was still going when commit D was pushed');
  assert.deepEqual([a.duplicate.runs, a.duplicate.minutes], [1, 2], 'commit D ran on push and pull_request');
  assert.deepEqual([a.avoidable.runs, a.avoidable.minutes], [3, 16], 'each avoidable run counted once');
  assert.equal(a.dependabot.runs, 1);
  assert.equal(a.agentBranches.runs, 1);
  assert.equal(a.otherRunnerJobs, 1, 'self-hosted job is not billed by GitHub');
  // 3.5 + 3.5 round to 4 + 4: one minute of rounding there.
  assert.equal(a.rounding.minutes, 1);
  assert.equal(a.minutes, 8 + 4 + 10 + 2 + 2 + 1 + 4);
  assert.ok(Math.abs(a.usd - a.minutes * 0.006) < 1e-9);
  assert.equal(a.workflows[0]!.retestedMinutes, 4);
});

// ---------- workflow advice ----------

test('workflow lint flags what wastes minutes and stays quiet on a tuned workflow', () => {
  const wasteful = `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
  const codes = lintWorkflow({ path: '.github/workflows/ci.yml', text: wasteful }).map((f) => f.code).sort();
  assert.deepEqual(codes, ['double-trigger', 'drafts', 'no-cancel', 'no-guard', 'no-timeout', 'pricey-os-on-pr']);

  const tuned = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency:
  group: ci-\${{ github.head_ref || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  guard:
    runs-on: ubuntu-slim
    timeout-minutes: 5
    steps:
      - id: guard
        uses: g4m35/yardmaster@v0.4.0
  test:
    needs: guard
    if: needs.guard.outputs.skip != 'true' && github.event.pull_request.draft != true
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
  assert.deepEqual(lintWorkflow({ path: '.github/workflows/ci.yml', text: tuned }), []);
  const summary = tuned + `  summary:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: test "\${{ needs.test.result }}" = success
`;
  assert.deepEqual(lintWorkflow({ path: '.github/workflows/ci.yml', text: summary }).map((f) => f.code), ['slim'], 'a shell-only summary job belongs on a 1-core runner');
  const stats = { name: 'CI', path: '.github/workflows/ci.yml', runs: 10, minutes: 100, usd: 0.6, jobsPerRun: 12, avgJobMinutes: 1.2, retestedMinutes: 40 };
  const withStats = lintWorkflow({ path: '.github/workflows/ci.yml', text: tuned.replace('uses: g4m35/yardmaster@v0.4.0', 'run: echo') }, stats);
  assert.ok(withStats.some((f) => f.code === 'no-guard' && f.level === 'high' && f.message.includes('40 minutes')));
  assert.ok(withStats.some((f) => f.code === 'small-jobs'));
});

// ---------- GitHub client ----------

test('GitHub client retries server errors on reads, paginates, and never sends the token elsewhere', async () => {
  let n = 0;
  const m = await mockGitHub({
    'GET /flaky': () => (++n < 3 ? { status: 502, body: { message: 'bad gateway' } } : { body: { ok: true } }),
    'GET /items': (_r, _b, url) => url.searchParams.get('page') === '2' ? { body: [3] } : { body: [1, 2], headers: { link: `<${m.base}/items?page=2>; rel="next"` } },
    'GET /evil': () => ({ body: [1], headers: { link: '<https://attacker.example/steal>; rel="next"' } }),
  });
  assert.deepEqual(await m.gh.get('/flaky'), { ok: true });
  assert.equal(n, 3);
  assert.deepEqual(await m.gh.paginate('/items', null), [1, 2, 3]);
  await assert.rejects(m.gh.paginate('/evil', null), /Refusing to call https:\/\/attacker\.example/);
  assert.equal(repoSlugFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoSlugFromUrl('https://github.com/acme/app'), 'acme/app');
  assert.equal(repoSlugFromUrl('ssh://git@github.com/acme/app.git'), 'acme/app');
  assert.equal(repoSlugFromUrl('https://gitlab.com/acme/app.git'), null);
});

// ---------- the guard Action ----------

function guardCtx(p: Partial<GuardContext> = {}): GuardContext {
  return { repo: 'acme/app', sha: 'S1', event: 'push', payload: {}, workflowPath: '.github/workflows/ci.yml', runId: 99, serverUrl: 'https://github.com', ref: 'refs/heads/main', ...p };
}

const RUN_URL = 'https://github.com/acme/app/actions/runs/7';
const at = (sec: number) => new Date(Date.parse('2026-11-05T20:00:00Z') + sec * 1000).toISOString();
const status = (context: string, description: string, login: string, extra: Record<string, unknown> = {}) =>
  ({ state: 'success', context, description, target_url: RUN_URL, created_at: at(100), creator: { login }, ...extra });
const job = (name: string, started: number, completed: number | null, conclusion: string | null = 'success') =>
  ({ name, status: completed === null ? 'in_progress' : 'completed', conclusion: completed === null ? null : conclusion, started_at: at(started), completed_at: completed === null ? null : at(completed) });
/** A pull request run for H1 that really ran: guard, tests, then the job that posted the status at t=100. */
const goodJobs = () => [job('guard', 0, 10), job('test (ubuntu-latest, 22)', 12, 80), job('test (macos-latest, 22)', 12, 95), job('done', 96, 104)];
const goodRun = () => ({ id: 7, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'H1', run_started_at: at(0), html_url: RUN_URL, repository: { full_name: 'acme/app' } });

test('guard skips a push whose exact tree passed on its pull request, only when that run backs the claim', async () => {
  const tested = testedContext('.github/workflows/ci.yml');
  let headStatuses: unknown[] = [];
  let run: Record<string, unknown> = goodRun();
  let jobs = goodJobs();
  const m = await mockGitHub({
    'GET /repos/acme/app/git/commits/S1': () => ({ body: { tree: { sha: 'T1' } } }),
    'GET /repos/acme/app/actions/workflows/ci.yml/runs': () => ({ body: { workflow_runs: [] } }),
    'GET /repos/acme/app/commits/S1/pulls': () => ({ body: [{ head: { sha: 'H1' } }] }),
    'GET /repos/acme/app/commits/S1/statuses': () => ({ body: [] }),
    'GET /repos/acme/app/commits/H1/statuses': () => ({ body: headStatuses }),
    'GET /repos/acme/app/actions/runs/7': () => ({ body: run }),
    'GET /repos/acme/app/actions/runs/7/jobs': () => ({ body: { total_count: jobs.length, jobs } }),
    'GET /repos/acme/app/git/commits/M1': () => ({ body: { tree: { sha: 'T1' } } }),
    'GET /repos/acme/app/commits/M1/statuses': () => ({ body: [] }),
  });
  const inputs = { trustLocal: false, trustedUsers: [], waitSeconds: 0 };
  // The first argument only names the case; the assertion message says what it proves.
  const skips = async (_case: string, ctx = guardCtx(), inp: Parameters<typeof decide>[2] = inputs) => (await decide(m.gh, ctx, inp)).skip;
  const reset = () => {
    headStatuses = [status(tested, 'tree T1', 'github-actions[bot]')];
    run = goodRun();
    jobs = goodJobs();
  };

  reset();
  const d = await decide(m.gh, guardCtx(), inputs);
  assert.equal(d.skip, true, d.reason);
  assert.equal(d.tree, 'T1');
  assert.equal(d.url, RUN_URL);

  headStatuses = [status(tested, 'tree T2', 'github-actions[bot]')];
  assert.equal(await skips('tree'), false, 'a different tree never counts');

  reset();
  headStatuses = [status(tested, 'tree T1', 'alice')];
  assert.equal(await skips('person'), false, 'a pass posted by a person never counts, whatever their access');

  reset();
  headStatuses = [status(tested, 'tree T1', 'github-actions[bot]', { target_url: 'https://evil.example/acme/app/actions/runs/7' })];
  assert.equal(await skips('url'), false, 'the status must point at a run of this repo');

  reset();
  run = { ...goodRun(), path: '.github/workflows/other.yml' };
  assert.equal(await skips('path'), false, 'a run of another workflow file vouches for nothing (any workflow can post as github-actions[bot])');

  reset();
  run = { ...goodRun(), head_sha: 'H9' };
  assert.equal(await skips('sha'), false, 'the run must be for the commit the status is on');

  reset();
  run = { ...goodRun(), conclusion: 'failure' };
  assert.equal(await skips('failed'), false, 'a failed run vouches for nothing');

  reset();
  jobs = [job('guard', 0, 10), job('test (ubuntu-latest, 22)', 11, 11, 'skipped'), job('done', 12, 20)];
  assert.equal(await skips('chained'), false, 'a run that skipped its own suite (say, on a forged pass) cannot vouch for a tree');
  assert.equal(await skips('allowed', guardCtx(), { ...inputs, allowSkipped: ['test'] }), true, 'unless the adopter says that job may be skipped');

  reset();
  run = { ...goodRun(), status: 'in_progress', conclusion: null };
  jobs = [job('guard', 0, 10), job('test (ubuntu-latest, 22)', 12, 80), job('test (macos-latest, 22)', 12, null)];
  assert.equal(await skips('early'), false, 'posted while a test job was still running: not a pass');

  reset();
  run = { ...goodRun(), status: 'in_progress', conclusion: null };
  jobs = [...goodJobs().slice(0, 3), job('done', 96, null)];
  assert.equal(await skips('recorder still finishing'), true, 'the recording job itself may still be finishing (auto-merge right after green)');

  reset();
  headStatuses = [status(tested, 'tree T1', 'github-actions[bot]', { created_at: at(-50) })];
  assert.equal(await skips('before run'), false, 'a status older than the run it cites was not posted by it');

  // A decoy: the same commit opened as a pull request into a branch whose workflow does nothing.
  const linked = (number: number, ref: string) => [{ number, base: { ref, repo: { url: 'https://api.github.com/repos/acme/app' } } }];
  reset();
  run = { ...goodRun(), pull_requests: linked(12, 'evil') };
  assert.equal(await skips('open decoy'), false, 'a run of a pull request into another branch vouches for nothing on main');
  reset();
  run = { ...goodRun(), pull_requests: linked(8, 'main') };
  assert.equal(await skips('linked to main'), true);

  const prCtx = guardCtx({ sha: 'M1', event: 'pull_request', payload: { pull_request: { number: 8, head: { sha: 'H1' }, base: { ref: 'main' } } } });
  reset();
  run = { ...goodRun(), pull_requests: linked(8, 'main') };
  assert.equal(await skips('same PR', prCtx), true, 'an earlier run of this same pull request counts');
  run = { ...goodRun(), pull_requests: linked(12, 'evil') };
  assert.equal(await skips('decoy PR', prCtx), false, 'on a pull request, a run of another pull request never counts');
  run = { ...goodRun(), pull_requests: [] };
  assert.equal(await skips('closed decoy', prCtx), false, 'nor does a run GitHub no longer links to this pull request');

  reset();
  run = { ...goodRun(), event: 'push', head_commit: { tree_id: 'T5' } };
  assert.equal(await skips('push tree'), false, 'a push run vouches only for the tree it tested');
  run = { ...goodRun(), event: 'push', head_commit: { tree_id: 'T1' } };
  assert.equal(await skips('push tree ok'), true);

  reset();
  headStatuses = [status('yardmaster/verified', 'tree T1 (npm test)', 'alice')];
  assert.equal(await skips('no trust-local'), false, 'local signoffs only count with trust-local');
  assert.equal(await skips('no list', guardCtx(), { ...inputs, trustLocal: true }), false, 'trust-local needs trusted-users');
  assert.equal(await skips('listed', guardCtx(), { ...inputs, trustLocal: true, trustedUsers: ['alice'] }), true);
  assert.equal(await skips('not listed', guardCtx(), { ...inputs, trustLocal: true, trustedUsers: ['bob'] }), false);
  headStatuses = [status('yardmaster/verified', 'tree T1 (npm test)', 'renovate[bot]')];
  assert.equal(await skips('bot', guardCtx(), { ...inputs, trustLocal: true, trustedUsers: ['renovate[bot]'] }), false, 'bots never sign off');

  reset();
  assert.equal(await skips('manual', guardCtx({ event: 'workflow_dispatch' })), false, 'manual runs always run');
  assert.equal(await skips('prt', guardCtx({ event: 'pull_request_target' })), false, 'pull_request_target tests main\'s sha, so it never skips');
});

test('guard skips when a push run really passed the same tree, and waits only for a signoff that can match', async () => {
  let polls = 0;
  let headPolls = 0;
  let pushJobs = [job('guard', 0, 5), job('test', 6, 60)];
  const m = await mockGitHub({
    'GET /repos/acme/app/actions/workflows/ci.yml/runs': () => ({ body: { workflow_runs: [{ id: 5, event: 'push', html_url: 'https://github.com/acme/app/actions/runs/5', head_commit: { tree_id: 'T9' } }] } }),
    'GET /repos/acme/app/actions/runs/5/jobs': () => ({ body: { jobs: pushJobs } }),
    'GET /repos/acme/app/git/commits/S3': () => ({ body: { tree: { sha: 'T3' } } }),
    'GET /repos/acme/app/commits/S3/pulls': () => ({ body: [] }),
    'GET /repos/acme/app/commits/S3/statuses': () => ({ body: ++polls >= 3 ? [status('yardmaster/verified', 'tree T3', 'alice')] : [] }),
    'GET /repos/acme/app/git/commits/M4': () => ({ body: { tree: { sha: 'TM4' } } }),
    'GET /repos/acme/app/git/commits/H4': () => ({ body: { tree: { sha: 'TH4' } } }),
    'GET /repos/acme/app/commits/M4/statuses': () => ({ body: [] }),
    'GET /repos/acme/app/commits/H4/statuses': () => ({ body: (headPolls++, []) }),
  });
  // The push's own payload names its tree: no commit lookup needed.
  const push = guardCtx({ sha: 'S2', payload: { after: 'S2', head_commit: { tree_id: 'T9' } } });
  const d = await decide(m.gh, push, { trustLocal: false, trustedUsers: [], waitSeconds: 0 });
  assert.equal(d.skip, true, d.reason);
  assert.equal(d.url, 'https://github.com/acme/app/actions/runs/5');
  assert.ok(!m.calls.includes('GET /repos/acme/app/git/commits/S2'));

  pushJobs = [job('guard', 0, 5), job('test', 6, 6, 'skipped')];
  const chained = await decide(m.gh, push, { trustLocal: false, trustedUsers: [], waitSeconds: 0 });
  assert.equal(chained.skip, false, 'a push run that skipped its suite is not a pass');
  assert.match(chained.reason, /skipped or failed jobs/);

  const late = await decide(m.gh, guardCtx({ sha: 'S3' }), { trustLocal: true, trustedUsers: ['alice'], waitSeconds: 2, pollMs: 20 });
  assert.equal(late.skip, true, late.reason);

  // A PR whose head is behind its base tests a merge tree no signoff can carry: don't sit out the wait.
  const t0 = Date.now();
  const pr = await decide(m.gh, guardCtx({ sha: 'M4', event: 'pull_request', payload: { pull_request: { head: { sha: 'H4' } } } }), { trustLocal: true, trustedUsers: ['alice'], waitSeconds: 5, pollMs: 20 });
  assert.equal(pr.skip, false);
  assert.ok(Date.now() - t0 < 2000, 'no wait when the signoff could never match');
  assert.equal(headPolls, 1);
});

test('guard record stores the tested merge tree on the pull request head, and never for other events', async () => {
  const m = await mockGitHub({
    'GET /repos/acme/app/git/commits/M1': () => ({ body: { tree: { sha: 'TM' } } }),
    'POST /repos/acme/app/statuses/H1': () => ({ status: 201, body: {} }),
    'GET /repos/acme/app/git/commits/M2': () => ({ body: { tree: { sha: 'TX' } } }),
    'POST /repos/acme/app/statuses/H2': () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }),
  });
  const r = await record(m.gh, guardCtx({ sha: 'M1', event: 'pull_request', payload: { pull_request: { head: { sha: 'H1' } } } }));
  assert.equal(r.posted, true);
  assert.deepEqual(m.posts[0], { path: '/repos/acme/app/statuses/H1', body: { state: 'success', context: 'yardmaster/tested (ci.yml)', description: 'tree TM', target_url: 'https://github.com/acme/app/actions/runs/99' } });
  const fork = await record(m.gh, guardCtx({ sha: 'M2', event: 'pull_request', payload: { pull_request: { head: { sha: 'H2' } } } }));
  assert.equal(fork.posted, false, 'fork PR tokens cannot write statuses; that is not an error');
  const prt = await record(m.gh, guardCtx({ sha: 'M1', event: 'pull_request_target', payload: { pull_request: { head: { sha: 'H1' } } } }));
  assert.equal(prt.posted, false, 'pull_request_target would vouch for main\'s tree on the PR head');
  assert.equal(m.posts.length, 2);
});

test('the bundled Action is up to date with its source', () => {
  const r = spawnSync(process.execPath, ['scripts/build-action.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ---------- budget ----------

test('budget uses GitHub billing numbers when allowed, estimates otherwise', async () => {
  sandbox();
  const now = new Date();
  const m = await mockGitHub({
    'GET /users/acme': () => ({ body: { type: 'User', login: 'acme' } }),
    'GET /users/acme/settings/billing/usage/summary': () => ({ body: { usageItems: [
      { product: 'Actions', sku: 'actions_linux', unitType: 'Minutes', grossQuantity: 1500, grossAmount: 9, netAmount: 0 },
      { product: 'Actions', sku: 'actions_storage', unitType: 'GigabyteHours', grossQuantity: 10, grossAmount: 0.5, netAmount: 0 },
    ] } }),
    'GET /users/solo': () => ({ body: { type: 'User', login: 'solo' } }),
    'GET /user': () => ({ body: { login: 'solo' } }),
    'GET /user/repos': () => ({ body: [{ full_name: 'solo/app' }] }),
    'GET /repos/solo/app/actions/runs': () => ({ body: { total_count: 1, workflow_runs: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: 'a', head_commit: { tree_id: 't' }, status: 'completed', conclusion: 'success', actor: { login: 'solo' }, created_at: now.toISOString(), updated_at: now.toISOString(), html_url: '' }] } }),
    'GET /repos/solo/app/actions/runs/1/jobs': () => ({ body: { jobs: [0, 1].map(() => ({ run_id: 1, name: 'test', labels: ['ubuntu-latest'], status: 'completed', conclusion: 'success', started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:02:30Z' })) } }),
  });
  const cfg = loadConfig().ci.budget;
  const billed = await computeBudget(m.gh, 'acme', cfg, { now });
  assert.equal(billed.source, 'billing');
  assert.equal(billed.spentUsd, 9, 'storage has its own allowance and is left out');
  assert.equal(billed.minutes, 1500);
  const est = await computeBudget(m.gh, 'solo', cfg, { now });
  assert.equal(est.source, 'estimate');
  assert.ok(Math.abs(est.spentUsd - 6 * 0.006) < 1e-9, `2 jobs x 3 billed minutes, got ${est.spentUsd}`);
  assert.equal(verdict({ ...est, spentUsd: 12.5 }, cfg).level, 'over');
  assert.notEqual(verdict({ ...est, spentUsd: 12.5, projectedUsd: 12.5 }, { ...cfg, extraUsd: 10 }).level, 'over', 'raising extraUsd takes effect without waiting for a refresh');
  assert.equal(verdict({ ...est, spentUsd: 15, includedUsd: 100 }, cfg).level, 'over', 'the allowance comes from current settings, not the cached state');
  assert.equal(est.plan, null, 'no plan in the /user reply: assume Free');
  assert.notEqual(verdict({ ...est, spentUsd: 15, projectedUsd: 15, plan: 'pro' }, cfg).level, 'over', 'a Pro plan includes $18');
  assert.equal(verdict({ ...billed, overageUsd: 0.4 }, cfg).level, 'over', "GitHub's own overage figure counts even when our sum says otherwise");
  assert.equal(verdict({ ...est, spentUsd: 1, projectedUsd: 11 }, cfg).level, 'warn');
  assert.equal(verdict({ ...est, spentUsd: 1, projectedUsd: 2 }, cfg).level, 'ok');
});

test('budget takes the allowance from the GitHub plan when the token can see it', async () => {
  sandbox();
  const m = await mockGitHub({
    'GET /users/pat': () => ({ body: { type: 'User', login: 'pat' } }),
    'GET /user': () => ({ body: { login: 'pat', plan: { name: 'pro' } } }),
    'GET /users/pat/settings/billing/usage/summary': () => ({ body: { usageItems: [] } }),
  });
  const cfg = loadConfig().ci.budget;
  const s = await computeBudget(m.gh, 'pat', cfg);
  assert.equal(s.plan, 'pro');
  assert.equal(s.includedUsd, 18);
  const pinned = await computeBudget(m.gh, 'pat', { ...cfg, includedUsd: 50 });
  assert.equal(pinned.includedUsd, 50, 'a configured allowance wins');
  assert.ok(!m.calls.slice(3).includes('GET /user'), 'no plan lookup when the allowance is configured');
});

test('job cache notices a re-run: same run id, new attempt', async () => {
  sandbox();
  let attempts = 1;
  let fetches = 0;
  const job = (n: number) => ({ run_id: 7, name: `attempt ${n}`, labels: ['ubuntu-latest'], status: 'completed', conclusion: 'success', started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:01:00Z' });
  const m = await mockGitHub({
    'GET /repos/acme/app/actions/runs/7/jobs': () => {
      fetches++;
      return { body: { jobs: Array.from({ length: attempts }, (_, i) => job(i + 1)) } };
    },
  });
  const run = (updatedAt: number): RunRec => ({ id: 7, workflow: 'CI', path: '.github/workflows/ci.yml', event: 'push', branch: 'main', sha: 'a', tree: 't', status: 'completed', conclusion: 'success', actor: 'x', createdAt: 1, updatedAt, url: '' });
  assert.equal((await loadJobs(m.gh, 'acme/app', [run(1000)])).get(7)!.length, 1);
  assert.equal((await loadJobs(m.gh, 'acme/app', [run(1000)])).get(7)!.length, 1);
  assert.equal(fetches, 1, 'an unchanged finished run comes from the cache');
  attempts = 2;
  assert.equal((await loadJobs(m.gh, 'acme/app', [run(2000)])).get(7)!.length, 2, 'the re-run attempt is billed too');
  assert.equal(fetches, 2);
});

// ---------- the push gate ----------

function gitPush(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('git', ['push', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function commitFile(repo: string, file: string, text: string, msg: string) {
  writeFileSync(join(repo, file), text);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-q', '-m', msg]);
}

test('push gate: failing checks stop the push, a passing tree is checked once, and it cleans up after itself', () => {
  const box = sandbox();
  const bare = tempDir('ym-remote-');
  sh(bare, 'git', ['init', '-q', '--bare']);
  sh(box.repo, 'git', ['remote', 'add', 'origin', bare]);
  const count = join(box.root, 'checks-ran');
  const counter = join(box.root, 'count.mjs');
  writeFileSync(counter, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(count)}, 'x');\n`);
  writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs', `node ${counter}`] }));
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-q', '-m', 'checks']);
  return installGateHook(box.repo).then(() => {
    const marker = 'BRO' + 'KEN';
    commitFile(box.repo, 'a.txt', `${marker}\n`, 'bad');
    const bad = gitPush(box.repo, ['origin', 'main']);
    assert.notEqual(bad.status, 0, 'push should be refused');
    assert.match(bad.stderr, /checks failed/);
    assert.match(bad.stderr, new RegExp(`${marker} found in a.txt`));
    assert.ok(!existsSync(count));

    commitFile(box.repo, 'a.txt', 'fine\n', 'fix');
    const good = gitPush(box.repo, ['origin', 'main']);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stderr, /checks passed/);
    assert.equal(readFileSync(count, 'utf8'), 'x');

    const again = gitPush(box.repo, ['origin', 'main:other']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /running checks/);
    assert.equal(readFileSync(count, 'utf8'), 'x', 'same tree is never checked twice');

    // A new commit pushed while the checkout has stray files is checked in a clean temporary worktree.
    commitFile(box.repo, 'b.txt', 'more\n', 'more');
    writeFileSync(join(box.repo, 'scratch.txt'), `${marker} but untracked, so not part of the push\n`);
    const dirty = gitPush(box.repo, ['origin', 'main']);
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.equal(readFileSync(count, 'utf8'), 'xx');
    assert.equal(sh(box.repo, 'git', ['worktree', 'list']).split('\n').length, 1, 'temporary worktree removed');

    commitFile(box.repo, 'c.txt', `${marker}\n`, 'bad again');
    const skipped = gitPush(box.repo, ['origin', 'main'], { YM_CI_SKIP: '1' });
    assert.equal(skipped.status, 0, 'YM_CI_SKIP lets a person push anyway');
  });
});

test('push gate keeps an existing pre-push hook and restores it on uninstall', async () => {
  const box = sandbox();
  const bare = tempDir('ym-remote-');
  sh(bare, 'git', ['init', '-q', '--bare']);
  sh(box.repo, 'git', ['remote', 'add', 'origin', bare]);
  const hookFile = join(box.repo, '.git', 'hooks', 'pre-push');
  const seen = join(box.root, 'their-hook-saw');
  const theirs = `#!/bin/sh\ncat > ${JSON.stringify(seen)}\nexit 0\n`;
  writeFileSync(hookFile, theirs);
  chmodSync(hookFile, 0o755);
  const r = await installGateHook(box.repo);
  assert.equal(r.chained, true);
  const p = gitPush(box.repo, ['origin', 'main']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(readFileSync(seen, 'utf8'), /refs\/heads\/main [0-9a-f]{40} refs\/heads\/main/, 'their hook still gets the refs');
  assert.match(p.stderr, /checks passed/);
  const u = await uninstallGateHook(box.repo);
  assert.deepEqual(u, { removed: true, restored: true });
  assert.equal(readFileSync(hookFile, 'utf8'), theirs);
});

test('push gate holds pushes to a private repo once the allowance is gone, and warns about CI still running', async () => {
  const box = sandbox();
  let live = false;
  const m = await mockGitHub({
    'GET /repos/acme/app': () => ({ body: { private: true } }),
    'GET /repos/acme/app/actions/runs': () => ({ body: { workflow_runs: live ? [{ head_sha: 'f'.repeat(40), status: 'in_progress', created_at: new Date(Date.now() - 4 * 60_000).toISOString() }] : [] } }),
  });
  process.env.YM_GITHUB_API = m.base;
  try {
    const sha = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
    const stdin = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
    writeBudget({ owner: 'acme', at: Date.now(), month: currentMonth(), source: 'estimate', spentUsd: 12.4, overageUsd: null, includedUsd: 12, extraUsd: 0, projectedUsd: 30, minutes: 2000, repos: [] });
    const held = await runGate({ cwd: box.repo, remoteUrl: 'https://github.com/acme/app.git', stdin });
    assert.equal(held.code, 1);
    assert.match(held.lines.join('\n'), /held so it does not start paid CI runs/);
    const forced = await runGate({ cwd: box.repo, remoteUrl: 'https://github.com/acme/app.git', stdin, env: { ...process.env, YM_CI_FORCE: '1' } });
    assert.equal(forced.code, 0, forced.lines.join('\n'));
    writeBudget({ owner: 'acme', at: Date.now(), month: '1999-01', source: 'estimate', spentUsd: 99, overageUsd: null, includedUsd: 12, extraUsd: 0, projectedUsd: 99, minutes: 9000, repos: [] });
    const newMonth = await runGate({ cwd: box.repo, remoteUrl: 'https://github.com/acme/app.git', stdin });
    assert.equal(newMonth.code, 0, 'last month\'s spending never holds a push after the allowance resets');

    writeBudget({ owner: 'acme', at: Date.now(), month: currentMonth(), source: 'estimate', spentUsd: 1, overageUsd: null, includedUsd: 12, extraUsd: 0, projectedUsd: 2, minutes: 100, repos: [] });
    live = true;
    const warned = await runGate({ cwd: box.repo, remoteUrl: 'https://github.com/acme/app.git', stdin });
    assert.equal(warned.code, 0);
    assert.match(warned.lines.join('\n'), /CI is still running on main/);
    writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], ci: { coalesce: 'block' } }));
    const blocked = await runGate({ cwd: box.repo, remoteUrl: 'https://github.com/acme/app.git', stdin });
    assert.equal(blocked.code, 1);
  } finally {
    delete process.env.YM_GITHUB_API;
  }
  assert.deepEqual(parsePushInput(`refs/heads/x ${'0'.repeat(40)} refs/heads/x abc\nrefs/tags/v1 abc refs/tags/v1 ${'0'.repeat(40)}\n`), [], 'deletes and tags are not checked');
});

// ---------- ship ----------

test('ship pushes the checked integration branch once, without re-running checks', async () => {
  const box = sandbox();
  const bare = tempDir('ym-remote-');
  sh(bare, 'git', ['init', '-q', '--bare']);
  sh(box.repo, 'git', ['remote', 'add', 'origin', bare]);
  sh(box.repo, 'git', ['checkout', '-q', '-b', 'yardmaster/integration']);
  for (const t of ['Add login (t-1)', 'Fix footer (t-2)']) {
    sh(box.repo, 'git', ['checkout', '-q', '-b', `w-${t.length}`, 'main']);
    commitFile(box.repo, `${t.length}.txt`, t, t);
    sh(box.repo, 'git', ['checkout', '-q', 'yardmaster/integration']);
    sh(box.repo, 'git', ['merge', '-q', '--no-ff', '-m', `yardmaster: ${t}`, `w-${t.length}`]);
  }
  sh(box.repo, 'git', ['checkout', '-q', 'main']);
  await installGateHook(box.repo);
  const config = loadConfig(box.repo);
  // What the merge train does after its checks pass:
  await rememberChecked(box.repo, 'yardmaster/integration', config.verify);
  const r = await ship({ root: box.repo, config, gh: null, remote: 'origin', base: 'main' });
  assert.equal(r.pushed, true);
  assert.deepEqual(r.tasks, ['Fix footer (t-2)', 'Add login (t-1)']);
  assert.doesNotMatch(r.gateOutput, /running checks/, 'the merge train already checked this tree');
  assert.equal(sh(bare, 'git', ['rev-parse', 'yardmaster/integration']), sh(box.repo, 'git', ['rev-parse', 'yardmaster/integration']));
});
