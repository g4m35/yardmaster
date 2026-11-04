import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { GitHub } from './github.ts';
import type { WorkflowStats } from './analyze.ts';

export interface WorkflowFile {
  path: string;
  text: string;
}

export interface Finding {
  workflow: string;
  level: 'high' | 'medium' | 'low';
  code: string;
  message: string;
  fix?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readLocalWorkflows(root: string): WorkflowFile[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
}

export async function readRemoteWorkflows(gh: GitHub, repo: string): Promise<WorkflowFile[]> {
  const list = await gh.get<{ path: string; type: string }[]>(`/repos/${repo}/contents/.github/workflows`).catch(() => []);
  const files = list.filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.path));
  const out: WorkflowFile[] = [];
  for (const f of files) {
    const c = await gh.get<{ content?: string; encoding?: string }>(`/repos/${repo}/contents/${f.path}`).catch(() => null);
    if (c?.content && c.encoding === 'base64') out.push({ path: f.path, text: Buffer.from(c.content, 'base64').toString('utf8') });
  }
  return out;
}

/** The `on:` block normalized to an object of event -> config. */
function triggers(doc: Obj): Obj {
  const on = doc.on ?? doc.true; // YAML 1.1 parsers read a bare `on` as true
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), {}]));
  return isObj(on) ? Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v ?? {}])) : {};
}

function cancels(concurrency: unknown): boolean {
  if (!isObj(concurrency)) return false;
  const c = concurrency['cancel-in-progress'];
  return c === true || (typeof c === 'string' && c.trim() !== '' && c.trim() !== 'false');
}

function runnerLabels(job: Obj): string[] {
  const out: string[] = [];
  const ro = job['runs-on'];
  const collect = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (isObj(v) && v.labels) collect(v.labels);
  };
  collect(ro);
  const matrix = isObj(job.strategy) ? (job.strategy as Obj).matrix : undefined;
  if (isObj(matrix)) {
    for (const [k, v] of Object.entries(matrix)) {
      if (k === 'include' && Array.isArray(v)) v.forEach((e) => isObj(e) && Object.values(e).forEach(collect));
      else collect(v);
    }
  }
  return out;
}

function usesGuard(doc: Obj): boolean {
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  return Object.values(jobs).some((j) => isObj(j) && Array.isArray(j.steps) && j.steps.some((s) => isObj(s) && typeof s.uses === 'string' && /yardmaster(@|\/action|$)|^\.\/?$/.test(s.uses)));
}

const CANCEL_FIX = `concurrency:
  group: \${{ github.workflow }}-\${{ github.head_ref || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}`;

export function lintWorkflow(file: WorkflowFile, stats?: WorkflowStats, defaultBranch = 'main'): Finding[] {
  let doc: unknown;
  try {
    doc = parse(file.text);
  } catch (err) {
    return [{ workflow: file.path, level: 'low', code: 'unparsable', message: `Could not read this workflow: ${(err as Error).message.split('\n')[0]}` }];
  }
  if (!isObj(doc)) return [];
  const out: Finding[] = [];
  const f = (level: Finding['level'], code: string, message: string, fix?: string) => out.push({ workflow: file.path, level, code, message, fix });
  const on = triggers(doc);
  const jobs = isObj(doc.jobs) ? (doc.jobs as Obj) : {};
  const pr = 'pull_request' in on;
  const push = isObj(on.push) ? (on.push as Obj) : 'push' in on ? {} : null;
  const pushAll = push !== null && !push.branches && !push['branches-ignore'] && !push.tags;
  const pushDefault = push !== null && (pushAll || (Array.isArray(push.branches) && push.branches.some((b) => b === defaultBranch || b === '**' || b === '*')));

  if ((pr || pushAll) && !cancels(doc.concurrency) && !Object.values(jobs).some((j) => isObj(j) && cancels(j.concurrency))) {
    f('medium', 'no-cancel', 'Runs for an outdated commit keep going (and billing) after a newer push to the same branch.', CANCEL_FIX);
  }
  if (pr && pushAll) {
    f('high', 'double-trigger', 'Runs on every push to every branch and on pull requests, so each commit on a PR branch runs twice.', `on:\n  pull_request:\n  push:\n    branches: [${defaultBranch}]`);
  }
  if (pushDefault && !usesGuard(doc)) {
    const saved = stats?.retestedMinutes ? ` In this period ${Math.round(stats.retestedMinutes)} minutes went to re-testing file trees that had already passed.` : '';
    f(stats?.retestedMinutes ? 'high' : 'medium', 'no-guard', `After a pull request merges, the same files are tested again on ${defaultBranch}.${saved}`, 'Add the Yardmaster guard (see "ym ci init" or docs/CI.md): one 1-core job skips the suite when this exact tree already passed.');
  }
  const noTimeout = Object.entries(jobs).filter(([, j]) => isObj(j) && j['runs-on'] !== undefined && j['timeout-minutes'] === undefined).map(([k]) => k);
  if (noTimeout.length) f('low', 'no-timeout', `${noTimeout.length} job(s) have no timeout-minutes (${noTimeout.slice(0, 4).join(', ')}); a stuck job can bill for up to 6 hours.`, 'timeout-minutes: 20');
  if (pr) {
    const pricey = Object.entries(jobs).filter(([, j]) => isObj(j) && runnerLabels(j).some((l) => /^(macos|windows)/i.test(l))).map(([k]) => k);
    if (pricey.length) f('medium', 'pricey-os-on-pr', `macOS or Windows runs on every pull request (${pricey.slice(0, 4).join(', ')}). macOS costs about 10x Linux, Windows about 1.7x.`, 'Run those only on the default branch or nightly, and keep pull requests on Linux.');
    const prCfg = isObj(on.pull_request) ? (on.pull_request as Obj) : {};
    if (!/draft/.test(file.text) && !prCfg.types) {
      f('low', 'drafts', 'Draft pull requests run the full suite on every push. Agents often push to drafts many times.', `on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\njobs:\n  test:\n    if: github.event.pull_request.draft != true`);
    }
  }
  if (stats && stats.runs >= 3 && stats.jobsPerRun >= 5 && stats.avgJobMinutes < 2.5) {
    f('medium', 'small-jobs', `${stats.jobsPerRun.toFixed(1)} jobs per run averaging ${stats.avgJobMinutes.toFixed(1)} minutes. Each job is rounded up to a whole minute and repeats checkout and install.`, 'Merge short jobs into fewer, longer ones, or move tiny ones to runs-on: ubuntu-slim ($0.002/min).');
  }
  return out;
}
