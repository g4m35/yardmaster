import { loadConfig } from '../config.ts';
import { git, mainRepoRoot, repoRoot } from '../git.ts';
import { analyze, totalOf, type Analysis, type Bucket } from './analyze.ts';
import { budgetForNow, computeBudget, readBudget, verdict } from './budget.ts';
import { gateCommands, recentPushes, runGate } from './gate.ts';
import { repoSlugFromUrl, type GitHub } from './github.ts';
import { repoHistory } from './history.ts';
import { gateHookInstalled, installGateHook, uninstallGateHook } from './hookfile.ts';
import { ship } from './ship.ts';
import { signoff } from './signoff.ts';
import { githubClient, NO_TOKEN_HELP } from './token.ts';
import { VERSION } from '../version.ts';
import { lintWorkflow, readLocalWorkflows, readRemoteWorkflows, type Finding } from './workflows.ts';

export interface Ui {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

export interface CiArgs {
  positional: string[];
  flag: (k: string) => string | undefined;
  has: (k: string) => boolean;
}

export const ACTION_REPO = 'g4m35/yardmaster';
export const ACTION_TAG = `v${VERSION}`;

/**
 * The guard pinned to the commit behind this release's tag. A tag can be moved to other code; a commit can't, and the
 * guard decides whether tests run, so workflows should never follow a tag. Null when GitHub can't be asked.
 */
export async function pinnedActionRef(gh: GitHub | null): Promise<string | null> {
  if (!gh) return null;
  const c = await gh.get<{ sha?: string }>(`/repos/${ACTION_REPO}/commits/${ACTION_TAG}`).catch(() => null);
  return c?.sha && /^[0-9a-f]{40}$/.test(c.sha) ? `${ACTION_REPO}@${c.sha} # ${ACTION_TAG}` : null;
}

export const CI_HELP = `ym ci: spend less on GitHub Actions when many agents push

  ym ci audit [owner/repo ...]   where your Actions minutes went, and the fixes worth making
                                 (--owner NAME for every repo of an account, --days 30, --json)
  ym ci budget [owner]           this month's Actions spend against your allowance (--json)
  ym ci init                     install the push gate in this repo and print the workflow guard
  ym ci status                   gate, guard, budget and recent pushes for this repo
  ym ci ship [--draft]           push finished agent work as one pull request (one CI run for the batch)
  ym ci signoff [commit]         tell GitHub this exact tree passed locally (for workflows using trust-local)
  ym ci uninstall                remove the push gate (restores any hook it wrapped)

Pushing through the gate: YM_CI_SKIP=1 skips it once, YM_CI_FORCE=1 pushes past budget and in-progress holds.
Docs: https://github.com/g4m35/yardmaster/blob/main/docs/CI.md`;

export function guardSnippet(ref: string): string {
  return `permissions:
  contents: read               # jobs get only what they ask for below

jobs:
  guard:                       # 1. decide (one 1-core job, about $0.002)
    runs-on: ubuntu-slim
    timeout-minutes: 5
    permissions: { actions: read, contents: read, pull-requests: read, statuses: read }
    outputs:
      skip: \${{ steps.guard.outputs.skip }}
    steps:
      - id: guard
        uses: ${ref}

  test:                        # 2. every expensive job
    needs: guard
    if: needs.guard.outputs.skip != 'true'
    # ...your existing job...

  done:                        # 3. the one check to require in branch protection; records what passed
    needs: [guard, test]       #    list every job here
    if: always()
    runs-on: ubuntu-slim
    timeout-minutes: 5
    permissions: { contents: read, statuses: write }
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
      - if: needs.guard.outputs.skip != 'true' && !contains(needs.*.result, 'skipped')
        uses: ${ref}
        with: { mode: record }`;
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const usd = (x: number) => `$${x.toFixed(2)}`;

function bucketLine(ui: Ui, b: Bucket, label: string, priced: boolean): string {
  return `    ${ui.bold(n(b.minutes).padStart(7))} min${priced ? ui.dim(` ${usd(b.usd).padStart(8)}`) : ''}  ${label}`;
}

export function formatAudit(a: Analysis, findings: Finding[], ui: Ui): string {
  const priced = a.private;
  const out: string[] = [];
  out.push(`${ui.bold(a.repo)} ${ui.dim(`(${a.private ? 'private' : 'public: standard runners are free'}) · last ${a.days} days`)}`);
  out.push(`  ${n(a.runs)} runs · ${n(a.jobs)} jobs · ${ui.bold(`${n(a.minutes)} billed minutes`)}${priced ? ` · ${ui.bold(usd(a.usd))} at list price` : ''}`);
  if (!a.runs) return out.join('\n');
  out.push('');
  out.push(`  Avoidable, at most ${ui.bold(`${n(a.avoidable.minutes)} min`)}${priced ? ` (${usd(a.avoidable.usd)})` : ''} in ${n(a.avoidable.runs)} runs ${ui.dim('(the reasons below overlap)')}`);
  out.push(bucketLine(ui, a.retested, `re-tested a file tree that had already passed (${n(a.retested.runs)} runs)`, priced));
  out.push(bucketLine(ui, a.failed, `failed runs (${n(a.failed.runs)}): checks a pre-push gate would usually catch first`, priced));
  out.push(bucketLine(ui, a.superseded, `outdated by a newer push while still running (${n(a.superseded.runs)} runs)`, priced));
  if (a.duplicate.runs) out.push(bucketLine(ui, a.duplicate, `same commit run twice by one workflow (${n(a.duplicate.runs)} runs)`, priced));
  out.push(bucketLine(ui, { runs: 0, minutes: a.rounding.minutes, usd: a.rounding.usd }, `rounding: each of ${n(a.jobs)} jobs is billed in whole minutes`, priced));
  const extras: string[] = [];
  if (a.agentBranches.runs) extras.push(`agent-named branches: ${n(a.agentBranches.minutes)} min in ${n(a.agentBranches.runs)} runs`);
  if (a.copilot.runs) extras.push(`Copilot agent/review: ${n(a.copilot.minutes)} min in ${n(a.copilot.runs)} runs`);
  if (a.dependabot.runs) extras.push(`Dependabot: ${n(a.dependabot.runs)} runs (free)`);
  if (a.otherRunnerJobs) extras.push(`${n(a.otherRunnerJobs)} jobs on self-hosted/third-party runners (not billed by GitHub, not counted)`);
  if (a.largerMacJobs) extras.push(`${n(a.largerMacJobs)} jobs on larger macOS runners (billed even in public repos)`);
  if (extras.length) out.push(ui.dim(`  ${extras.join(' · ')}`));
  if (a.workflows.length) {
    out.push('');
    out.push('  Workflows');
    for (const w of a.workflows.slice(0, 6)) {
      out.push(`    ${w.name.slice(0, 28).padEnd(28)} ${n(w.runs).padStart(5)} runs ${n(w.minutes).padStart(7)} min  ${ui.dim(`${w.jobsPerRun.toFixed(1)} jobs/run, ${w.avgJobMinutes.toFixed(1)} min/job`)}`);
    }
  }
  if (findings.length) {
    out.push('');
    out.push('  Fixes, most valuable first');
    const order = { high: 0, medium: 1, low: 2 };
    for (const f of [...findings].sort((x, y) => order[x.level] - order[y.level])) {
      const dot = f.level === 'high' ? ui.red('●') : f.level === 'medium' ? ui.yellow('●') : ui.dim('●');
      out.push(`    ${dot} ${ui.bold(f.workflow.split('/').pop()!)}: ${f.message}`);
      if (f.fix) out.push(ui.dim(f.fix.split('\n').map((l) => `        ${l}`).join('\n')));
    }
  }
  return out.join('\n');
}

async function needToken(): Promise<GitHub> {
  const gh = await githubClient();
  if (!gh.authenticated) throw new Error(NO_TOKEN_HELP);
  return gh;
}

async function originSlug(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['remote', 'get-url', 'origin'], { allowFail: true });
  return r.code === 0 ? repoSlugFromUrl(r.stdout) : null;
}

function progress(label: string) {
  if (!process.stderr.isTTY) return undefined;
  return (done: number, total: number) => {
    process.stderr.write(`\r  ${label}: reading job ${done}/${total}   `);
    if (done === total) process.stderr.write('\r' + ' '.repeat(60) + '\r');
  };
}

async function cmdAudit(a: CiArgs, ui: Ui): Promise<void> {
  const gh = await needToken();
  const days = Number(a.flag('days') ?? 30);
  if (!(days > 0 && days <= 90)) throw new Error('--days must be between 1 and 90 (GitHub keeps run history for 90 days by default).');
  let repos = a.positional.filter((p) => p.includes('/'));
  const owner = a.flag('owner');
  if (owner) {
    const since = Date.now() - days * 86_400_000;
    const me = await gh.get<{ login: string }>('/user');
    const list = me.login.toLowerCase() === owner.toLowerCase()
      ? await gh.paginate<{ full_name: string; pushed_at: string }>('/user/repos', null, { affiliation: 'owner', sort: 'pushed' }, 500)
      : await gh.paginate<{ full_name: string; pushed_at: string }>(`/users/${owner}/repos`, null, { sort: 'pushed' }, 500);
    repos = list.filter((r) => Date.parse(r.pushed_at) >= since).map((r) => r.full_name);
  }
  if (!repos.length) {
    const slug = await originSlug(process.cwd());
    if (!slug) throw new Error('Say which repo: ym ci audit owner/repo (or run it inside a clone of a GitHub repo).');
    repos = [slug];
  }
  const results: { analysis: Analysis; findings: Finding[] }[] = [];
  for (const repo of repos) {
    const h = await repoHistory(gh, repo, days, progress(repo));
    const analysis = analyze(h, days);
    const root = await mainRepoRoot(process.cwd());
    const local = root && (await originSlug(root)) === repo ? readLocalWorkflows(root) : null;
    const files = local ?? (await readRemoteWorkflows(gh, repo));
    const findings = files.flatMap((f) => lintWorkflow(f, analysis.workflows.find((w) => w.path === f.path), h.defaultBranch));
    results.push({ analysis, findings });
    if (!a.has('json')) console.log(formatAudit(analysis, findings, ui) + '\n');
  }
  if (a.has('json')) return console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  if (results.length > 1) {
    const t = totalOf(results.map((r) => r.analysis));
    console.log(`${ui.bold('Total')}: ${n(t.minutes)} billed minutes, ${usd(t.usd)} at list price; avoidable at most ${n(t.avoidable.minutes)} min (${usd(t.avoidable.usd)}).`);
  }
  console.log(ui.dim(`Billed minutes are each job's run time rounded up, priced at GitHub's list rates. Next: ${ui.cyan('ym ci init')} in a repo to install the push gate and get the guard snippet.`));
}

async function cmdBudget(a: CiArgs, ui: Ui): Promise<void> {
  const gh = await needToken();
  const root = await mainRepoRoot(process.cwd());
  const config = loadConfig(root ?? undefined);
  const owner = a.positional[0] ?? (root ? (await originSlug(root))?.split('/')[0] : undefined) ?? (await gh.get<{ login: string }>('/user')).login;
  const quiet = a.has('quiet');
  const state = await computeBudget(gh, owner, config.ci.budget, { onProgress: quiet || !process.stderr.isTTY ? undefined : (m) => process.stderr.write(`\r  reading ${m}`.padEnd(70)) });
  if (!quiet && process.stderr.isTTY) process.stderr.write('\r'.padEnd(72) + '\r');
  if (quiet) return;
  if (a.has('json')) return console.log(JSON.stringify(state, null, 2));
  const v = verdict(state, config.ci.budget);
  const color = v.level === 'over' ? ui.red : v.level === 'warn' ? ui.yellow : ui.green;
  console.log(color(`● ${v.message}`));
  if (state.minutes) console.log(ui.dim(`  ${n(state.minutes)} minutes so far this month.`));
  for (const r of state.repos.slice(0, 8)) console.log(`  ${r.repo.padEnd(40)} ${usd(r.usd).padStart(8)}  ${ui.dim(`${n(r.minutes)} min`)}`);
  if (config.ci.budget.includedUsd === null) {
    console.log(ui.dim(state.plan
      ? `  Allowance from your GitHub ${state.plan} plan ($${state.includedUsd}). Override with ci.budget.includedUsd in ~/.yardmaster/config.json.`
      : `  Assumed a $${state.includedUsd} allowance (GitHub Free). Pro and Team include $18: set ci.budget.includedUsd in ~/.yardmaster/config.json.`));
  }
  if (state.note) console.log(ui.dim(`  ${state.note}`));
}

async function cmdInit(a: CiArgs, ui: Ui): Promise<void> {
  const root = await mainRepoRoot(process.cwd());
  if (!root) throw new Error('Run this inside a git repository.');
  const r = await installGateHook(root, { allowCustomHooksPath: a.has('hooks-path') });
  const config = loadConfig(root);
  const commands = gateCommands(config, root);
  console.log(ui.green(`✔ Push gate ${r.alreadyInstalled ? 'updated' : 'installed'}: ${r.file}`) + (r.chained ? ui.dim(' (your existing pre-push hook still runs first)') : ''));
  console.log(commands.length
    ? `  Before each push it runs ${ui.bold(commands.join(' && '))} once per file tree, so CI isn't started for code that fails.`
    : ui.yellow('  No test command found. Add "verify" (or "ci.verify") to yardmaster.json so the gate can check before pushing.'));
  console.log('  It also warns when a push would restart CI that is still running, and holds pushes to private repos once the month\'s Actions allowance is used up.');
  const workflows = readLocalWorkflows(root);
  const unguarded = workflows.filter((w) => lintWorkflow(w).some((f) => f.code === 'no-guard'));
  console.log('');
  if (!workflows.length) console.log(ui.dim('No GitHub Actions workflows in this repo.'));
  else if (!unguarded.length) console.log(ui.green('✔ Your workflows already use the Yardmaster guard.'));
  else {
    console.log(`${ui.bold('Last step, in your workflow file')} (${unguarded.map((w) => w.path).join(', ')}): skip the suite when this exact tree already passed.`);
    console.log(ui.dim('Yardmaster does not edit workflow files for you. Add:'));
    const ref = await pinnedActionRef(await githubClient().catch(() => null));
    console.log(guardSnippet(ref ?? `${ACTION_REPO}@${ACTION_TAG}`));
    if (!ref) console.log(ui.yellow(`  Couldn't look up the commit behind ${ACTION_TAG}. Replace the tag with that commit's full SHA (git ls-remote https://github.com/${ACTION_REPO} ${ACTION_TAG}): a tag can be moved, a commit can't.`));
    console.log(ui.dim('  Jobs that run only on some branches or events (say, deploy on main) must not depend on the guard, or must be listed in its allow-skipped input.'));
  }
}

async function cmdStatus(ui: Ui): Promise<void> {
  const root = await mainRepoRoot(process.cwd());
  if (!root) throw new Error('Run this inside a git repository.');
  const config = loadConfig(root);
  const installed = await gateHookInstalled(root);
  console.log(installed ? ui.green(`● Push gate on (${config.ci.gate})`) : ui.yellow(`● Push gate not installed. Run ${ui.cyan('ym ci init')}.`));
  const commands = gateCommands(config, root);
  if (installed && config.ci.gate === 'verify') console.log(ui.dim(`  checks: ${commands.join(' && ') || 'none configured'}`));
  const workflows = readLocalWorkflows(root);
  const guarded = workflows.filter((w) => !lintWorkflow(w).some((f) => f.code === 'no-guard'));
  if (workflows.length) console.log(`${guarded.length === workflows.length ? ui.green('●') : ui.yellow('●')} Guard in ${guarded.length} of ${workflows.length} workflow(s)`);
  const slug = await originSlug(root);
  const state = slug ? budgetForNow(readBudget(slug.split('/')[0]!)) : null;
  if (state) {
    const v = verdict(state, config.ci.budget);
    console.log(`${v.level === 'over' ? ui.red('●') : v.level === 'warn' ? ui.yellow('●') : ui.green('●')} ${v.message} ${ui.dim(`(as of ${new Date(state.at).toLocaleString()})`)}`);
  } else console.log(ui.dim(`● Budget not checked yet: ${ui.cyan('ym ci budget')}`));
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  const pushes = recentPushes(common, Date.now() - 86_400_000);
  if (pushes.length) {
    const branches = new Map<string, number>();
    for (const p of pushes) branches.set(p.branch, (branches.get(p.branch) ?? 0) + 1);
    const busiest = [...branches.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([b, c]) => `${b} ×${c}`).join(', ');
    console.log(`● ${pushes.length} push(es) through the gate in the last 24h ${ui.dim(`(${busiest})`)}`);
  }
}

async function cmdShip(a: CiArgs, ui: Ui): Promise<void> {
  const root = await mainRepoRoot(process.cwd());
  if (!root) throw new Error('Run this inside a git repository.');
  const config = loadConfig(root);
  const gh = await githubClient();
  const r = await ship({ root, config, gh, remote: a.flag('remote') ?? 'origin', branch: a.flag('branch'), base: a.flag('base'), draft: a.has('draft'), title: a.flag('title') });
  if (r.gateOutput) console.log(ui.dim(r.gateOutput));
  console.log(ui.green(`✔ Pushed ${r.tasks.length ? `${r.tasks.length} finished task(s)` : 'the integration branch'} as one branch.`));
  if (r.url) console.log(r.created ? `  Pull request: ${ui.cyan(r.url)}` : `  ${r.url.includes('/compare/') ? 'Open a pull request' : 'Updated pull request'}: ${ui.cyan(r.url)}`);
}

async function cmdSignoff(a: CiArgs, ui: Ui): Promise<void> {
  const cwd = (await repoRoot(process.cwd())) ?? process.cwd();
  const gh = await needToken();
  const slug = a.flag('slug') ?? (await originSlug(cwd));
  if (!slug) throw new Error('No GitHub remote named origin; pass --slug owner/repo.');
  const rev = a.flag('sha') ?? a.positional[0] ?? 'HEAD';
  const sha = (await git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`])).stdout.trim();
  const r = await signoff(gh, { cwd, slug, sha, waitSeconds: Number(a.flag('wait') ?? 30), log: (s) => console.log(ui.dim(s)) });
  console.log(r.ok ? ui.green(`✔ ${r.message}`) : ui.red(`✖ ${r.message}`));
  if (!r.ok) process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdGate(a: CiArgs): Promise<void> {
  // Called by git as: pre-push <remote-name> <remote-url>, with the refs on stdin.
  const remoteUrl = a.positional[1] ?? a.positional[0] ?? '';
  const r = await runGate({ cwd: process.cwd(), remoteUrl, stdin: await readStdin() });
  for (const l of r.lines) console.error(l);
  process.exitCode = r.code;
}

export async function runCi(sub: string | undefined, a: CiArgs, ui: Ui): Promise<void> {
  switch (sub) {
    case 'audit': return cmdAudit(a, ui);
    case 'budget': return cmdBudget(a, ui);
    case 'init': return cmdInit(a, ui);
    case 'status': return cmdStatus(ui);
    case 'ship': return cmdShip(a, ui);
    case 'signoff': return cmdSignoff(a, ui);
    case 'gate': return cmdGate(a);
    case 'uninstall': {
      const root = await mainRepoRoot(process.cwd());
      if (!root) throw new Error('Run this inside a git repository.');
      const r = await uninstallGateHook(root);
      return console.log(r.removed ? ui.green(`✔ Push gate removed${r.restored ? '; your original pre-push hook is back' : ''}.`) : 'No Yardmaster push gate is installed here.');
    }
    default:
      console.log(CI_HELP);
      if (sub && sub !== 'help') process.exitCode = 1;
  }
}

