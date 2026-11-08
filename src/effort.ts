import { createHash } from 'node:crypto';
import type { AgentSettings, Tier } from './config.ts';
import type { AdapterContext, LaunchSpec } from './adapters/types.ts';

/** Reasoning effort by tier when the user hasn't set one: cheap work thinks less, hard work more. */
export const DEFAULT_EFFORT: Record<Tier, string> = { cheap: 'low', standard: 'medium', strong: 'high' };

/**
 * An effort flag Yardmaster knows how to pass and recognize. `ranked` lists the values the installed CLI documents,
 * weakest first: Claude Code 2.1.319 `--effort` help, and Codex's `ReasoningEffort` enum (codex-rs protocol). Whether a
 * given model accepts a value is the CLI's business; Yardmaster only orders and passes it.
 */
interface EffortControl {
  label: string;
  ranked: readonly string[];
  /** Effort values the user's own `extraArgs` set, in order. */
  fromArgs(args: readonly string[]): string[];
}

function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag && i + 1 < args.length) out.push(args[++i]!);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim();

const CONTROLS: Record<string, EffortControl> = {
  claude: { label: 'Claude Code', ranked: ['low', 'medium', 'high', 'xhigh', 'max'], fromArgs: (args) => flagValues(args, '--effort') },
  codex: {
    label: 'Codex CLI',
    ranked: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    fromArgs(args) {
      const overrides = [...flagValues(args, '-c'), ...flagValues(args, '--config'),
        ...args.filter((a) => /^-c[^=-]/.test(a)).map((a) => a.slice(2))];
      return overrides.map((o) => /^\s*model_reasoning_effort\s*=(.*)$/s.exec(o)?.[1]).filter((v): v is string => v !== undefined).map(unquote);
    },
  },
  // The test double records the effort it was given, so launch paths can be checked without a real CLI.
  mock: { label: 'Mock agent', ranked: ['low', 'medium', 'high', 'xhigh', 'max'], fromArgs: (args) => flagValues(args, '--effort') },
};

/** Ordering for agents with no effort flag, used only to compare an attested level with a minimum. */
const GENERIC_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function supportsEffort(agent: string): boolean {
  return Object.hasOwn(CONTROLS, agent);
}

/** A validated routing decision (JEV) for this launch. Kept apart from `settings.effort` so it is never mistaken for a manual choice. */
export interface RoutedEffort {
  level: string;
  by: 'jev';
}

export type EffortSource =
  /** Yardmaster's tier default. */
  | 'tier-default'
  /** Raised to `minimumEffort` (a generated or routed choice was lower, or there was no tier). */
  | 'floor'
  /** `agents.<agent>.effort[tier]`. */
  | 'manual'
  /** An effort flag in the user's own `extraArgs`; Yardmaster adds none. */
  | 'extra-args'
  /** A validated JEV decision. */
  | 'jev'
  /** No flag; the CLI's own configuration decides and Yardmaster does not know the value. */
  | 'native'
  /** No flag; the operator stated the level the CLI's own configuration uses. */
  | 'native-attested';

export interface EffortResolution {
  agent: string;
  tier: Tier | null;
  ownership: 'managed' | 'native';
  /** The value Yardmaster adds to the command line; null: it adds no effort flag. */
  emitted: string | null;
  /** The effort the launch runs at as far as Yardmaster can tell; null: unknown. */
  effective: string | null;
  source: EffortSource;
  /** How `effective` is known: a flag Yardmaster passed, the user's own flag, the operator's attestation, or not at all. */
  evidence: 'launch-flag' | 'user-flag' | 'attested' | 'unknown';
  minimum: string | null;
  /** The generated or routed value before the minimum raised it. */
  raisedFrom?: string;
  /** A custom `command` receives the flag; its honoring the flag rests on `attestedEffort`. */
  customCommand: boolean;
}

export type EffortPolicyCode = 'unsupported_floor' | 'unranked_effort' | 'below_floor' | 'native_floor_unattested' | 'custom_command_unattested' | 'conflicting_effort';

/** The launch would break the configured effort policy. Thrown before anything starts; never downgraded silently. */
export class EffortPolicyError extends Error {
  readonly code: EffortPolicyCode;
  readonly agent: string;
  constructor(agent: string, code: EffortPolicyCode, message: string) {
    super(message);
    this.name = 'EffortPolicyError';
    this.agent = agent;
    this.code = code;
  }
}

export interface EffortInput {
  settings: AgentSettings;
  tier?: Tier;
  routedEffort?: RoutedEffort;
}

/**
 * Decides the effort for one launch. Precedence: the user's own `extraArgs` flag, then `effort[tier]` (`""` = native),
 * then ownership: native passes nothing, managed passes the routed or tier-default value raised to `minimumEffort`.
 * Explicit choices are never changed: one that conflicts with another, or sits below the minimum, throws.
 */
export function resolveEffort(agent: string, input: EffortInput): EffortResolution {
  const s = input.settings;
  const control = CONTROLS[agent];
  const tier = input.tier ?? null;
  const min = s.minimumEffort ?? null;
  const attested = s.attestedEffort ?? null;
  const customCommand = Boolean(s.command);
  const ownership = control ? s.effortOwnership ?? 'managed' : 'native';
  const fail = (code: EffortPolicyCode, why: string): never => { throw new EffortPolicyError(agent, code, `${agent}: ${why}`); };
  const order = control?.ranked ?? GENERIC_RANK;
  const rank = (v: string) => order.indexOf(v);
  const listed = order.join(', ');
  const base = { agent, tier, ownership, minimum: min, customCommand } as const;

  if (min !== null && rank(min) < 0) fail('unsupported_floor', `minimumEffort "${min}" is not an effort ${control?.label ?? 'Yardmaster'} accepts (${listed}).`);
  const meetsMin = (v: string, what: string) => {
    if (min === null) return;
    if (rank(v) < 0) fail('unranked_effort', `${what} "${v}" cannot be compared with minimumEffort "${min}" (known: ${listed}).`);
    if (rank(v) < rank(min)) fail('below_floor', `${what} "${v}" is below minimumEffort "${min}". Yardmaster does not override an explicit choice; raise it or lower the minimum.`);
  };
  const attestedAtLeastMin = (why: string) => {
    if (min === null) return;
    if (attested === null) fail(why === 'custom' ? 'custom_command_unattested' : 'native_floor_unattested', why === 'custom'
      ? `minimumEffort "${min}" with a custom command: Yardmaster cannot check that "${s.command}" applies its effort flag. Verify it and set attestedEffort, or remove the command.`
      : `minimumEffort "${min}" with ${why}: Yardmaster passes no effort flag and cannot read the CLI's own configuration. Verify it and set attestedEffort, or let Yardmaster manage effort.`);
    meetsMin(attested!, 'attestedEffort');
  };
  const native = (why: string): EffortResolution => {
    if (input.routedEffort) fail('conflicting_effort', `a routed effort "${input.routedEffort.level}" was given for ${why}, where Yardmaster passes none.`);
    attestedAtLeastMin(why);
    return { ...base, emitted: null, effective: attested, source: attested ? 'native-attested' : 'native', evidence: attested ? 'attested' : 'unknown' };
  };

  if (!control) {
    if (min !== null && attested === null) fail('unsupported_floor', `minimumEffort "${min}" is set, but Yardmaster has no effort setting it can pass to this agent. Verify the agent's own configuration and set attestedEffort, or remove the minimum.`);
    return native('an agent without an effort flag');
  }
  const viaFlag = (r: EffortResolution): EffortResolution => {
    if (customCommand) attestedAtLeastMin('custom');
    return r;
  };

  const userValues = [...new Set(control.fromArgs(s.extraArgs))];
  if (userValues.length > 1) fail('conflicting_effort', `extraArgs set effort more than once (${userValues.join(', ')}).`);
  const userFlag = userValues[0];
  const manual = tier !== null && Object.hasOwn(s.effort, tier) ? s.effort[tier] : undefined;

  if (userFlag !== undefined) {
    if (manual && manual !== userFlag) fail('conflicting_effort', `effort.${tier} is "${manual}" but extraArgs set "${userFlag}". Keep one.`);
    if (input.routedEffort && input.routedEffort.level !== userFlag) fail('conflicting_effort', `extraArgs set effort "${userFlag}", which a routed effort must not replace.`);
    meetsMin(userFlag, 'The effort in extraArgs');
    return viaFlag({ ...base, emitted: null, effective: userFlag, source: 'extra-args', evidence: 'user-flag' });
  }
  if (manual === '') return native(`effort.${tier} set to "" (native)`);
  if (manual !== undefined) {
    if (input.routedEffort && input.routedEffort.level !== manual) fail('conflicting_effort', `effort.${tier} is "${manual}", which a routed effort must not replace.`);
    meetsMin(manual, `effort.${tier}`);
    return viaFlag({ ...base, emitted: manual, effective: manual, source: 'manual', evidence: 'launch-flag' });
  }
  if (ownership === 'native') return native('native effort ownership');

  const chosen = input.routedEffort?.level ?? (tier ? DEFAULT_EFFORT[tier] : null);
  const chosenSource: EffortSource = input.routedEffort ? 'jev' : 'tier-default';
  if (chosen === null) {
    // No tier (one-off helper runs): previously no flag. Keep that unless a minimum asks for one.
    if (min === null) return native('a launch without a tier');
    return viaFlag({ ...base, emitted: min, effective: min, source: 'floor', evidence: 'launch-flag' });
  }
  if (min !== null && rank(chosen) < 0) fail('unranked_effort', `the ${chosenSource} effort "${chosen}" cannot be compared with minimumEffort "${min}".`);
  if (min !== null && rank(chosen) < rank(min)) return viaFlag({ ...base, emitted: min, effective: min, source: 'floor', evidence: 'launch-flag', raisedFrom: chosen });
  return viaFlag({ ...base, emitted: chosen, effective: chosen, source: chosenSource, evidence: 'launch-flag' });
}

const recorded = new WeakMap<LaunchSpec, EffortResolution>();

/** Adapters call this on the spec they return, so callers can read back exactly what that launch used. */
export function withEffort(spec: LaunchSpec, effort: EffortResolution): LaunchSpec {
  recorded.set(spec, effort);
  return spec;
}

/**
 * The effort resolution behind a built launch, for persisting with the run. Specs from adapters that don't apply the
 * policy (third-party plugins) are resolved here instead, so a configured minimum still fails loudly rather than being
 * silently skipped.
 */
export function launchEffort(agent: string, ctx: AdapterContext & { routedEffort?: RoutedEffort }, spec: LaunchSpec): EffortResolution {
  return recorded.get(spec) ?? resolveEffort(agent, ctx);
}

/** One-line summary for activity logs; carries no prompt or argument text. */
export function describeEffort(e: EffortResolution): string {
  const value = e.effective ?? 'unknown (the agent\'s own configuration)';
  const floor = e.minimum ? `, minimum ${e.minimum}` : '';
  const raised = e.raisedFrom ? `, raised from ${e.raisedFrom}` : '';
  return `effort ${value} (${e.source}${raised}${floor})`;
}

/**
 * What a provider session's shape depends on, without anything volatile (prompt, session/task ids, worktree path,
 * remaining budget) or secret (extra argument values and environment values are reduced to a hash or names).
 */
export interface LaunchIdentity {
  v: 1;
  agent: string;
  command: string;
  model: string | null;
  /** The effort on the command line, from Yardmaster or the user's own flag; null when none is passed. */
  effort: string | null;
  /** True when the CLI's own configuration decides effort: a change there is invisible to this identity. */
  nativeEffort: boolean;
  readOnly: boolean;
  autonomy: AgentSettings['autonomy'];
  context: AgentSettings['context'];
  tools: string[] | null;
  mcpConfig: string | null;
  sandbox: AgentSettings['sandbox'] | null;
  extraArgs: { count: number; sha256: string | null };
  /** Names of variables the launch sets (values omitted). */
  env: string[];
  /** Caller-supplied, e.g. the CLI version when known. */
  hostVersion: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Identity of a built launch, plus a fingerprint to persist with its session. Compute it from the final spec (after
 * any env the caller adds). Equal fingerprints say the launch shape matches; they do not prove a provider cache hit.
 */
export function launchIdentity(agent: string, ctx: AdapterContext & { routedEffort?: RoutedEffort }, spec: LaunchSpec, opts: { hostVersion?: string } = {}): { identity: LaunchIdentity; fingerprint: string } {
  const effort = launchEffort(agent, ctx, spec);
  const s = ctx.settings;
  const identity: LaunchIdentity = {
    v: 1,
    agent,
    command: spec.command,
    model: ctx.model,
    effort: effort.evidence === 'launch-flag' || effort.evidence === 'user-flag' ? effort.effective : null,
    nativeEffort: effort.emitted === null && effort.evidence !== 'user-flag',
    readOnly: Boolean(ctx.readOnly),
    autonomy: s.autonomy,
    context: s.context,
    tools: s.tools ? [...s.tools] : null,
    mcpConfig: s.mcpConfig ?? null,
    sandbox: s.sandbox ? { enabled: s.sandbox.enabled, allowedDomains: [...s.sandbox.allowedDomains].sort(), allowWrite: [...s.sandbox.allowWrite].sort() } : null,
    extraArgs: { count: s.extraArgs.length, sha256: s.extraArgs.length ? sha256(JSON.stringify(s.extraArgs)) : null },
    env: Object.keys(spec.env ?? {}).filter((key) => !['YM_MOCK_SESSION', 'YM_MOCK_RESUME', 'YARDMASTER_TASK_ID', 'YARDMASTER_ATTEMPT', 'YARDMASTER_GENERATION', 'YARDMASTER_PROJECT_ID', 'YARDMASTER_REVIEW_ROUND'].includes(key)).sort(),
    hostVersion: opts.hostVersion ?? null,
  };
  return { identity, fingerprint: `lf1:${sha256(canonical(identity)).slice(0, 32)}` };
}

/** Fields that differ between two identities. Any difference means the next launch should start a fresh session. */
export function launchIdentityChanges(prev: LaunchIdentity, next: LaunchIdentity): (keyof LaunchIdentity)[] {
  return (Object.keys(next) as (keyof LaunchIdentity)[]).filter((k) => canonical(prev[k]) !== canonical(next[k]));
}
