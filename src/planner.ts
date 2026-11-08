import * as z from 'zod/v4';
import { getAdapter } from './adapters/index.ts';
import { agentSettings, type Config } from './config.ts';
import { runOneShot, type OneShotHooks, type OneShotResult } from './oneshot.ts';
import type { Client } from './api.ts';
import { processStartTime } from './proc.ts';
import { NewTaskSchema, type NewTask } from './types.ts';
import { normalizePlanningHub, PlanningJournal } from './planning-journal.ts';

const PlanSchema = z.object({ tasks: z.array(NewTaskSchema).min(1).max(30) });

function planningPrompt(goal: string): string {
  return `You are planning work for several coding agents that will run in parallel, each in its own git worktree.
Read the repository as needed (do not modify anything), then split this goal into small, independently verifiable tasks:

GOAL: ${goal}

Rules:
- Prefer tasks that touch different files so they can run at the same time.
- List the files or globs each task will change in "files" (repo-relative). Be specific: this is used to prevent collisions.
- Use "after" with another task's "key" only when a task truly needs the other's result.
- "tier": "cheap" for docs/renames/small edits, "strong" for architecture/security/tricky logic, otherwise "standard".
- 2 to 8 tasks is usually right. Each "prompt" must be self-contained: the agent will not see this conversation.

Reply with ONLY a JSON object, no prose, in this exact shape:
{"tasks":[{"key":"short-id","title":"...","prompt":"...","files":["src/x/**"],"after":[],"tier":"standard"}]}`;
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The planner did not return JSON.');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Planning failed after spending something: the spend still has to be counted. */
export class PlanError extends Error {
  readonly spend: { costUsd: number; tokensIn: number; tokensOut: number; model: string | null };
  constructor(message: string, spend: PlanError['spend']) {
    super(message);
    this.spend = spend;
  }
}

/**
 * Uses one read-only agent run to turn a plain-language goal into a task graph. Always stopped after 10 minutes;
 * agents whose CLI supports it (Claude Code) are also held to 40 turns and the given dollar budget.
 */
export async function planGoal(goal: string, opts: { cwd: string; agent: string; config: Config; budgetUsd?: number | null; hooks?: OneShotHooks; signal?: AbortSignal; onResult?: (result: OneShotResult) => Promise<void> }): Promise<{ tasks: NewTask[]; costUsd: number; tokensIn: number; tokensOut: number; model: string | null }> {
  if (!getAdapter(opts.agent, opts.config)) throw new Error(`Unknown agent ${opts.agent}`);
  const model = agentSettings(opts.config, opts.agent).models.strong ?? null;
  const budget = opts.budgetUsd === undefined ? opts.config.budget.perTaskUsd : opts.budgetUsd;
  const r = await runOneShot({
    agent: opts.agent, config: opts.config, prompt: planningPrompt(goal), cwd: opts.cwd, model, readOnly: true, tier: 'strong',
    timeoutMs: 10 * 60_000, maxTurns: 40, budgetUsd: budget ?? undefined, interruptible: true, hooks: opts.hooks, signal: opts.signal,
  });
  await opts.onResult?.(r);
  const spend = { costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, model };
  if (r.interrupted) throw new PlanError('Planning was interrupted.', spend);
  if (!r.ok) throw new PlanError(`The planner failed: ${r.error || 'it stopped without output (it may have hit the 10-minute limit)'}`, spend);
  // The final message first (structured agents); then everything printed, for plain CLIs that print over many lines.
  let json: unknown;
  try {
    json = extractJson(r.text);
  } catch {
    try {
      json = extractJson(r.allText);
    } catch (err) {
      throw new PlanError((err as Error).message, spend);
    }
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) throw new PlanError(`The plan was not in the expected shape: ${z.prettifyError(parsed.error)}`, spend);
  return { tasks: parsed.data.tasks, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, model };
}

/** Product planning lifecycle. The owner API admits before launch and records every outcome, including bad JSON. */
export async function planGoalManaged(goal: string, opts: { cwd: string; agent: string; config: Config; client: Client; projectId: string; machineId: string; hub: string }) {
  // Refuse missing/credential-bearing hub identities before admission, never use a machine-only key.
  const hub = normalizePlanningHub(opts.hub);
  const model = agentSettings(opts.config, opts.agent).models.strong ?? null;
  const startedAt = await processStartTime(process.pid);
  if (startedAt === null) throw new Error('Planning CLI owner identity could not be read.');
  const owner = { pid: process.pid, startedAt };
  const admissionRequestedAt = Date.now();
  const admitted = await opts.client['plan.start']({ projectId: opts.projectId, machineId: opts.machineId, agent: opts.agent, model, owner });
  const journal = new PlanningJournal({ hub, machineId: opts.machineId, projectId: opts.projectId, runId: admitted.runId, owner });
  const stop = new AbortController();
  const onSignal = () => stop.abort('Planning interrupted.');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let lastHeartbeat = admissionRequestedAt;
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    // Watch the deadline even when an RPC is hung. Never let an active detached planner outlive its lease.
    if (Date.now() - lastHeartbeat >= admitted.leaseMs) stop.abort('Planning invocation heartbeat lease expired.');
    if (heartbeatPending || stop.signal.aborted) return;
    heartbeatPending = true;
    const requestedAt = Date.now();
    void opts.client['plan.heartbeat']({ runId: admitted.runId, owner }).then(() => { lastHeartbeat = requestedAt; }, () => {
      if (Date.now() - lastHeartbeat >= admitted.leaseMs) stop.abort('Planning invocation heartbeat lease expired.');
    }).finally(() => { heartbeatPending = false; });
  }, Math.min(admitted.heartbeatMs, admitted.leaseMs / 4));
  let result: OneShotResult | null = null;
  let spawned = false;
  let phase = 'plan';
  let finalizing = false;
  let succeeded = false;
  try {
    const plan = await planGoal(goal, { ...opts, signal: stop.signal, budgetUsd: admitted.budget.amountUsd,
      hooks: {
        beforeSpawn: async () => {
          if (stop.signal.aborted) throw new Error(String(stop.signal.reason));
          journal.spawning();
          await opts.client['plan.spawning']({ runId: admitted.runId }); phase = 'plan:spawning';
        },
        onSpawn: async ({ pid, startedAt }) => {
          spawned = true;
          if (startedAt === null) throw new Error('Planning process identity could not be read.');
          journal.spawned({ pid, startedAt });
          await opts.client['plan.spawn']({ runId: admitted.runId, pid, startedAt });
        },
        onUsage: async (usage) => { if (finalizing) return; journal.snapshot(usage); await journal.sendUsage(opts.client); },
      },
      onResult: async (r) => {
        finalizing = true;
        result = r;
        // Persist measured totals and exit proof before parsing can fail or any final RPC can lose its acknowledgment.
        journal.complete(r.usage, { reaped: r.reaped, succeeded: false, reason: 'Planning outcome was interrupted before validation.',
          ...(r.pid !== null && r.procStartedAt !== null ? { process: { pid: r.pid, startedAt: r.procStartedAt } } : {}),
          ...(r.status === 'spawn_failed' && r.pid === null && phase === 'plan:spawning' ? { spawnFailure: { status: 'spawn_failed', pid: null } } : {}),
          ...(!spawned && phase === 'plan' ? { noLaunchPhase: phase } : {}),
        });
        if (!r.reaped) throw new Error('Planning process cleanup was not confirmed; its budget remains held.');
      },
    });
    succeeded = true;
    return plan;
  } finally {
    // An unexpected throw after spawn is not evidence of exit. Fail closed and retain its hold.
    const completed = result as OneShotResult | null;
    // Exceptions can contain echoed prompts, stderr or provider output. Keep only lifecycle facts in the receipt.
    const reason = succeeded ? '' : completed ? `Planning ended without a valid plan (${completed.status}).` : 'Planning failed before a final result was recorded.';
    try {
      journal.outcome({ reaped: completed?.reaped ?? !spawned, succeeded, reason,
        ...(completed?.pid !== null && completed?.pid !== undefined && completed.procStartedAt !== null ? { process: { pid: completed.pid, startedAt: completed.procStartedAt } } : {}),
        ...(completed?.status === 'spawn_failed' && completed.pid === null && phase === 'plan:spawning' ? { spawnFailure: { status: 'spawn_failed', pid: null } } : {}),
        ...(!spawned && phase === 'plan' ? { noLaunchPhase: phase } : {}),
      });
      await journal.replay(opts.client);
    } finally {
      clearInterval(heartbeat);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}
