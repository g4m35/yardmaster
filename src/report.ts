import type { Db } from './db.ts';

/**
 * Where the money and the time went: the numbers that say whether parallel agents are paying off. Everything is
 * computed from runs and tasks already recorded; nothing extra is tracked.
 */

export interface Report {
  days: number;
  tasks: { done: number; failed: number; needsYou: number; canceled: number; open: number };
  spend: { total: number; implement: number; review: number; estimated: boolean };
  /** Total spend of merged tasks (all their attempts and reviews) divided by how many merged. */
  perMergedTask: number | null;
  /** Spend that produced nothing merged: tasks that failed or were canceled, plus failed attempts of merged ones. */
  wasted: number;
  retries: { runs: number; resumed: number; avgFresh: number | null; avgResumed: number | null };
  byAgent: { agent: string; model: string | null; runs: number; cost: number; success: number }[];
  /** Median seconds per phase of an attempt. */
  phases: Record<string, number>;
  /** Median seconds from a task being added to its first attempt, and from passing checks to being merged. */
  waits: { toStart: number | null; toMerge: number | null };
  tokens: { in: number; out: number };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface RunRow {
  task_id: string;
  agent: string;
  model: string | null;
  role: string;
  status: string;
  cost_usd: number;
  cost_estimated: number;
  tokens_in: number;
  tokens_out: number;
  attempt: number;
  phases: string;
  resumed: number;
}

interface TaskRow {
  id: string;
  status: string;
  created_at: number;
  started_at: number | null;
  ready_at: number | null;
  finished_at: number | null;
}

export function buildReport(db: Db, opts: { projectId?: string | null; days: number; now?: number }): Report {
  const since = (opts.now ?? Date.now()) - opts.days * 86_400_000;
  const scope = opts.projectId ? ' AND t.project_id = ?' : '';
  const args = opts.projectId ? [since, opts.projectId] : [since];
  const runs = db
    .prepare(`SELECT r.task_id, r.agent, r.model, r.role, r.status, r.cost_usd, r.cost_estimated, r.tokens_in, r.tokens_out, r.attempt, r.phases, r.resumed FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= ?${scope}`)
    .all(...args) as unknown as RunRow[];
  const tasks = db.prepare(`SELECT t.id, t.status, t.created_at, t.started_at, t.ready_at, t.finished_at FROM tasks t WHERE (t.created_at >= ? OR t.updated_at >= ?)${scope}`).all(since, ...args) as unknown as TaskRow[];
  const status = new Map(tasks.map((t) => [t.id, t.status]));

  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const sum = (rs: RunRow[]) => rs.reduce((n, r) => n + r.cost_usd, 0);
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const doneSpend = sum(runs.filter((r) => done.has(r.task_id)));
  const wasted = sum(runs.filter((r) => ['failed', 'canceled'].includes(status.get(r.task_id) ?? '') || (done.has(r.task_id) && r.role === 'implement' && r.status === 'failed')));

  const impl = runs.filter((r) => r.role === 'implement');
  const retries = impl.filter((r) => r.attempt > 1);
  const resumed = retries.filter((r) => r.resumed);
  const fresh = retries.filter((r) => !r.resumed);
  const avg = (rs: RunRow[]) => (rs.length ? sum(rs) / rs.length : null);

  const agents = new Map<string, { agent: string; model: string | null; runs: number; cost: number; success: number }>();
  for (const r of runs) {
    const k = `${r.agent}\0${r.model ?? ''}\0${r.role}`;
    const a = agents.get(k) ?? { agent: r.role === 'review' ? `${r.agent} (review)` : r.agent, model: r.model, runs: 0, cost: 0, success: 0 };
    a.runs++;
    a.cost += r.cost_usd;
    if (r.status === 'succeeded') a.success++;
    agents.set(k, a);
  }

  const phaseValues: Record<string, number[]> = {};
  for (const r of impl) {
    let p: Record<string, number> = {};
    try {
      p = JSON.parse(r.phases || '{}') as Record<string, number>;
    } catch {
      // older rows
    }
    for (const [k, v] of Object.entries(p)) (phaseValues[k] ??= []).push(v / 1000);
  }
  const phases = Object.fromEntries(Object.entries(phaseValues).map(([k, v]) => [k, median(v)!]));

  return {
    days: opts.days,
    tasks: { done: done.size, failed: count('failed'), needsYou: count('needs_human'), canceled: count('canceled'), open: tasks.filter((t) => ['queued', 'running', 'verifying', 'ready', 'merging'].includes(t.status)).length },
    spend: { total: sum(runs), implement: sum(impl), review: sum(runs.filter((r) => r.role === 'review')), estimated: runs.some((r) => r.cost_estimated) },
    perMergedTask: done.size ? doneSpend / done.size : null,
    wasted,
    retries: { runs: retries.length, resumed: resumed.length, avgFresh: avg(fresh), avgResumed: avg(resumed) },
    byAgent: [...agents.values()].sort((a, b) => b.cost - a.cost),
    phases,
    waits: {
      toStart: median(tasks.filter((t) => t.started_at).map((t) => (t.started_at! - t.created_at) / 1000)),
      toMerge: median(tasks.filter((t) => t.status === 'done' && t.ready_at && t.finished_at).map((t) => (t.finished_at! - t.ready_at!) / 1000)),
    },
    tokens: { in: runs.reduce((n, r) => n + r.tokens_in, 0), out: runs.reduce((n, r) => n + r.tokens_out, 0) },
  };
}
