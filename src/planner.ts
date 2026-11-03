import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as z from 'zod/v4';
import { getAdapter } from './adapters/index.ts';
import { agentSettings, type Config } from './config.ts';
import { cleanEnv } from './proc.ts';
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

/** Uses one read-only agent run to turn a plain-language goal into a task graph. */
export async function planGoal(goal: string, opts: { cwd: string; agent: string; config: Config }): Promise<{ tasks: NewTask[]; costUsd: number | null }> {
  const adapter = getAdapter(opts.agent, opts.config);
  if (!adapter) throw new Error(`Unknown agent ${opts.agent}`);
  const settings = agentSettings(opts.config, opts.agent);
  const spec = adapter.build({ prompt: planningPrompt(goal), cwd: opts.cwd, model: settings.models.strong ?? null, settings, readOnly: true });
  const child = spawn(spec.command, spec.args, { cwd: opts.cwd, env: cleanEnv(spec.env), stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  let result = '';
  let lastText = '';
  let cost: number | null = null;
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    for (const ev of adapter.parse(line)) {
      if (ev.type === 'result') result = ev.text;
      if (ev.type === 'text') lastText += ev.text + '\n';
      if (ev.type === 'usage' && ev.cumulative && ev.costUsd !== undefined) cost = ev.costUsd;
    }
  });
  const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)));
  if (code !== 0 && !result && !lastText) throw new Error(`${adapter.label} failed to plan: ${stderr.trim().slice(-400)}`);
  const parsed = PlanSchema.safeParse(extractJson(result || lastText));
  if (!parsed.success) throw new Error(`The plan was not in the expected shape: ${z.prettifyError(parsed.error)}`);
  return { tasks: parsed.data.tasks, costUsd: cost };
}
