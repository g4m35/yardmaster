import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { EFFORT_LEVELS, EffortLevelSchema, type AgentSettings, type EffortRouting, type Tier } from './config.ts';
import { DEFAULT_EFFORT, type RoutedEffort } from './effort.ts';
import { cleanEnv, startOwnedProcess, type OwnedRunOptions, type OwnedRunResult } from './proc.ts';
import type { Task } from './types.ts';

type Level = (typeof EFFORT_LEVELS)[number];

/** Safe lifetime evidence; excludes arbitrary command errors and subprocess output. */
export type RouterProcessResult = Pick<OwnedRunResult, 'pid' | 'startedAt' | 'end' | 'pipeHeld' | 'reaped' | 'reap'>;
export interface EffortDecision {
  status: 'disabled' | 'skipped' | 'hold' | 'shadow' | 'apply' | 'fallback';
  reason: string;
  /** Only a validated, applicable decision reaches an adapter. */
  effort?: Level;
  /** The host owns routing for this launch; suppress a second Claude JEV hook. */
  managed: boolean;
  latencyMs: number;
  /** Present after a router launch. A false reaped flag must hold the task, never start coding. */
  process?: RouterProcessResult;
}

const ReplySchema = z.strictObject({
  v: z.literal(1), requestId: z.string(), sessionId: z.string(), providerInstanceId: z.string(), model: z.string(),
  status: z.enum(['hold', 'shadow', 'apply']), reason: z.string().max(500), level: EffortLevelSchema.nullable(),
  patch: z.strictObject({ optionId: z.string(), value: z.string() }).nullable(),
  judge: z.object({ status: z.string(), latencyMs: z.number().nonnegative(), attempts: z.number().int().nonnegative() }).nullable(),
});

// Log only known codes, never arbitrary subprocess output, reasons or errors (which can echo a prompt/key).
const HOLD_REASONS = new Set(['disabled', 'outside_scope', 'manual_selection', 'no_effort_control', 'cache_unverified',
  'invalid_capability_mapping', 'unsupported_ceiling', 'opaque_input', 'judge_unavailable', 'unsupported_effort']);

/** One registered, no-shell process; returning means cleanup completed or explicitly reported a survivor. */
async function callRouter(command: string[], input: string, cwd: string, timeoutMs: number,
  signal?: AbortSignal, onSpawn?: OwnedRunOptions['onSpawn']): Promise<{ output?: string; reason?: string; process: RouterProcessResult }> {
  let bytes = 0;
  let outputLimit = false;
  let registrationFailed = false;
  const chunks: Buffer[] = [];
  const collect = (data: Buffer, stdout: boolean) => {
    if (outputLimit) return;
    bytes += data.length;
    if (bytes > 65_536) {
      outputLimit = true;
      owned.stop('router output limit');
      return;
    }
    if (stdout) chunks.push(data);
  };
  const owned = startOwnedProcess(command[0]!, command.slice(1), {
    cwd, env: cleanEnv(), stdin: input, signal, timeoutMs,
    onSpawn: onSpawn ? async (info) => {
      try { await onSpawn(info); } catch (err) { registrationFailed = true; throw err; }
    } : undefined,
    // The router is advisory and short-lived; bound its cleanup independently of the judge timeout.
    termGraceMs: 250, killWaitMs: 1000, exitGraceMs: 250,
    onStdout: (data) => collect(data, true), onStderr: (data) => collect(data, false),
  });
  const r = await owned.done;
  const process: RouterProcessResult = { pid: r.pid, startedAt: r.startedAt, end: r.end,
    pipeHeld: r.pipeHeld, reaped: r.reaped, reap: r.reap };
  // This check precedes every fallback, including timeout, abort and registration failure.
  if (!r.reaped) return { reason: 'process_unreaped', process };
  if (registrationFailed || r.end === 'hook_failed') return { reason: 'registration_failed', process };
  if (r.end === 'aborted') return { reason: 'canceled', process };
  if (outputLimit) return { reason: 'output_limit', process };
  if (r.end === 'timeout') return { reason: 'timeout', process };
  if (r.end !== 'exit' || r.code !== 0) return { reason: 'command_failed', process };
  return { output: Buffer.concat(chunks).toString('utf8'), process };
}

/** Effort-only routing for first attempts. Model selection, recovery, permissions and prompts stay with Yardmaster. */
export async function routeEffort(opts: {
  config: EffortRouting;
  agent: string;
  model: string | null;
  settings: AgentSettings;
  tier: Tier;
  task: Pick<Task, 'id' | 'title' | 'prompt' | 'attempts' | 'agent_session' | 'retry_note' | 'review_rounds' | 'conflict_rounds'>;
  repoPath: string;
  signal?: AbortSignal;
  /** Persist the spawning phase only when all routing gates passed and a judge will be launched. */
  beforeSpawn?: () => void | Promise<void>;
  /** Durably register the judge under the launch phase; a failure stops it before returning a hold. */
  onSpawn?: OwnedRunOptions['onSpawn'];
}): Promise<EffortDecision> {
  const started = Date.now();
  let process: RouterProcessResult | undefined;
  const result = (status: EffortDecision['status'], reason: string, managed = false, effort?: Level): EffortDecision =>
    ({ status, reason, managed, latencyMs: Date.now() - started, ...(process ? { process } : {}), ...(effort === undefined ? {} : { effort }) });
  const { config, agent, model, settings, task, tier } = opts;
  if (!config.enabled) return result('disabled', 'disabled');
  if (agent !== 'claude' && agent !== 'codex') return result('skipped', 'unsupported_agent');
  // The native client owns effort here, including any native JEV hook; Yardmaster neither routes nor suppresses it.
  if (settings.effortOwnership === 'native') return result('skipped', 'native_ownership');
  if (!model) return result('skipped', 'unknown_model');
  const binding = config.bindings.find((b) => b.agent === agent && b.model === model);
  if (!binding) return result('skipped', 'unbound_model');
  // Opaque custom arguments or executables can override the model/effort. Preserve them without guessing syntax.
  if (Object.hasOwn(settings.effort, tier) || settings.extraArgs.length || settings.command) return result('skipped', 'explicit_settings', true);
  // No router call on retries, resumes, redirects or review/conflict repairs. Suppress native re-routing too.
  if (task.attempts !== 1 || task.agent_session || task.retry_note || task.review_rounds || task.conflict_rounds) return result('skipped', 'recovery', true);
  // The minimum raises the baseline (the ceiling) and removes lower options, so a reply can never go below it.
  const floor = settings.minimumEffort ?? null;
  if (floor !== null && !(EFFORT_LEVELS as readonly string[]).includes(floor)) return result('skipped', 'unsupported_floor', true);
  const rank = (l: string) => (EFFORT_LEVELS as readonly string[]).indexOf(l);
  const tierDefault = DEFAULT_EFFORT[tier] as Level;
  const baseline = floor !== null && rank(floor) > rank(tierDefault) ? (floor as Level) : tierDefault;
  if (!binding.efforts.includes(baseline)) return result('skipped', 'unsupported_baseline', true);
  const efforts = floor === null ? binding.efforts : binding.efforts.filter((l) => rank(l) >= rank(floor));
  if (floor !== null && efforts.filter((l) => rank(l) <= rank(baseline)).length < 2) return result('skipped', 'at_floor', true);
  if (config.mode === 'active' && (binding.cacheImpact === 'unknown' || (binding.cacheImpact === 'may-reset' && !binding.allowCacheReset))) return result('hold', 'cache_unverified', true);
  const prompt = task.prompt === task.title ? task.title : `${task.title}\n\n${task.prompt}`;
  // Let JEV perform redaction/truncation checks itself; never trim an unknown task into an apparently trivial one.
  if (prompt.length > 131_072) return result('hold', 'input_limit', true);
  const requestId = randomUUID();
  const sessionId = task.id;
  const optionId = agent === 'codex' ? 'model_reasoning_effort' : 'effort';
  const request = { v: 1, requestId, sessionId, providerInstanceId: agent, model, projectDir: opts.repoPath,
    prompt, turn: 1, previousLevel: baseline, baseline, manualSelection: false, attachments: false,
    capability: { optionId, values: efforts, levels: Object.fromEntries(efforts.map((level) => [level, level])),
      cacheImpact: binding.cacheImpact, allowCacheReset: binding.allowCacheReset } };
  if (opts.signal?.aborted) return result('fallback', 'canceled', true);
  let response: Awaited<ReturnType<typeof callRouter>>;
  try {
    await opts.beforeSpawn?.();
  } catch {
    return result('hold', 'registration_failed', true);
  }
  try {
    response = await callRouter(config.command, JSON.stringify(request), opts.repoPath, config.timeoutMs, opts.signal, opts.onSpawn);
  } catch {
    // The owned helper normally never rejects. An unexpected failure leaves lifetime unproven.
    return result('hold', 'process_unreaped', true);
  }
  process = response.process;
  if (response.reason) return result(response.reason === 'process_unreaped' || response.reason === 'registration_failed' ? 'hold' : 'fallback', response.reason, true);
  let raw: unknown;
  try { raw = JSON.parse(response.output!); } catch { return result('fallback', 'invalid_response', true); }
  const parsed = ReplySchema.safeParse(raw);
  if (!parsed.success) return result('fallback', 'invalid_response', true);
  const decision = parsed.data;
  if (decision.requestId !== requestId || decision.sessionId !== sessionId || decision.providerInstanceId !== agent || decision.model !== model) return result('fallback', 'identity_mismatch', true);
  if (decision.status === 'hold') {
    if (decision.patch !== null || decision.level !== null) return result('fallback', 'invalid_response', true);
    return result('hold', HOLD_REASONS.has(decision.reason) ? decision.reason : 'router_hold', true);
  }
  if (!decision.patch || decision.patch.optionId !== optionId || decision.patch.value !== decision.level || !decision.level
    || !binding.efforts.includes(decision.level) || EFFORT_LEVELS.indexOf(decision.level) > EFFORT_LEVELS.indexOf(baseline)) return result('fallback', 'invalid_patch', true);
  if (!efforts.includes(decision.level)) return result('fallback', 'below_floor', true);
  if (config.mode === 'shadow' || decision.status === 'shadow') return result('shadow', `suggested_${decision.level}`, true);
  return result('apply', `selected_${decision.level}`, true, decision.level);
}

/**
 * The decision as adapter input: pass it as `routedEffort` to `adapter.build` rather than writing it into
 * `settings.effort`, so the launch records it as routed (not manual) and the minimum still applies to it.
 */
export function routedEffortOf(decision: EffortDecision): RoutedEffort | undefined {
  return decision.status === 'apply' && decision.effort ? { level: decision.effort, by: 'jev' } : undefined;
}
