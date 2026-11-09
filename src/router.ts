import { agentSettings, routingFor, TIERS, type Config, type Tier } from './config.ts';

const CHEAP = /\b(typo|typos|readme|docs?|documentation|comment|comments|rename|lint|format|formatting|bump|changelog|copy ?edit|wording|spelling|license header)\b/i;
const STRONG = /\b(architect(?:ure)?|design|security|vulnerabilit(?:y|ies)|migrat(?:e[ds]?|ing|ions?)|concurren(?:t|cy)|race conditions?|deadlocks?|performance|optimi[sz](?:e[ds]?|ing|ations?)|rewrite|refactor (the )?(whole|entire)|across the (codebase|repo)|auth(entication|orization)?|crypto|payments?|billing)\b/i;

/** Cheap heuristic so non-technical users get sensible model sizes without choosing one. */
export function inferTier(text: string, fallback: Tier = 'standard'): Tier {
  if (STRONG.test(text)) return 'strong';
  if (CHEAP.test(text) && text.length < 600) return 'cheap';
  return fallback;
}

/**
 * Small enough for the cheap tier: 1 to 3 specific files (no "**" globs), a short ask, and checks that will catch a
 * mistake. A failure retries, then escalates, so the worst case is a retry; the usual case costs about a twentieth.
 */
export function isSmallCheckedTask(scope: string[], prompt: string, hasChecks: boolean): boolean {
  return hasChecks && scope.length >= 1 && scope.length <= 3 && scope.every((s) => !s.includes('**')) && prompt.length <= 600;
}

export function escalate(tier: Tier): Tier {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(TIERS.length - 1, i + 1)]!;
}

export interface AgentStats {
  runs: number;
  verified: number;
  cost: number;
  ms: number;
  byTier: Record<string, { runs: number; verified: number; cost: number }>;
  /** JSON-encoded configured model identity (including null) -> tier; legacy aggregates are not model evidence. */
  byModel?: Record<string, Record<string, { runs: number; verified: number; cost: number }>>;
}

export interface RouteChoice {
  agent: string;
  model: string | null;
  reason: string;
}

/**
 * Chooses an agent for a task.
 *
 * Without history (or with learning off) it takes the first installed agent with a free slot from the tier's
 * preference list. With history it scores each candidate by its verified success rate on this repo for this tier
 * (Laplace-smoothed, with the list order as a weak prior) divided by its relative cost raised to `costWeight`, and
 * occasionally explores an agent with little history so the numbers stay honest. Every choice carries a plain
 * reason so people can see why an agent was picked.
 */
export function chooseAgent(opts: {
  config: Config;
  tier: Tier;
  forced: string | null;
  installed: string[];
  runningByAgent: Record<string, number>;
  stats: Record<string, AgentStats>;
  random?: () => number;
}): RouteChoice | null {
  const { config, tier, forced, installed, runningByAgent, stats } = opts;
  const random = opts.random ?? Math.random;
  const prefs = forced ? [forced] : routingFor(config, tier);
  const skipped: string[] = [];
  const available = prefs.filter((agent) => {
    if (!installed.includes(agent)) return false;
    const s = agentSettings(config, agent);
    if (!s.enabled) return false;
    if ((runningByAgent[agent] ?? 0) >= s.maxParallel) {
      skipped.push(`${agent} busy`);
      return false;
    }
    return true;
  });
  if (!available.length) return null;
  const pick = (agent: string, reason: string): RouteChoice => ({
    agent,
    model: agentSettings(config, agent).models[tier] ?? null,
    reason: skipped.length ? `${reason} (${skipped.join(', ')})` : reason,
  });
  if (forced) return pick(forced, 'requested');
  const learn = config.learning;
  const tierStats = (a: string) => {
    const model = agentSettings(config, a).models[tier];
    // An unknown native default is not evidence for a particular current model.
    return (model ? stats[a]?.byModel?.[JSON.stringify(model)]?.[tier] : undefined) ?? { runs: 0, verified: 0, cost: 0 };
  };
  const hasHistory = available.some((a) => tierStats(a).runs >= learn.minRuns);
  if (!learn.routing || !hasHistory || available.length === 1) {
    return pick(available[0]!, `first available for ${tier} work`);
  }
  const fresh = available.filter((a) => tierStats(a).runs < learn.minRuns);
  if (fresh.length && random() < learn.explore) return pick(fresh[0]!, `trying ${fresh[0]} to learn how it does here`);
  const costs = available.map((a) => {
    const t = tierStats(a);
    return t.verified > 0 ? t.cost / t.verified : t.runs > 0 ? t.cost / t.runs : 0;
  });
  const known = costs.filter((c) => c > 0).sort((x, y) => x - y);
  const median = known.length ? known[Math.floor(known.length / 2)]! : 1;
  let best = { agent: available[0]!, score: -Infinity, rate: 0, cost: 0, runs: 0, verified: 0 };
  available.forEach((a, i) => {
    const t = tierStats(a);
    const prior = Math.max(0, 1 - i * 0.25);
    const rate = (t.verified + 1 + prior) / (t.runs + 2 + prior);
    const relCost = costs[i]! > 0 ? costs[i]! / median : 1;
    const score = rate / Math.pow(relCost, learn.costWeight);
    if (score > best.score) best = { agent: a, score, rate, cost: costs[i]!, runs: t.runs, verified: t.verified };
  });
  const why = best.runs ? `best track record for ${tier} work here (${best.verified}/${best.runs} verified, ~$${best.cost.toFixed(2)} each)` : `first available for ${tier} work`;
  return pick(best.agent, why);
}

/** Reviewer for an implementer: a different model family if possible, preferring the configured order. */
export function chooseReviewer(config: Config, implementer: string, installed: string[], family: Record<string, string>): string | null {
  const order = config.review.reviewers.filter((a) => installed.includes(a) && agentSettings(config, a).enabled);
  if (!order.length) return null;
  if (config.review.crossFamily) {
    const other = order.find((a) => family[a] !== family[implementer] && family[a] !== 'mixed');
    if (other) return other;
    const mixed = order.find((a) => a !== implementer);
    if (mixed) return mixed;
  }
  return order[0]!;
}
