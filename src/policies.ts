import type { Config, Policy, Tier } from './config.ts';
import { scopesOverlap } from './scope.ts';

export interface PolicyInput {
  title: string;
  prompt: string;
  scope: string[];
  tier: Tier;
  createdBy: string;
}

export type PolicyEffects = Policy['set'];

/**
 * Applies the repo's rules ("anything under src/auth gets a strong model and a review", "docs tasks are cheap",
 * "migrations need approval"). Rules are evaluated in order; the first rule that sets a field wins, guidance
 * from every matching rule is combined. Explicit choices on the task itself always beat rules.
 */
export function applyPolicies(config: Config, input: PolicyInput): { effects: PolicyEffects; matched: string[] } {
  const effects: PolicyEffects = {};
  const matched: string[] = [];
  const guidance: string[] = [];
  config.policies.forEach((p, i) => {
    if (!policyMatches(p, input)) return;
    matched.push(p.name ?? `policy ${i + 1}`);
    for (const [k, v] of Object.entries(p.set) as [keyof PolicyEffects, unknown][]) {
      if (k === 'guidance') guidance.push(String(v));
      else if (effects[k] === undefined) (effects as Record<string, unknown>)[k] = v;
    }
  });
  if (guidance.length) effects.guidance = guidance.join('\n');
  return { effects, matched };
}

export function policyMatches(p: Policy, input: PolicyInput): boolean {
  const w = p.when;
  if (w.tier && w.tier !== input.tier) return false;
  if (w.createdBy && !input.createdBy.startsWith(w.createdBy)) return false;
  if (w.files?.length && !scopesOverlap(w.files, input.scope).length) return false;
  if (w.text) {
    let re: RegExp;
    try {
      re = new RegExp(w.text, 'i');
    } catch {
      return false;
    }
    if (!re.test(`${input.title}\n${input.prompt}`)) return false;
  }
  return true;
}
