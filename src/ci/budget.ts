import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { yardHome } from '../paths.ts';
import { jobCost } from './cost.ts';
import { GitHubError, mapLimit, type GitHub } from './github.ts';
import { listRuns, loadJobs } from './history.ts';

export interface BudgetState {
  owner: string;
  at: number;
  month: string;
  /** "billing": GitHub's own numbers. "estimate": computed from this month's runs in the owner's private repos. */
  source: 'billing' | 'estimate';
  spentUsd: number;
  /** Already billed beyond the included amount (billing source only). */
  overageUsd: number | null;
  includedUsd: number;
  extraUsd: number;
  projectedUsd: number;
  minutes: number | null;
  repos: { repo: string; usd: number; minutes: number }[];
  note?: string;
}

export const DEFAULT_INCLUDED_USD = 12;

type BudgetCfg = Config['ci']['budget'];

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Share of the calendar month (UTC) that has passed, never less than one day so early projections stay sane. */
export function monthElapsed(now = new Date()): number {
  const start = monthStart(now).getTime();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(86_400_000, now.getTime() - start) / (end - start);
}

function stateFile(owner: string): string {
  const dir = join(yardHome(), 'ci');
  mkdirSync(dir, { recursive: true });
  return join(dir, `budget-${owner.toLowerCase().replace(/[^a-z0-9-]/g, '_')}.json`);
}

export function readBudget(owner: string): BudgetState | null {
  const f = stateFile(owner);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as BudgetState;
  } catch {
    return null;
  }
}

export function writeBudget(state: BudgetState): void {
  writeFileSync(stateFile(state.owner), JSON.stringify(state, null, 2));
}

/** A refresh lock, so many agents pushing at once start one refresh, not dozens. */
export function claimRefresh(owner: string): boolean {
  const lock = stateFile(owner).replace(/\.json$/, '.lock');
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 5 * 60_000) return false;
  writeFileSync(lock, String(process.pid));
  return true;
}

interface SummaryItem {
  product: string;
  sku: string;
  grossAmount: number;
  netAmount: number;
  grossQuantity: number;
  unitType: string;
}

async function fromBilling(gh: GitHub, owner: string, isOrg: boolean, now: Date): Promise<Pick<BudgetState, 'spentUsd' | 'overageUsd' | 'minutes'> | null> {
  const path = isOrg ? `/organizations/${owner}/settings/billing/usage/summary` : `/users/${owner}/settings/billing/usage/summary`;
  try {
    const r = await gh.get<{ usageItems?: SummaryItem[] }>(path, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, product: 'actions' });
    // Storage has its own allowance; the dollar allowance covers compute.
    const items = (r.usageItems ?? []).filter((i) => i.product.toLowerCase() === 'actions' && !/storage/i.test(i.sku));
    const minutes = items.filter((i) => /minute/i.test(i.unitType)).reduce((n, i) => n + i.grossQuantity, 0);
    return {
      spentUsd: items.reduce((n, i) => n + i.grossAmount, 0),
      overageUsd: items.reduce((n, i) => n + i.netAmount, 0),
      minutes: minutes || null,
    };
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 404 || err.status === 401)) return null;
    throw err;
  }
}

/** Private repos pushed to since `since`. A repo nobody pushed to this month rarely runs CI, and skipping it keeps the estimate cheap. */
async function privateRepos(gh: GitHub, owner: string, isOrg: boolean, since: number): Promise<string[]> {
  type R = { full_name: string; pushed_at: string | null };
  let list: R[];
  if (isOrg) list = await gh.paginate<R>(`/orgs/${owner}/repos`, null, { type: 'private', sort: 'pushed' }, 500);
  else {
    const me = await gh.get<{ login: string }>('/user').catch(() => null);
    if (!me || me.login.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Can only estimate spending for your own account (${me?.login ?? 'not logged in'}) or an organization you belong to.`);
    }
    list = await gh.paginate<R>('/user/repos', null, { visibility: 'private', affiliation: 'owner', sort: 'pushed' }, 500);
  }
  return list.filter((r) => !r.pushed_at || Date.parse(r.pushed_at) >= since).map((r) => r.full_name);
}

export async function computeBudget(gh: GitHub, owner: string, cfg: BudgetCfg, opts: { now?: Date; onProgress?: (msg: string) => void } = {}): Promise<BudgetState> {
  const now = opts.now ?? new Date();
  const account = await gh.get<{ type: string; login: string }>(`/users/${owner}`);
  const isOrg = account.type === 'Organization';
  const base = { owner: account.login, at: Date.now(), month: currentMonth(now), includedUsd: cfg.includedUsd ?? DEFAULT_INCLUDED_USD, extraUsd: cfg.extraUsd };
  const billing = await fromBilling(gh, account.login, isOrg, now);
  if (billing) {
    const state: BudgetState = { ...base, source: 'billing', ...billing, projectedUsd: billing.spentUsd / monthElapsed(now), repos: [] };
    writeBudget(state);
    return state;
  }
  const since = monthStart(now).getTime();
  const repos = await privateRepos(gh, account.login, isOrg, since);
  const perRepo = await mapLimit(repos, 4, async (repo, i) => {
    opts.onProgress?.(`${i + 1}/${repos.length} ${repo}`);
    const runs = (await listRuns(gh, repo, since)).filter((r) => r.event !== 'dynamic' || !/dependabot/i.test(r.actor));
    if (!runs.length) return { repo, usd: 0, minutes: 0 };
    const jobs = await loadJobs(gh, repo, runs);
    let usd = 0;
    let minutes = 0;
    for (const list of jobs.values()) {
      for (const j of list) {
        const c = jobCost({ labels: j.labels, startedAt: j.startedAt, completedAt: j.completedAt }, true);
        usd += c.usd;
        if (c.kind !== 'other') minutes += c.billed;
      }
    }
    return { repo, usd, minutes };
  });
  const spentUsd = perRepo.reduce((n, r) => n + r.usd, 0);
  const state: BudgetState = {
    ...base,
    source: 'estimate',
    spentUsd,
    overageUsd: null,
    minutes: perRepo.reduce((n, r) => n + r.minutes, 0),
    projectedUsd: spentUsd / monthElapsed(now),
    repos: perRepo.filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd),
    note: 'Estimated from job times at list prices. For exact numbers, let the token read billing: gh auth refresh -s user (personal) or use an org admin token.',
  };
  writeBudget(state);
  return state;
}

export interface Verdict {
  level: 'ok' | 'warn' | 'over';
  message: string;
}

/** The calendar month (UTC) budget states are kept for, e.g. "2026-11". */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A cached state counts only for the month it was measured in: allowances reset on the 1st. */
export function budgetForNow(state: BudgetState | null, now = new Date()): BudgetState | null {
  return state && state.month === currentMonth(now) ? state : null;
}

/** Judged against the current settings, not the ones in force when the numbers were cached. */
export function verdict(state: BudgetState, cfg: BudgetCfg): Verdict {
  const limit = (cfg.includedUsd ?? DEFAULT_INCLUDED_USD) + cfg.extraUsd;
  const pct = limit > 0 ? Math.round((state.spentUsd / limit) * 100) : 100;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const head = `${state.owner}: ${money(state.spentUsd)} of ${money(limit)} Actions allowance used this month (${pct}%${state.source === 'estimate' ? ', estimated' : ''})`;
  if (state.spentUsd >= limit) return { level: 'over', message: `${head}. More CI runs are paid or will be refused by GitHub.` };
  if (state.projectedUsd >= limit * cfg.warnAt) return { level: 'warn', message: `${head}; on pace for ${money(state.projectedUsd)} by month end.` };
  return { level: 'ok', message: `${head}; on pace for ${money(state.projectedUsd)}.` };
}
