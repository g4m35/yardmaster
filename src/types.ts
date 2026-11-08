import * as z from 'zod/v4';
import { TierSchema, type Tier } from './config.ts';

export const TASK_STATUSES = ['queued', 'running', 'verifying', 'ready', 'merging', 'done', 'needs_human', 'failed', 'canceled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const ACTIVE_STATUSES: TaskStatus[] = ['running', 'verifying', 'ready', 'merging'];
export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'canceled'];

/** Plain-language labels for the dashboard and CLI, so non-technical users never see raw states. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Waiting',
  running: 'Working',
  verifying: 'Checking',
  ready: 'Ready to merge',
  merging: 'Merging',
  done: 'Done',
  needs_human: 'Needs you',
  failed: 'Failed',
  canceled: 'Canceled',
};

export interface Task {
  id: string;
  project_id: string;
  title: string;
  prompt: string;
  fingerprint: string;
  status: TaskStatus;
  priority: number;
  tier: Tier;
  agent: string | null;
  model: string | null;
  scope: string[];
  scope_inferred: boolean;
  verify: string[] | null;
  allow_no_changes: boolean;
  /** Durable native artifact capture; internal JSON, never a worker-writable field. */
  native_handoff: string | null;
  /** Durable claim identity; never decremented with retry accounting. */
  generation: number;
  attempts: number;
  max_attempts: number;
  budget_usd: number | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  assignee: string | null;
  machine_id: string | null;
  branch: string | null;
  worktree: string | null;
  base_sha: string | null;
  head_sha: string | null;
  lease_until: number | null;
  not_before: number | null;
  wait_for: string | null;
  pending_rebase: boolean;
  control: string | null;
  summary: string | null;
  last_error: string | null;
  retry_note: string | null;
  error_fp: string | null;
  same_error_count: number;
  conflict_rounds: number;
  attention: string | null;
  approved: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  ready_at: number | null;
  review: 'always' | 'never' | null;
  review_rounds: number;
  race_group: string | null;
  guidance: string | null;
  needs_approval: boolean;
  policies: string[];
  /** The agent session (Claude Code session id, Codex thread id) a retry can resume instead of starting over. */
  agent_session: string | null;
  session_agent: string | null;
  /** Spend already reported by that session; resumed runs report totals that include it. */
  session_cost: number;
  session_at: number | null;
  session_fingerprint: string | null;
  /** Tier the task was created with (escalation on retries raises `tier`, not this). */
  created_tier: Tier | null;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  base_branch: string;
  created_at: number;
}

export interface Run {
  id: string;
  task_id: string;
  generation: number;
  attempt: number;
  machine_id: string;
  agent: string;
  model: string | null;
  pid: number | null;
  proc_started: number | null;
  log_path: string | null;
  status: string;
  stop_reason: string | null;
  exit_code: number | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cost_estimated: boolean;
  last_activity: string | null;
  touched: string[];
  started_at: number;
  ended_at: number | null;
  role: 'implement' | 'review' | 'plan';
  tier: string | null;
  lessons: string[];
  verdict: string | null;
  /** Milliseconds per phase: prepare, agent, verify, review. */
  phases: Record<string, number>;
  resumed: boolean;
  phase: string | null;
  effort: string | null;
  effort_source: string | null;
  launch_fingerprint: string | null;
  verdict_sha: string | null;
  usage_provenance: 'actual' | 'estimated' | 'mixed' | 'unknown';
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

export interface YardEvent {
  id: number;
  project_id: string | null;
  task_id: string | null;
  level: 'info' | 'warn' | 'error' | 'success';
  kind: string;
  message: string;
  data: unknown;
  ts: number;
}

export interface MachineInfo {
  diskFreeGb?: number;
  worktreesGb?: number;
  agents: string[];
  repos: Record<string, string>;
  maxParallel: number;
  running: number;
  loadPerCpu: number;
  freeMemMb: number;
  platform: string;
  version: string;
}

export interface Machine {
  id: string;
  name: string;
  info: MachineInfo;
  last_seen: number;
  is_hub: boolean;
}

export const NewTaskSchema = z.object({
  key: z.string().optional().describe('Optional local key so other tasks in the same batch can depend on this one via "after".'),
  title: z.string().min(3).max(200).describe('Short name for the work.'),
  prompt: z.string().max(20000).optional().describe('Full instructions. Defaults to the title.'),
  files: z.array(z.string()).optional().describe('Files or globs this task will change, e.g. ["src/auth/**"]. Used to prevent overlapping edits.'),
  after: z.array(z.string()).optional().describe('Task ids (or batch keys) that must be done first.'),
  agent: z.string().optional().describe('Force a specific agent (claude, codex, opencode, cursor, gemini, or a plugin).'),
  tier: TierSchema.optional().describe('cheap | standard | strong. Picks model size; omitted = inferred.'),
  verify: z.array(z.string()).optional().describe('Extra shell commands that must pass, e.g. ["npm run e2e"]. They run in addition to the project checks, never instead of them.'),
  priority: z.number().int().min(-10).max(10).optional(),
  budgetUsd: z.number().positive().optional(),
  allowNoChanges: z.boolean().optional().describe('True for research/review tasks that may not edit files.'),
  bestOf: z.number().int().min(1).max(4).optional().describe('Race this many agents on the same task; the first verified result wins.'),
  review: z.enum(['always', 'never']).optional().describe('Force or skip a cross-model review before merging.'),
});
export type NewTask = z.infer<typeof NewTaskSchema>;

export const TERMINAL_RUN_REASONS = ['loop', 'oscillation', 'stall', 'timeout', 'repeated_error', 'awaiting_input', 'budget', 'canceled', 'preempted', 'stopped'] as const;
