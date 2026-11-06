import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
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
  /**
   * "lean" (default): background runs skip your MCP servers, skills and slash commands, and Claude Code's optional
   * tools. Your CLAUDE.md/AGENTS.md, hooks and permission rules still apply. Measured on Claude Code 2.1: the context
   * every turn re-reads drops from about 61k to 14k tokens, and startup is roughly twice as fast.
   * "full": load everything your interactive sessions load.
   */
  context: z.enum(['lean', 'full']).default('lean'),
  /** Claude Code tools for lean runs (default: the ones coding needs). */
  tools: z.array(z.string()).optional(),
  /** MCP servers lean runs should still load: path to an MCP config JSON (Claude Code `--mcp-config`). */
  mcpConfig: z.string().optional(),
  /** Reasoning effort per tier, e.g. { "cheap": "low", "standard": "medium", "strong": "high" }. Empty string: the agent's default. */
  effort: z.partialRecord(TierSchema, z.string()).default({}),
  /** On retry, continue the previous session instead of starting over (it keeps what the agent already read). */
  resume: z.boolean().default(true),
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
  /**
   * Optional fast checks for each task, limited to what it changed: "{files}" becomes the changed files
   * (e.g. "npx vitest related --run {files}"). When set, the full `verify` list runs at merge time instead,
   * once per merge train, so agents get feedback sooner without weakening what lands.
   */
  verifyQuick: z.array(z.string()).default([]),
  verifyTimeoutMinutes: z.number().default(20),
  /** How many task check runs at once. Unset: about one per 4 CPU cores, up to maxParallel. Merge checks get their own slot. */
  verifyParallel: z.number().int().min(1).optional(),
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
    'yardmaster.json',
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
      /** A review reads the diff it's given plus a few files; these caps keep one from turning into a long session. */
      maxTurns: z.number().int().min(1).default(15),
      budgetUsd: z.number().positive().default(1),
    })
    .default({ mode: 'auto', minChangedLines: 200, maxRounds: 1, reviewers: ['claude', 'codex', 'gemini', 'cursor', 'opencode'], crossFamily: true, onUnresolved: 'proceed', maxTurns: 15, budgetUsd: 1 }),
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
  worktree: z
    .object({
      /** Give new worktrees the project's installed dependencies so agents don't reinstall them. */
      warmStart: z.enum(['clone', 'off']).default('clone'),
      /** Git-ignored folders to bring over from your checkout (searched a few levels deep, so monorepos work). */
      // Python virtualenvs are excluded: they hard-code their original path, so a copy would still point at your
      // real environment. Use `setup` (e.g. "uv sync", fast with uv's cache) to build one per worktree instead.
      shareDirs: z.array(z.string()).default(['node_modules', 'vendor', '.bundle', 'target', '.gradle', 'Pods']),
      /** Without copy-on-write, skip folders bigger than this instead of copying them byte by byte. */
      maxPlainCopyMb: z.number().min(0).default(300),
      /** Untracked files to copy in, e.g. [".env.local"]. Opt-in, because they often hold secrets. */
      copy: z.array(z.string()).default([]),
      /** Commands to run in each new worktree before the agent starts (code generation, a quick install). */
      setup: z.array(z.string()).default([]),
    })
    .default({ warmStart: 'clone', shareDirs: ['node_modules', 'vendor', '.bundle', 'target', '.gradle', 'Pods'], maxPlainCopyMb: 300, copy: [], setup: [] }),
  /** Spend less on hosted CI (GitHub Actions). See docs/CI.md. */
  ci: z
    .object({
      /** What the git pre-push gate does: run checks and watch the budget, only watch the budget, or nothing. */
      gate: z.enum(['verify', 'budget', 'off']).default('verify'),
      /** Checks the gate runs before a push. Empty: the project's `verify` list, or what the repo obviously uses. */
      verify: z.array(z.string()).default([]),
      /** A push while CI is still running on that branch throws away the minutes already spent. */
      coalesce: z.enum(['warn', 'block', 'off']).default('warn'),
      /** Post a "yardmaster/verified" commit status after local checks pass, for workflows that opt in to trusting it. */
      trustLocal: z.boolean().default(false),
      budget: z
        .object({
          /** Dollars of Actions usage your plan includes each month (Free: 12, Pro and Team: 18). Null: assume 12. */
          includedUsd: z.number().min(0).nullable().default(null),
          /** Paid usage you accept on top of what's included before pushes are held. */
          extraUsd: z.number().min(0).default(0),
          /** Warn when the month is projected to use this share of the allowance. */
          warnAt: z.number().min(0).max(1).default(0.8),
          /** Refuse pushes to private repos once the allowance (plus extraUsd) is used up. */
          blockPushes: z.boolean().default(true),
          refreshMinutes: z.number().min(1).default(15),
        })
        .default({ includedUsd: null, extraUsd: 0, warnAt: 0.8, blockPushes: true, refreshMinutes: 15 }),
    })
    .default({ gate: 'verify', verify: [], coalesce: 'warn', trustLocal: false, budget: { includedUsd: null, extraUsd: 0, warnAt: 0.8, blockPushes: true, refreshMinutes: 15 } }),
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

const AGENT_BASE = { enabled: true, extraArgs: [], autonomy: 'workspace', context: 'lean', effort: {}, resume: true } as const;

export function defaultAgentSettings(over: Partial<AgentSettings> = {}): AgentSettings {
  return { ...AGENT_BASE, models: {}, maxParallel: 2, extraArgs: [], effort: {}, ...over };
}

export const DEFAULT_AGENTS: Record<string, AgentSettings> = {
  claude: { ...AGENT_BASE, models: { cheap: 'haiku', standard: 'sonnet', strong: 'opus' }, maxParallel: 3, extraArgs: [], effort: {} },
  codex: { ...AGENT_BASE, models: { cheap: 'gpt-6-luna' }, maxParallel: 3, extraArgs: [], effort: {} },
  opencode: { ...AGENT_BASE, models: {}, maxParallel: 2, extraArgs: [], effort: {} },
  cursor: { ...AGENT_BASE, models: {}, maxParallel: 2, extraArgs: [], effort: {} },
  gemini: { ...AGENT_BASE, models: {}, maxParallel: 2, extraArgs: [], effort: {} },
  mock: { ...AGENT_BASE, models: {}, maxParallel: 8, extraArgs: [], effort: {} },
};

export const DEFAULT_ROUTING: Record<Tier, string[]> = {
  cheap: ['claude', 'codex', 'opencode', 'gemini', 'cursor'],
  standard: ['claude', 'codex', 'opencode', 'cursor', 'gemini'],
  strong: ['claude', 'codex', 'cursor', 'opencode', 'gemini'],
};

/** Rough list prices (USD per million tokens) for estimating spend when an agent CLI reports tokens but not dollars. */
export const DEFAULT_PRICING: Record<string, z.infer<typeof PriceSchema>> = {
  // Codex's default model for ChatGPT sign-in is GPT-6.1 Sol; its small model is GPT-6 Luna (checked 2026-11).
  codex: { inPerM: 2, cachedInPerM: 0.1, outPerM: 10 },
  'codex:gpt-6-luna': { inPerM: 0.1, cachedInPerM: 0.01, outPerM: 0.5 },
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

// ---------------- unknown settings ----------------

type Def = { type: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType; valueType?: z.ZodType; element?: z.ZodType };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** The object (or record) schema under defaults, optionals and nullables. */
function core(s: z.ZodType): Def {
  let d = defOf(s);
  while (d.innerType && ['default', 'optional', 'nullable', 'prefault', 'readonly', 'catch'].includes(d.type)) d = defOf(d.innerType);
  return d;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

function suggest(key: string, known: string[]): string | null {
  const k = key.toLowerCase();
  let best: { name: string; score: number } | null = null;
  for (const name of known) {
    const n = name.toLowerCase();
    const score = n === k ? 0 : n.startsWith(k) || k.startsWith(n) ? 1 : distance(k, n);
    if (score <= Math.max(2, Math.floor(name.length / 4)) && (!best || score < best.score)) best = { name, score };
  }
  return best?.name ?? null;
}

/**
 * Settings Yardmaster doesn't know, with a likely intended name. Unknown keys are otherwise dropped without a word,
 * which turns a typo in a spending cap into no cap at all. Keys starting with "$" or "//" are treated as comments.
 */
export function unknownSettings(raw: unknown, schema: z.ZodType = ConfigSchema, at = ''): string[] {
  const d = core(schema);
  if (Array.isArray(raw)) return d.type === 'array' && d.element ? raw.flatMap((v, i) => unknownSettings(v, d.element!, `${at.replace(/\.$/, '')}[${i}].`)) : [];
  if (!isPlainObject(raw)) return [];
  if (d.type === 'record' && d.valueType) return Object.entries(raw).flatMap(([k, v]) => unknownSettings(v, d.valueType!, `${at}${k}.`));
  if (d.type !== 'object' || !d.shape) return [];
  const shape = d.shape;
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('$') || k.startsWith('//')) continue;
    const field = shape[k];
    if (field) {
      out.push(...unknownSettings(v, field, `${at}${k}.`));
      continue;
    }
    const hint = suggest(k, Object.keys(shape));
    out.push(`"${at}${k}" is not a Yardmaster setting${hint ? `; did you mean "${at}${hint}"?` : ''}`);
  }
  return out;
}

/** Problems per config file, re-checked whenever the file changes. */
const warned = new Map<string, { stamp: number; problems: string[] }>();
const reported = new Set<string>();

/** Unknown settings found in the config files read so far, by file. */
export function configWarnings(): { file: string; problems: string[] }[] {
  return [...warned].filter(([, w]) => w.problems.length).map(([file, w]) => ({ file, problems: w.problems }));
}

/** Problems not handed out before: a long-running hub reports each one once, including ones from later edits. */
export function newConfigWarnings(): string[] {
  const out: string[] = [];
  for (const { file, problems } of configWarnings()) {
    for (const p of problems) {
      const line = `${file}: ${p}`;
      if (!reported.has(line)) {
        reported.add(line);
        out.push(line);
      }
    }
  }
  return out;
}

function readChecked(file: string): unknown {
  const raw = readJson(file);
  const stamp = existsSync(file) ? statSync(file).mtimeMs : 0;
  if (warned.get(file)?.stamp !== stamp) warned.set(file, { stamp, problems: unknownSettings(raw) });
  return raw;
}

export function loadGlobalConfigRaw(): unknown {
  return readJson(paths.globalConfig());
}

export function loadConfig(projectRoot?: string, overrides: unknown = {}): Config {
  const layers: unknown[] = [readChecked(paths.globalConfig())];
  if (projectRoot) layers.push(readChecked(join(projectRoot, PROJECT_CONFIG_FILE)));
  layers.push(overrides);
  return resolveConfig(layers);
}

export function agentSettings(config: Config, agent: string): AgentSettings {
  const base: AgentSettings = DEFAULT_AGENTS[agent] ?? { ...AGENT_BASE, models: {}, maxParallel: 2, extraArgs: [], effort: {} };
  const over = config.agents[agent] ?? {};
  return { ...base, ...over, models: { ...base.models, ...(over.models ?? {}) }, effort: { ...base.effort, ...(over.effort ?? {}) } };
}

export function routingFor(config: Config, tier: Tier): string[] {
  return config.routing[tier] ?? DEFAULT_ROUTING[tier];
}

export function priceFor(config: Config, agent: string, model?: string | null) {
  return (
    // Most specific first: your price for this model, the built-in one, then per agent, then the fallback.
    (model ? config.pricing[`${agent}:${model}`] ?? DEFAULT_PRICING[`${agent}:${model}`] : undefined) ??
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

export function verifySlotsFor(config: Pick<Config, 'verifyParallel' | 'maxParallel'>, cpus = availableParallelism()): number {
  return config.verifyParallel ?? Math.max(1, Math.min(config.maxParallel, Math.floor(cpus / 4)));
}

export function worktreeRootOf(config: Pick<Config, 'worktreeRoot'>): string {
  return config.worktreeRoot ? expandHome(config.worktreeRoot) : join(yardHome(), 'worktrees');
}

/** Model family per agent, used to pick a reviewer that doesn't share the implementer's blind spots. */
export const AGENT_FAMILY: Record<string, string> = { claude: 'anthropic', codex: 'openai', gemini: 'google', cursor: 'mixed', opencode: 'mixed', mock: 'mock' };
