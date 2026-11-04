import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yardHome } from '../paths.ts';
import { mapLimit, type GitHub } from './github.ts';

/** One workflow run, trimmed to what cost analysis needs. */
export interface RunRec {
  id: number;
  workflow: string;
  /** e.g. ".github/workflows/ci.yml"; empty for dynamic runs (Dependabot, Copilot). */
  path: string;
  event: string;
  branch: string;
  sha: string;
  /** Tree of the commit the run was triggered for (for pull requests: the PR head, not the merge result). */
  tree: string | null;
  status: string;
  conclusion: string | null;
  actor: string;
  createdAt: number;
  updatedAt: number;
  url: string;
}

export interface JobRec {
  runId: number;
  name: string;
  labels: string[];
  startedAt: string | null;
  completedAt: string | null;
  conclusion: string | null;
}

export interface RepoHistory {
  repo: string;
  private: boolean;
  defaultBranch: string;
  since: number;
  runs: RunRec[];
  jobs: Map<number, JobRec[]>;
}

interface ApiRun {
  id: number;
  name: string | null;
  path?: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  head_commit?: { tree_id?: string } | null;
  status: string;
  conclusion: string | null;
  actor?: { login?: string } | null;
  triggering_actor?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface ApiJob {
  run_id: number;
  name: string;
  labels: string[];
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
  status: string;
}

function toRun(r: ApiRun): RunRec {
  return {
    id: r.id,
    workflow: r.name ?? r.path ?? 'workflow',
    path: r.path ?? '',
    event: r.event,
    branch: r.head_branch ?? '',
    sha: r.head_sha,
    tree: r.head_commit?.tree_id ?? null,
    status: r.status,
    conclusion: r.conclusion,
    actor: r.actor?.login ?? r.triggering_actor?.login ?? '',
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
    url: r.html_url,
  };
}

const day = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The runs API returns at most 1,000 results per filtered query, so busy repos are fetched a week (or a day) at
 * a time.
 */
export async function listRuns(gh: GitHub, repo: string, since: number, until = Date.now()): Promise<RunRec[]> {
  const out = new Map<number, RunRec>();
  const fetchRange = async (from: number, to: number): Promise<void> => {
    const created = `${isoDay(from)}..${isoDay(to)}`;
    const first = await gh.get<{ total_count: number; workflow_runs: ApiRun[] }>(`/repos/${repo}/actions/runs`, { created, per_page: 100 });
    if (first.total_count > 1000 && to - from > day) {
      const mid = from + Math.floor((to - from) / 2 / day) * day;
      await fetchRange(from, mid);
      await fetchRange(mid + day, to);
      return;
    }
    const all = first.total_count > 100 ? await gh.paginate<ApiRun>(`/repos/${repo}/actions/runs`, 'workflow_runs', { created }) : first.workflow_runs;
    for (const r of all) if (Date.parse(r.created_at) >= since) out.set(r.id, toRun(r));
  };
  for (let from = since; from <= until; from += 7 * day) await fetchRange(from, Math.min(from + 6 * day, until));
  return [...out.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function cacheFile(repo: string): string {
  const dir = join(yardHome(), 'ci', 'cache');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${repo.replace('/', '__')}.json`);
}

/** Cached jobs of a finished run, valid while the run's `updated_at` is unchanged (a re-run keeps the id but moves it). */
interface CacheEntry {
  u: number;
  jobs: JobRec[];
}

function readCache(repo: string): Record<string, CacheEntry> {
  const f = cacheFile(repo);
  if (!existsSync(f)) return {};
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as { v?: number; jobs?: Record<string, CacheEntry> };
    return data.v === 2 ? (data.jobs ?? {}) : {};
  } catch {
    return {};
  }
}

/** Jobs for each run, every attempt included (re-runs are billed too). Finished runs are cached until they change. */
export async function loadJobs(gh: GitHub, repo: string, runs: RunRec[], onProgress?: (done: number, total: number) => void): Promise<Map<number, JobRec[]>> {
  const cache = readCache(repo);
  const out = new Map<number, JobRec[]>();
  const todo = runs.filter((r) => {
    const hit = cache[r.id];
    const fresh = !!hit && r.status === 'completed' && hit.u === r.updatedAt;
    if (fresh) out.set(r.id, hit.jobs);
    return !fresh;
  });
  let done = 0;
  await mapLimit(todo, 8, async (r) => {
    const jobs = await gh.paginate<ApiJob>(`/repos/${repo}/actions/runs/${r.id}/jobs`, 'jobs', { filter: 'all' });
    const recs = jobs.map((j) => ({ runId: r.id, name: j.name, labels: j.labels ?? [], startedAt: j.started_at, completedAt: j.completed_at, conclusion: j.conclusion }));
    out.set(r.id, recs);
    if (r.status === 'completed' && jobs.every((j) => j.status === 'completed')) cache[r.id] = { u: r.updatedAt, jobs: recs };
    else delete cache[r.id];
    onProgress?.(++done, todo.length);
  });
  // Keep the cache to runs we still care about (about three months), so it can't grow without bound.
  const keep = new Set(runs.map((r) => String(r.id)));
  const ids = Object.keys(cache).sort((a, b) => Number(b) - Number(a));
  const trimmed = Object.fromEntries(ids.filter((id, i) => keep.has(id) || i < 20_000).map((id) => [id, cache[id]!]));
  writeFileSync(cacheFile(repo), JSON.stringify({ v: 2, jobs: trimmed }));
  return out;
}

export async function repoHistory(gh: GitHub, repo: string, days: number, onProgress?: (done: number, total: number) => void): Promise<RepoHistory> {
  const meta = await gh.get<{ private: boolean; default_branch: string }>(`/repos/${repo}`);
  const since = Date.now() - days * day;
  const runs = (await listRuns(gh, repo, since)).filter((r) => r.status === 'completed');
  const jobs = await loadJobs(gh, repo, runs, onProgress);
  return { repo, private: meta.private, defaultBranch: meta.default_branch, since, runs, jobs };
}
