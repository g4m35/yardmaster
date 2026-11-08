import type { AgentSettings, Tier } from '../config.ts';

/** Every agent CLI's output is normalized into these events, so the watchdog and budget logic are agent-independent. */
export type AgentEvent =
  | { type: 'tool'; name: string; input: unknown; write: boolean }
  | { type: 'tool_result'; ok: boolean; text: string }
  | { type: 'text'; text: string }
  /**
   * `tokensIn` excludes cache reads (`cachedIn`) but includes cache writes; `cacheWriteIn` says how many of `tokensIn`
   * were cache writes, when the CLI reports it (absent means unknown, not zero). `costUsd` is the CLI's own dollar
   * figure; leave it absent when the CLI did not report one, so the cost is estimated rather than recorded as $0.
   * `cumulative`: the event is a snapshot of the whole run so far (it replaces earlier events) rather than an increment.
   * `id` identifies the API message: some CLIs repeat a message's usage once per content block, so count it once.
   */
  | { type: 'usage'; tokensIn: number; tokensOut: number; cachedIn?: number; cacheWriteIn?: number; costUsd?: number; cumulative: boolean; id?: string }
  /** The CLI's own session id, for resuming on retry. */
  | { type: 'session'; id: string }
  | { type: 'result'; ok: boolean; text: string }
  | { type: 'error'; text: string };

export interface AdapterContext {
  routedEffort?: import('../effort.ts').RoutedEffort;
  prompt: string;
  cwd: string;
  model: string | null;
  settings: AgentSettings;
  /** Read-only planning runs (used by `ym plan`). */
  readOnly?: boolean;
  tier?: Tier;
  /** Continue this session (resume) or start a new one under this id (pin), for CLIs that support it. */
  session?: { resume: string } | { pin: string };
  /** What's left of the task's budget; passed to CLIs that can enforce a spending cap themselves. */
  budgetUsd?: number | null;
  /** Hard cap on agentic turns (used for bounded jobs like reviews). */
  maxTurns?: number;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Sent on stdin, then stdin is closed. Some CLIs (codex) block waiting on an open stdin. */
  stdin?: string;
  env?: Record<string, string>;
}

export type FailureClass = 'auth' | 'rate_limit' | 'missing_binary' | 'context' | null;

export interface Adapter {
  name: string;
  label: string;
  /** Executable looked up on PATH to decide whether this agent is installed. */
  binary: string;
  /** Whether build() honors ctx.session.resume (so a retry continues the previous conversation). */
  resumable?: boolean;
  build(ctx: AdapterContext): LaunchSpec;
  parse(line: string): AgentEvent[];
  classifyFailure?(output: string): FailureClass;
  /** Shown to the user when this agent cannot run. Plain language. */
  setupHint?: string;
}

export const WRITE_TOOL = /^(edit|write|multiedit|notebookedit|apply_patch|file_change|str_replace|create|patch|replace|write_file|edit_file)/i;

export function commonFailure(output: string): FailureClass {
  const o = output.toLowerCase();
  if (/not logged in|please log in|authentication|unauthorized|invalid api key|401\b|login required|run .*login/.test(o)) return 'auth';
  if (/rate limit|too many requests|429\b|usage limit|quota|overloaded|capacity/.test(o)) return 'rate_limit';
  if (/context (length|window)|prompt is too long|maximum context/.test(o)) return 'context';
  return null;
}

export function safeJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
