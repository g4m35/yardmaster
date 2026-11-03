import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { expandHome, paths, yardHome } from './paths.ts';

export const TIERS = ['cheap', 'standard', 'strong'] as const;
export type Tier = (typeof TIERS)[number];
export const TierSchema = z.enum(TIERS);

const AgentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().optional(),
  models: z.partialRecord(TierSchema, z.string()).default({}),
  maxParallel: z.number().int().min(1).default(3),
  extraArgs: z.array(z.string()).default([]),
  /** Passed to agents that support permission modes. Headless runs cannot answer prompts. */
  autonomy: z.enum(['full', 'workspace']).default('workspace'),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

const PriceSchema = z.object({ inPerM: z.number(), outPerM: z.number(), cachedInPerM: z.number().optional() });

export const PolicySchema = z.object({
  name: z.string().optional(),
  when: z
    .object({
      files: z.array(z.string()).optional().describe('Matches if the task scope overlaps any of these globs.'),
      text: z.string().optional().describe('Case-insensitive regex tested against title and prompt.'),
      tier: TierSchema.optional(),
      createdBy: z.string().optional(),
    })
    .default({}),
  set: z.object({
    tier: TierSchema.optional(),
    agent: z.string().optional(),
    review: z.enum(['always', 'never']).optional(),
    bestOf: z.number().int().min(1).max(4).optional(),
    verify: z.array(z.string()).optional(),
    requireApproval: z.boolean().optional(),
    budgetUsd: z.number().positive().optional(),
    priority: z.number().int().min(-10).max(10).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    /** House rules added to the agent's brief for matching work. */
    guidance: z.string().max(2000).optional(),
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const ConfigSchema = z.object({
  preset: z.enum(['frugal', 'balanced', 'fast', 'careful']).default('balanced'),
  baseBranch: z.string().optional(),
  integration: z
    .object({
      mode: z.enum(['branch', 'none']).default('branch'),
      branch: z.string().default('yardmaster/integration'),
      requireApproval: z.boolean().default(false),
      maxConflictRounds: z.number().int().min(0).default(2),
      syncBase: z.boolean().default(true),
      /** Merge up to this many verified tasks together and run checks once (1 = one at a time). */
      trainSize: z.number().int().min(1).max(10).default(4),
    })
    .default({ mode: 'branch', branch: 'yardmaster/integration', requireApproval: false, maxConflictRounds: 2, syncBase: true, trainSize: 4 }),
  verify: z.array(z.string()).default([]),
  verifyTimeoutMinutes: z.number().default(20),
  verifyParallel: z.number().int().min(1).default(1),
  maxParallel: z.number().int().min(1).default(3),
  defaultTier: TierSchema.optional(),
  agents: z.record(z.string(), AgentSettingsSchema.partial()).default({}),
  routing: z.partialRecord(TierSchema, z.array(z.string())).default({}),
  budget: z
    .object({
      perTaskUsd: z.number().nullable().default(3),
      dailyUsd: z.number().nullable().default(25),
    })
    .default({ perTaskUsd: 3, dailyUsd: 25 }),
  pricing: z.record(z.string(), PriceSchema).default({}),
  watchdog: z
    .object({
      repeatThreshold: z.number().int().min(2).default(4),
      oscillationCycles: z.number().int().min(2).default(3),
      sameToolErrorLimit: z.number().int().min(2).default(4),
      stallMinutes: z.number().default(10),
      awaitingInputMinutes: z.number().default(2),
      maxRuntimeMinutes: z.number().default(45),
    })
    .default({ repeatThreshold: 4, oscillationCycles: 3, sameToolErrorLimit: 4, stallMinutes: 10, awaitingInputMinutes: 2, maxRuntimeMinutes: 45 }),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      escalate: z.boolean().default(true),
      sameFailureLimit: z.number().int().min(2).default(2),
      backoffSeconds: z.number().default(20),
    })
    .default({ maxAttempts: 3, escalate: true, sameFailureLimit: 2, backoffSeconds: 20 }),
  hotFiles: z.array(z.string()).default([
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum',
    '**/migrations/**', '.github/workflows/**',
  ]),
  unknownScope: z.enum(['parallel', 'exclusive']).default('parallel'),
  scopeEnforcement: z.enum(['warn', 'block']).default('warn'),
  liveOverlapCheck: z.boolean().default(true),
  liveOverlapIntervalSeconds: z.number().min(0.2).default(10),
  /** Where task worktrees live. Empty means <YARDMASTER_HOME>/worktrees. */
  worktreeRoot: z.string().default(''),
  resources: z
    .object({ maxLoadPerCpu: z.number().default(0.9), minFreeMemMb: z.number().default(1024) })
    .default({ maxLoadPerCpu: 0.9, minFreeMemMb: 1024 }),
  cleanup: z
    .object({ auto: z.boolean().default(true), logRetentionDays: z.number().default(14), deleteMergedBranches: z.boolean().default(true) })
    .default({ auto: true, logRetentionDays: 14, deleteMergedBranches: true }),
  disk: z
    .object({
      /** Hold new work when the worktree disk has less than this free. */
      minFreeGb: z.number().min(0).default(5),
      /** Upper bound for Yardmaster's own worktrees; null means no quota. */
      maxWorktreesGb: z.number().positive().nullable().default(40),
      /** Delete regenerable build output (only git-ignored dirs from this list) in worktrees that are kept but idle. */
      trimArtifacts: z.boolean().default(true),
      artifactDirs: z.array(z.string()).default(['node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'coverage', '.gradle']),
      maxLogsMb: z.number().positive().default(500),
    })
    .default({ minFreeGb: 5, maxWorktreesGb: 40, trimArtifacts: true, artifactDirs: ['node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'coverage', '.gradle'], maxLogsMb: 500 }),
  supervision: z
    .object({
      /** Warn when a running agent has made no file changes for this long. */
      slowProgressMinutes: z.number().positive().default(8),
      /** Explain when runnable work has not started for this long. */
      queueStallMinutes: z.number().positive().default(3),
      /** Release a reservation when its session has been gone this long and it blocks queued work. */
      idleLockMinutes: z.number().positive().default(20),
      /** Warn when today's budget is projected to run out within this many minutes. */
      budgetWarnMinutes: z.number().positive().default(60),
    })
    .default({ slowProgressMinutes: 8, queueStallMinutes: 3, idleLockMinutes: 20, budgetWarnMinutes: 60 }),
  /** Rules that adjust tasks by what they touch or say. First match wins per field; later rules fill gaps. */
  policies: z.array(PolicySchema).default([]),
  review: z
    .object({
      /** auto: review strong-tier work, hot files, and big diffs. always / never are what they say. */
      mode: z.enum(['auto', 'always', 'never']).default('auto'),
      minChangedLines: z.number().int().min(1).default(200),
      maxRounds: z.number().int().min(0).max(3).default(1),
      /** Preferred reviewers; a different model family from the implementer is chosen when possible. */
      reviewers: z.array(z.string()).default(['claude', 'codex', 'gemini', 'cursor', 'opencode']),
      crossFamily: z.boolean().default(true),
      /** If the reviewer still objects after the last round: proceed with a note, or stop for a person. */
      onUnresolved: z.enum(['proceed', 'needs_human']).default('proceed'),
    })
    .default({ mode: 'auto', minChangedLines: 200, maxRounds: 1, reviewers: ['claude', 'codex', 'gemini', 'cursor', 'opencode'], crossFamily: true, onUnresolved: 'proceed' }),
  learning: z
    .object({
      /** Pick agents by their verified track record on this repo, not just list order. */
      routing: z.boolean().default(true),
      /** Chance of trying an agent with little history so the stats stay honest. */
      explore: z.number().min(0).max(0.5).default(0.1),
      /** How much cost matters relative to success rate (0 = only quality). */
      costWeight: z.number().min(0).max(3).default(0.5),
      minRuns: z.number().int().min(1).default(3),
      /** Capture lessons from fixed failures, reviews and your redirects, and brief future agents with them. */
      lessons: z.boolean().default(true),
      maxLessonsPerBrief: z.number().int().min(0).max(12).default(4),
    })
    .default({ routing: true, explore: 0.1, costWeight: 0.5, minRuns: 3, lessons: true, maxLessonsPerBrief: 4 }),
  /** Import-graph awareness: tasks editing files that import each other are warned (or kept apart). */
  coupling: z.enum(['off', 'warn', 'serialize']).default('warn'),
  notify: z.boolean().default(true),
  hub: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().default(7777) })
    .default({ host: '127.0.0.1', port: 7777 }),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/**
 * Presets are named bundles of settings, in the spirit of DeepSeek Harness modes:
 * one word changes how aggressive, cheap, or careful the whole fleet is.
 */
export const PRESETS: Record<Config['preset'], ConfigInput> = {
  frugal: {
    maxParallel: 2,
    defaultTier: 'cheap',
    budget: { perTaskUsd: 1, dailyUsd: 8 },
    retry: { maxAttempts: 3, escalate: true, sameFailureLimit: 2, backoffSeconds: 30 },
  },
  balanced: {},
  fast: {
    maxParallel: 6,
    defaultTier: 'standard',
    verifyParallel: 2,
    retry: { maxAttempts: 3, escalate: true, sameFailureLimit: 2, backoffSeconds: 5 },
  },
  careful: {
    maxParallel: 2,
    defaultTier: 'strong',
    unknownScope: 'exclusive',
    scopeEnforcement: 'block',
    integration: { requireApproval: true },
    retry: { maxAttempts: 2, escalate: false, sameFailureLimit: 2, backoffSeconds: 30 },
  },
};

export const DEFAULT_AGENTS: Record<string, AgentSettings> = {
  claude: { enabled: true, models: { cheap: 'haiku', standard: 'sonnet', strong: 'opus' }, maxParallel: 3, extraArgs: [], autonomy: 'workspace' },
  codex: { enabled: true, models: {}, maxParallel: 3, extraArgs: [], autonomy: 'workspace' },
  opencode: { enabled: true, models: {}, maxParallel: 2, extraArgs: [], autonomy: 'workspace' },
  cursor: { enabled: true, models: {}, maxParallel: 2, extraArgs: [], autonomy: 'workspace' },
  gemini: { enabled: true, models: {}, maxParallel: 2, extraArgs: [], autonomy: 'workspace' },
  mock: { enabled: true, models: {}, maxParallel: 8, extraArgs: [], autonomy: 'workspace' },
};

export const DEFAULT_ROUTING: Record<Tier, string[]> = {
  cheap: ['claude', 'codex', 'opencode', 'gemini', 'cursor'],
  standard: ['claude', 'codex', 'opencode', 'cursor', 'gemini'],
  strong: ['claude', 'codex', 'cursor', 'opencode', 'gemini'],
};

/** Rough list prices (USD per million tokens) for estimating spend when an agent CLI reports tokens but not dollars. */
export const DEFAULT_PRICING: Record<string, z.infer<typeof PriceSchema>> = {
  codex: { inPerM: 1.25, cachedInPerM: 0.125, outPerM: 10 },
  cursor: { inPerM: 1.25, cachedInPerM: 0.125, outPerM: 10 },
  gemini: { inPerM: 1.25, cachedInPerM: 0.31, outPerM: 10 },
  default: { inPerM: 3, cachedInPerM: 0.3, outPerM: 15 },
};

export const PROJECT_CONFIG_FILE = 'yardmaster.json';

function readJson(file: string): unknown {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

export function resolveConfig(layers: unknown[]): Config {
  const userMerged = layers.reduce<unknown>((acc, l) => deepMerge(acc, l), {});
  const preset = isPlainObject(userMerged) && typeof userMerged.preset === 'string' ? userMerged.preset : 'balanced';
  const presetLayer = PRESETS[preset as Config['preset']];
  if (!presetLayer) throw new Error(`Unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
  const merged = deepMerge(presetLayer, userMerged);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid Yardmaster config:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadGlobalConfigRaw(): unknown {
  return readJson(paths.globalConfig());
}

export function loadConfig(projectRoot?: string, overrides: unknown = {}): Config {
  const layers: unknown[] = [loadGlobalConfigRaw()];
  if (projectRoot) layers.push(readJson(join(projectRoot, PROJECT_CONFIG_FILE)));
  layers.push(overrides);
  return resolveConfig(layers);
}

export function agentSettings(config: Config, agent: string): AgentSettings {
  const base = DEFAULT_AGENTS[agent] ?? { enabled: true, models: {}, maxParallel: 2, extraArgs: [], autonomy: 'workspace' as const };
  const over = config.agents[agent] ?? {};
  return { ...base, ...over, models: { ...base.models, ...(over.models ?? {}) } };
}

export function routingFor(config: Config, tier: Tier): string[] {
  return config.routing[tier] ?? DEFAULT_ROUTING[tier];
}

export function priceFor(config: Config, agent: string, model?: string | null) {
  return (
    (model ? config.pricing[`${agent}:${model}`] : undefined) ??
    config.pricing[agent] ??
    DEFAULT_PRICING[agent] ??
    config.pricing.default ??
    DEFAULT_PRICING.default!
  );
}

export function writeProjectConfig(root: string, cfg: Record<string, unknown>): string {
  const file = join(root, PROJECT_CONFIG_FILE);
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

export function worktreeRootOf(config: Pick<Config, 'worktreeRoot'>): string {
  return config.worktreeRoot ? expandHome(config.worktreeRoot) : join(yardHome(), 'worktrees');
}

/** Model family per agent, used to pick a reviewer that doesn't share the implementer's blind spots. */
export const AGENT_FAMILY: Record<string, string> = { claude: 'anthropic', codex: 'openai', gemini: 'google', cursor: 'mixed', opencode: 'mixed', mock: 'mock' };
