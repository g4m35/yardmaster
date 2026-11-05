import { isLargerRunner, jobCost } from './cost.ts';
import type { JobRec, RepoHistory, RunRec } from './history.ts';

export interface Bucket {
  runs: number;
  minutes: number;
  usd: number;
}

export interface WorkflowStats extends Bucket {
  name: string;
  path: string;
  jobsPerRun: number;
  avgJobMinutes: number;
  retestedMinutes: number;
}

export interface Analysis {
  repo: string;
  private: boolean;
  days: number;
  runs: number;
  jobs: number;
  /** Minutes GitHub counts (each job rounded up), on GitHub-hosted runners. */
  minutes: number;
  rawMinutes: number;
  usd: number;
  /** Re-ran an identical file tree that had already passed the same workflow. */
  retested: Bucket;
  /** Failed checks: often an agent using CI to find out whether its change works. */
  failed: Bucket;
  /** Still running (or cancelled) when a newer push to the same branch arrived. */
  superseded: Bucket;
  /** The same commit run twice by the same workflow (push and pull_request both firing). */
  duplicate: Bucket;
  /** Every job is billed in whole minutes. */
  rounding: { minutes: number; usd: number };
  /** Runs in any avoidable bucket above, each counted once. */
  avoidable: Bucket;
  /** Copilot coding agent / code review runs (they use Actions minutes on private repos). */
  copilot: Bucket;
  /** Dependabot runs: free on standard runners. */
  dependabot: Bucket;
  /** Work on branches named like agent branches (claude/, codex/, copilot/, ...). */
  agentBranches: Bucket;
  /** Jobs on self-hosted or third-party runners; GitHub doesn't bill these. */
  otherRunnerJobs: number;
  largerMacJobs: number;
  workflows: WorkflowStats[];
}

const AGENT_BRANCH = /^(claude|codex|copilot|cursor|yardmaster|devin|jules|gemini|opencode|agent|ai|bot)[/_-]/i;
const INTENTIONAL = new Set(['schedule', 'workflow_dispatch', 'repository_dispatch', 'release']);

function empty(): Bucket {
  return { runs: 0, minutes: 0, usd: 0 };
}

function add(b: Bucket, c: { minutes: number; usd: number }): void {
  b.runs++;
  b.minutes += c.minutes;
  b.usd += c.usd;
}

export function analyze(h: RepoHistory, days: number): Analysis {
  const cost = new Map<number, { minutes: number; raw: number; usd: number; jobs: number }>();
  let otherRunnerJobs = 0;
  let largerMacJobs = 0;
  for (const r of h.runs) {
    const jobs: JobRec[] = h.jobs.get(r.id) ?? [];
    const c = { minutes: 0, raw: 0, usd: 0, jobs: jobs.length };
    for (const j of jobs) {
      const jc = jobCost({ labels: j.labels, startedAt: j.startedAt, completedAt: j.completedAt }, h.private);
      if (jc.kind === 'other') {
        if (jc.billed > 0) otherRunnerJobs++;
        continue;
      }
      if (isLargerRunner(jc.kind)) largerMacJobs++;
      c.minutes += jc.billed;
      c.raw += jc.raw;
      c.usd += jc.usd;
    }
    cost.set(r.id, c);
  }
  const costOf = (r: RunRec) => cost.get(r.id) ?? { minutes: 0, raw: 0, usd: 0, jobs: 0 };

  const a: Analysis = {
    repo: h.repo, private: h.private, days, runs: 0, jobs: 0, minutes: 0, rawMinutes: 0, usd: 0,
    retested: empty(), failed: empty(), superseded: empty(), duplicate: empty(), rounding: { minutes: 0, usd: 0 },
    avoidable: empty(), copilot: empty(), dependabot: empty(), agentBranches: empty(), otherRunnerJobs, largerMacJobs, workflows: [],
  };

  const runs = [...h.runs].sort((x, y) => x.createdAt - y.createdAt);
  const avoidable = new Set<number>();
  const retested = new Set<number>();
  const passedTrees = new Map<string, number>(); // workflow|tree -> when it finished
  const shaEvents = new Map<string, Set<string>>();
  const wf = new Map<string, WorkflowStats & { jobs: number; raw: number }>();

  for (const r of runs) {
    const c = costOf(r);
    a.runs++;
    a.jobs += c.jobs;
    a.minutes += c.minutes;
    a.rawMinutes += c.raw;
    a.usd += c.usd;
    if (r.event === 'dynamic') {
      if (/dependabot/i.test(r.actor)) add(a.dependabot, c);
      else add(a.copilot, c);
      continue;
    }
    const key = r.path || r.workflow;
    const w = wf.get(key) ?? { name: r.workflow, path: r.path, runs: 0, minutes: 0, usd: 0, jobsPerRun: 0, avgJobMinutes: 0, retestedMinutes: 0, jobs: 0, raw: 0 };
    w.runs++;
    w.minutes += c.minutes;
    w.usd += c.usd;
    w.jobs += c.jobs;
    w.raw += c.raw;
    wf.set(key, w);
    if (AGENT_BRANCH.test(r.branch)) add(a.agentBranches, c);

    if (!INTENTIONAL.has(r.event)) {
      const passedAt = r.tree ? passedTrees.get(`${key}|${r.tree}`) : undefined;
      if (passedAt !== undefined && passedAt <= r.createdAt) {
        add(a.retested, c);
        w.retestedMinutes += c.minutes;
        retested.add(r.id);
        avoidable.add(r.id);
      }
      if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure') {
        add(a.failed, c);
        avoidable.add(r.id);
      }
      const events = shaEvents.get(`${key}|${r.sha}`) ?? new Set<string>();
      if (events.size && !events.has(r.event) && (r.event === 'push' || r.event === 'pull_request') && !retested.has(r.id)) {
        add(a.duplicate, c);
        avoidable.add(r.id);
      }
      events.add(r.event);
      shaEvents.set(`${key}|${r.sha}`, events);
    }
    if (r.conclusion === 'success' && r.tree) {
      const k = `${key}|${r.tree}`;
      passedTrees.set(k, Math.min(passedTrees.get(k) ?? Infinity, r.updatedAt));
    }
  }

  // Superseded: a newer commit on the same branch started this workflow before this run had finished.
  const byBranch = new Map<string, RunRec[]>();
  for (const r of runs) {
    if (r.event === 'dynamic' || INTENTIONAL.has(r.event) || !r.branch || r.branch === h.defaultBranch) continue;
    const k = `${r.path || r.workflow}|${r.branch}`;
    byBranch.set(k, [...(byBranch.get(k) ?? []), r]);
  }
  for (const list of byBranch.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const r = list[i]!;
      const newer = list.slice(i + 1).find((x) => x.sha !== r.sha);
      if (newer && newer.createdAt < r.updatedAt) {
        add(a.superseded, costOf(r));
        avoidable.add(r.id);
      }
    }
  }

  for (const r of runs) if (avoidable.has(r.id)) add(a.avoidable, costOf(r));
  a.rounding = { minutes: Math.max(0, a.minutes - a.rawMinutes), usd: a.minutes > 0 ? (a.usd * Math.max(0, a.minutes - a.rawMinutes)) / a.minutes : 0 };
  a.workflows = [...wf.values()]
    .map(({ jobs, raw, ...w }) => ({ ...w, jobsPerRun: w.runs ? jobs / w.runs : 0, avgJobMinutes: jobs ? raw / jobs : 0 }))
    .sort((x, y) => y.minutes - x.minutes);
  return a;
}

/** Combine several repos' analyses into one total (for owner-wide reports). */
export function totalOf(list: Analysis[]): Pick<Analysis, 'runs' | 'jobs' | 'minutes' | 'usd' | 'avoidable' | 'retested' | 'failed' | 'superseded' | 'duplicate' | 'rounding'> {
  const sum = (f: (a: Analysis) => Bucket): Bucket => list.reduce((b, a) => ({ runs: b.runs + f(a).runs, minutes: b.minutes + f(a).minutes, usd: b.usd + f(a).usd }), empty());
  return {
    runs: list.reduce((n, a) => n + a.runs, 0),
    jobs: list.reduce((n, a) => n + a.jobs, 0),
    minutes: list.reduce((n, a) => n + a.minutes, 0),
    usd: list.reduce((n, a) => n + a.usd, 0),
    avoidable: sum((a) => a.avoidable),
    retested: sum((a) => a.retested),
    failed: sum((a) => a.failed),
    superseded: sum((a) => a.superseded),
    duplicate: sum((a) => a.duplicate),
    rounding: { minutes: list.reduce((n, a) => n + a.rounding.minutes, 0), usd: list.reduce((n, a) => n + a.rounding.usd, 0) },
  };
}
