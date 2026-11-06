import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { EFFORT_LEVELS, EffortLevelSchema, type AgentSettings, type EffortRouting, type Tier } from './config.ts';
import { DEFAULT_EFFORT } from './adapters/builtin.ts';
import { cleanEnv, killGroup } from './proc.ts';
import type { Task } from './types.ts';

type Level = (typeof EFFORT_LEVELS)[number];
export interface EffortDecision {
  status: 'disabled' | 'skipped' | 'hold' | 'shadow' | 'apply' | 'fallback';
  reason: string;
  /** Only a validated, applicable decision reaches an adapter. */
  effort?: Level;
  /** The host owns routing for this launch; suppress a second Claude JEV hook. */
  managed: boolean;
  latencyMs: number;
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

/** One no-shell process, with bounded time/output and cleanup even when a descendant holds its pipes open. */
function callRouter(command: string[], input: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output?: string; reason?: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ reason: 'canceled' });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(command[0]!, command.slice(1), { cwd, env: cleanEnv(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (result: { output?: string; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      killGroup(child.pid, 'SIGKILL');
      resolve(result);
    };
    const abort = () => finish({ reason: 'canceled' });
    const timer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish({ reason: 'command_failed' }));
    child.stdin.on('error', () => finish({ reason: 'command_failed' }));
    const collect = (data: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += data.length;
      if (bytes > 65_536) return finish({ reason: 'output_limit' });
      if (stdout) chunks.push(data);
    };
    child.stdout.on('data', (data: Buffer) => collect(data, true));
    child.stderr.on('data', (data: Buffer) => collect(data, false));
    child.on('close', (code) => finish(code === 0 ? { output: Buffer.concat(chunks).toString('utf8') } : { reason: 'command_failed' }));
    child.stdin.end(input);
  });
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
}): Promise<EffortDecision> {
  const started = Date.now();
  const result = (status: EffortDecision['status'], reason: string, managed = false, effort?: Level): EffortDecision =>
    ({ status, reason, managed, latencyMs: Date.now() - started, ...(effort === undefined ? {} : { effort }) });
  const { config, agent, model, settings, task, tier } = opts;
  if (!config.enabled) return result('disabled', 'disabled');
  if (agent !== 'claude' && agent !== 'codex') return result('skipped', 'unsupported_agent');
  if (!model) return result('skipped', 'unknown_model');
  const binding = config.bindings.find((b) => b.agent === agent && b.model === model);
  if (!binding) return result('skipped', 'unbound_model');
  // Opaque custom arguments or executables can override the model/effort. Preserve them without guessing syntax.
  if (Object.hasOwn(settings.effort, tier) || settings.extraArgs.length || settings.command) return result('skipped', 'explicit_settings', true);
  // No router call on retries, resumes, redirects or review/conflict repairs. Suppress native re-routing too.
  if (task.attempts !== 1 || task.agent_session || task.retry_note || task.review_rounds || task.conflict_rounds) return result('skipped', 'recovery', true);
  const baseline = DEFAULT_EFFORT[tier] as Level;
  if (!binding.efforts.includes(baseline)) return result('skipped', 'unsupported_baseline', true);
  if (config.mode === 'active' && (binding.cacheImpact === 'unknown' || (binding.cacheImpact === 'may-reset' && !binding.allowCacheReset))) return result('hold', 'cache_unverified', true);
  const prompt = task.prompt === task.title ? task.title : `${task.title}\n\n${task.prompt}`;
  // Let JEV perform redaction/truncation checks itself; never trim an unknown task into an apparently trivial one.
  if (prompt.length > 131_072) return result('hold', 'input_limit', true);
  const requestId = randomUUID();
  const sessionId = task.id;
  const optionId = agent === 'codex' ? 'model_reasoning_effort' : 'effort';
  const request = { v: 1, requestId, sessionId, providerInstanceId: agent, model, projectDir: opts.repoPath,
    prompt, turn: 1, previousLevel: baseline, baseline, manualSelection: false, attachments: false,
    capability: { optionId, values: binding.efforts, levels: Object.fromEntries(binding.efforts.map((level) => [level, level])),
      cacheImpact: binding.cacheImpact, allowCacheReset: binding.allowCacheReset } };
  let response: Awaited<ReturnType<typeof callRouter>>;
  try {
    response = await callRouter(config.command, JSON.stringify(request), opts.repoPath, config.timeoutMs, opts.signal);
  } catch {
    return result('fallback', 'command_failed', true);
  }
  if (response.reason) return result('fallback', response.reason, true);
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
  if (config.mode === 'shadow' || decision.status === 'shadow') return result('shadow', `suggested_${decision.level}`, true);
  return result('apply', `selected_${decision.level}`, true, decision.level);
}
