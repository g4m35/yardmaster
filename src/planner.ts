import * as z from 'zod/v4';
import { getAdapter } from './adapters/index.ts';
import { agentSettings, type Config } from './config.ts';
import { runOneShot } from './oneshot.ts';
import { NewTaskSchema, type NewTask } from './types.ts';

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

/**
 * Uses one read-only agent run to turn a plain-language goal into a task graph. Capped like every other run: at most
 * 10 minutes, 40 turns and the per-task budget (or what's left of today's), so a confused planner can't run up a bill.
 */
export async function planGoal(goal: string, opts: { cwd: string; agent: string; config: Config; budgetUsd?: number | null }): Promise<{ tasks: NewTask[]; costUsd: number; tokensIn: number; tokensOut: number; model: string | null }> {
  if (!getAdapter(opts.agent, opts.config)) throw new Error(`Unknown agent ${opts.agent}`);
  const model = agentSettings(opts.config, opts.agent).models.strong ?? null;
  const budget = opts.budgetUsd ?? opts.config.budget.perTaskUsd;
  const r = await runOneShot({
    agent: opts.agent, config: opts.config, prompt: planningPrompt(goal), cwd: opts.cwd, model, readOnly: true, tier: 'strong',
    timeoutMs: 10 * 60_000, maxTurns: 40, budgetUsd: budget ?? undefined,
  });
  if (!r.ok && !r.text) throw new Error(`The planner failed: ${r.error || 'no output'}`);
  const parsed = PlanSchema.safeParse(extractJson(r.text));
  if (!parsed.success) throw new Error(`The plan was not in the expected shape: ${z.prettifyError(parsed.error)}`);
  return { tasks: parsed.data.tasks, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, model };
}
