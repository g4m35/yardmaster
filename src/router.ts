import { agentSettings, routingFor, TIERS, type Config, type Tier } from './config.ts';

const CHEAP = /\b(typo|typos|readme|docs?|documentation|comment|comments|rename|lint|format|formatting|bump|changelog|copy ?edit|wording|spelling|license header)\b/i;
const STRONG = /\b(architect|architecture|design|security|vulnerab|migrat|concurren|race condition|deadlock|performance|optimi[sz]e|rewrite|refactor (the )?(whole|entire)|across the (codebase|repo)|auth(entication|orization)?|crypto|payment|billing)\b/i;

/** Cheap heuristic so non-technical users get sensible model sizes without choosing one. */
export function inferTier(text: string, fallback: Tier = 'standard'): Tier {
  if (STRONG.test(text)) return 'strong';
  if (CHEAP.test(text) && text.length < 600) return 'cheap';
  return fallback;
}

export function escalate(tier: Tier): Tier {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(TIERS.length - 1, i + 1)]!;
}

export interface AgentStats {
  runs: number;
  verified: number;
}

export interface RouteChoice {
  agent: string;
  model: string | null;
  reason: string;
}

/**
 * Picks the first agent in the tier's preference list that is installed, has a free slot, and
 * has not been repeatedly failing on this project. Explainable on purpose: the reason is shown in the UI.
 */
export function chooseAgent(opts: {
  config: Config;
  tier: Tier;
  forced: string | null;
  installed: string[];
  runningByAgent: Record<string, number>;
  stats: Record<string, AgentStats>;
}): RouteChoice | null {
  const { config, tier, forced, installed, runningByAgent, stats } = opts;
  const candidates = forced ? [forced] : routingFor(config, tier);
  const skipped: string[] = [];
  for (const agent of candidates) {
    if (!installed.includes(agent)) continue;
    const s = agentSettings(config, agent);
    if (!s.enabled) continue;
    if ((runningByAgent[agent] ?? 0) >= s.maxParallel) {
      skipped.push(`${agent} busy`);
      continue;
    }
    const st = stats[agent];
    if (!forced && st && st.runs >= 3 && st.verified / st.runs < 0.3 && candidates.length > 1) {
      skipped.push(`${agent} has been failing here`);
      continue;
    }
    const model = s.models[tier] ?? null;
    const why = forced ? 'requested' : `first available for ${tier} work`;
    return { agent, model, reason: skipped.length ? `${why} (${skipped.join(', ')})` : why };
  }
  return null;
}
