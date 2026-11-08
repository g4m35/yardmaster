import { LOCKFILES } from './warmstart.ts';
import * as z from 'zod/v4';
import { AGENT_FAMILY, agentSettings, type Config } from './config.ts';
import { chooseReviewer } from './router.ts';
import { matches } from './scope.ts';
import { git } from './git.ts';
import { runOneShot, type OneShotHooks, type OneShotResult, type OneShotStatus } from './oneshot.ts';
import { emptyUsage, type UsageSnapshot } from './usage.ts';
import { extractJson } from './planner.ts';
import { clip } from './text.ts';
import type { Task } from './types.ts';

export const REVIEW_MARKER = 'YARDMASTER-REVIEW';

const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  issues: z
    .array(z.object({ severity: z.enum(['blocker', 'major', 'minor']).default('minor'), file: z.string().optional(), note: z.string().min(3) }))
    .default([]),
  summary: z.string().optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Accounting and provenance carried by every review result, including skipped and failed ones. */
export interface ReviewUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Mirrors runs.cost_estimated (true for estimated, mixed and unknown provenance). */
  costEstimated: boolean;
  usage: UsageSnapshot;
  model: string | null;
  /** Wall-clock span of the reviewer process (equal when it never launched). */
  startedAt: number;
  endedAt: number;
  /** `not_started` when no reviewer process was launched. */
  status: OneShotStatus | 'not_started';
  error: string;
  /** False when something the reviewer started survived cleanup. */
  reaped: boolean;
}

export interface ReviewOutcome extends ReviewUsage {
  reviewer: string;
  review: Review;
  blocking: Review['issues'];
}

/**
 * no_reviewer: none installed. canceled: the signal fired before or during the review. failed: the reviewer did not
 * finish successfully (nonzero exit, timeout, budget stop, spawn or registration failure), whatever it printed.
 * unreadable: it finished but its verdict did not parse.
 */
export type ReviewSkipReason = 'no_reviewer' | 'canceled' | 'failed' | 'unreadable';

export interface ReviewSkipped extends ReviewUsage {
  skipped: string;
  reason: ReviewSkipReason;
  reviewer: string | null;
  /**
   * `review.required` was set: the caller must not treat this change as reviewed (block or ask for a person) instead
   * of proceeding with a note.
   */
  required: boolean;
}

export interface ReviewHooks {
  beforeSpawn?: OneShotHooks['beforeSpawn'];
  /**
   * Called after the reviewer is chosen and before it launches, e.g. to create the live review run row. A throw
   * propagates out of runReview before anything is spawned.
   */
  beforeLaunch?: (info: { reviewer: string; model: string | null; at: number }) => void | Promise<void>;
  /** Register the reviewer's pid/start identity. A failure stops the reviewer (status hook_failed). */
  onSpawn?: OneShotHooks['onSpawn'];
  /** Live usage while the reviewer runs. */
  onUsage?: OneShotHooks['onUsage'];
}

/** Whether a verified change should get a second model's review before it merges. */
export function shouldReview(task: Task, config: Config, files: string[], changedLines: number): string | null {
  if (config.review.required) return 'required by project policy';
  if (task.review === 'never') return null;
  if (task.review === 'always') return 'requested for this task';
  switch (config.review.mode) {
    case 'never':
      return null;
    case 'always':
      return 'every change is reviewed';
    case 'auto': {
      // The tier the task was created with: a retry escalated to a stronger model isn't a reason for a review.
      if ((task.created_tier ?? task.tier) === 'strong') return 'strong-tier work';
      const hot = files.find((f) => config.hotFiles.some((h) => matches(f, h)));
      if (hot) return `touches shared file ${hot}`;
      if (changedLines >= config.review.minChangedLines) return `large change (${changedLines} lines)`;
      return null;
    }
  }
}

/** Everything except lockfiles: a dependency bump rewrites thousands of their lines and says nothing worth reviewing. */
export const REVIEWED_PATHS = ['--', '.', ...LOCKFILES.map((f) => `:(exclude,glob)**/${f}`)];

export async function changedLineCount(cwd: string, base: string): Promise<number> {
  const r = await git(cwd, ['diff', '--numstat', `${base}...HEAD`, ...REVIEWED_PATHS], { allowFail: true });
  return r.stdout.split('\n').reduce((n, line) => {
    const [a, d] = line.split('\t');
    return n + (Number(a) || 0) + (Number(d) || 0);
  }, 0);
}

function reviewPrompt(task: Task, diff: string, round: number): string {
  return `${REVIEW_MARKER} round ${round}
You are reviewing another coding agent's change before it is merged. You cannot change files. The change already passes the project's automated checks, so focus on what tests miss: wrong behavior versus the request, broken contracts with other code, security problems, data loss, missing error handling at real boundaries, and changes outside the request's scope. Do not ask for style changes or nice-to-haves.

## The request
${task.title}
${task.prompt !== task.title ? task.prompt : ''}

## The diff
${diff}

Reply with ONLY a JSON object:
{"verdict":"approve" | "request_changes","issues":[{"severity":"blocker"|"major"|"minor","file":"path","note":"what is wrong and what to do"}],"summary":"one sentence"}
Use "request_changes" only for blocker or major issues.`;
}

function usageOf(r: OneShotResult): ReviewUsage {
  return {
    costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costEstimated: r.costEstimated, usage: r.usage, model: r.model,
    startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, error: r.error, reaped: r.reaped,
  };
}

function notStarted(model: string | null): ReviewUsage {
  const now = Date.now();
  return { costUsd: 0, tokensIn: 0, tokensOut: 0, costEstimated: true, usage: emptyUsage(), model, startedAt: now, endedAt: now, status: 'not_started', error: '', reaped: true };
}

/**
 * Cross-model review. The reviewer is a different model family from the implementer when one is installed:
 * research on Claude/Codex pairs found reviewing across families catches mistakes the implementer's own
 * family shares (and that which pairing helps is asymmetric, so the reviewer order is configurable).
 *
 * Every result carries the reviewer's spend, model and timing, so the caller can record it exactly once whatever
 * happened. A verdict is only accepted from a reviewer that finished successfully.
 */
export async function runReview(opts: {
  task: Task; config: Config; implementer: string; installed: string[]; cwd: string; base: string;
  signal?: AbortSignal; hooks?: ReviewHooks; timeoutMs?: number;
}): Promise<ReviewOutcome | ReviewSkipped> {
  const required = opts.config.review.required;
  const reviewer = chooseReviewer(opts.config, opts.implementer, opts.installed, AGENT_FAMILY);
  if (!reviewer) return { ...notStarted(null), skipped: 'no reviewer agent is installed on this machine', reason: 'no_reviewer', reviewer: null, required };
  const settings = agentSettings(opts.config, reviewer);
  const model = settings.models.standard ?? settings.models.strong ?? null;
  const canceled = (): ReviewSkipped => ({ ...notStarted(model), skipped: 'the review was canceled before it started', reason: 'canceled', reviewer, required });
  if (opts.signal?.aborted) return canceled();
  const stat = (await git(opts.cwd, ['diff', '--stat', `${opts.base}...HEAD`], { allowFail: true })).stdout;
  const patch = (await git(opts.cwd, ['diff', `${opts.base}...HEAD`, ...REVIEWED_PATHS], { allowFail: true })).stdout;
  const diff = `${stat}\n${patch.length > 60_000 ? patch.slice(0, 60_000) + '\n[diff truncated]' : patch}`;
  if (opts.signal?.aborted) return canceled();
  await opts.hooks?.beforeLaunch?.({ reviewer, model, at: Date.now() });
  const r = await runOneShot({
    agent: reviewer, config: opts.config, cwd: opts.cwd, readOnly: true, model,
    tier: 'standard', maxTurns: opts.config.review.maxTurns, budgetUsd: opts.config.review.budgetUsd, timeoutMs: opts.timeoutMs,
    prompt: reviewPrompt(opts.task, diff, opts.task.review_rounds), env: { YARDMASTER_REVIEW_ROUND: String(opts.task.review_rounds), YARDMASTER_TASK_ID: opts.task.id },
    signal: opts.signal, hooks: { beforeSpawn: opts.hooks?.beforeSpawn, onSpawn: opts.hooks?.onSpawn, onUsage: opts.hooks?.onUsage },
  });
  const usage = usageOf(r);
  if (r.status === 'canceled' || r.status === 'interrupted') {
    return { ...usage, skipped: `the review by ${reviewer} was canceled`, reason: 'canceled', reviewer, required };
  }
  if (!r.ok) {
    // Output from a reviewer that did not finish (timeout, budget stop, nonzero exit) is not a verdict, even if it parses.
    return { ...usage, skipped: `the reviewer (${reviewer}) did not finish (${r.status})${r.error ? `: ${clip(r.error, 200)}` : ''}`, reason: 'failed', reviewer, required };
  }
  let review: Review;
  try {
    review = ReviewSchema.parse(extractJson(r.text));
  } catch {
    // Unless review.required is set, an unreadable review never blocks a verified change; it is reported instead.
    return { ...usage, skipped: `the reviewer (${reviewer}) did not return a readable verdict`, reason: 'unreadable', reviewer, required };
  }
  const blocking = review.verdict === 'request_changes' ? review.issues.filter((i) => i.severity !== 'minor') : [];
  return { ...usage, reviewer, review, blocking };
}

export function formatIssues(issues: Review['issues']): string[] {
  return issues.map((i) => `[${i.severity}]${i.file ? ` ${i.file}:` : ''} ${clip(i.note, 300)}`);
}
