import * as z from 'zod/v4';
import { AGENT_FAMILY, agentSettings, type Config } from './config.ts';
import { chooseReviewer } from './router.ts';
import { matches } from './scope.ts';
import { git } from './git.ts';
import { runOneShot } from './oneshot.ts';
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

export interface ReviewOutcome {
  reviewer: string;
  review: Review;
  blocking: Review['issues'];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Whether a verified change should get a second model's review before it merges. */
export function shouldReview(task: Task, config: Config, files: string[], changedLines: number): string | null {
  if (task.review === 'never') return null;
  if (task.review === 'always') return 'requested for this task';
  switch (config.review.mode) {
    case 'never':
      return null;
    case 'always':
      return 'every change is reviewed';
    case 'auto': {
      if (task.tier === 'strong') return 'strong-tier work';
      const hot = files.find((f) => config.hotFiles.some((h) => matches(f, h)));
      if (hot) return `touches shared file ${hot}`;
      if (changedLines >= config.review.minChangedLines) return `large change (${changedLines} lines)`;
      return null;
    }
  }
}

export async function changedLineCount(cwd: string, base: string): Promise<number> {
  const r = await git(cwd, ['diff', '--numstat', `${base}...HEAD`], { allowFail: true });
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

/**
 * Cross-model review. The reviewer is a different model family from the implementer when one is installed:
 * research on Claude/Codex pairs found reviewing across families catches mistakes the implementer's own
 * family shares (and that which pairing helps is asymmetric, so the reviewer order is configurable).
 */
export async function runReview(opts: { task: Task; config: Config; implementer: string; installed: string[]; cwd: string; base: string }): Promise<ReviewOutcome | { skipped: string }> {
  const reviewer = chooseReviewer(opts.config, opts.implementer, opts.installed, AGENT_FAMILY);
  if (!reviewer) return { skipped: 'no reviewer agent is installed on this machine' };
  const stat = (await git(opts.cwd, ['diff', '--stat', `${opts.base}...HEAD`], { allowFail: true })).stdout;
  const patch = (await git(opts.cwd, ['diff', `${opts.base}...HEAD`], { allowFail: true })).stdout;
  const diff = `${stat}\n${patch.length > 60_000 ? patch.slice(0, 60_000) + '\n[diff truncated]' : patch}`;
  const settings = agentSettings(opts.config, reviewer);
  const r = await runOneShot({
    agent: reviewer, config: opts.config, cwd: opts.cwd, readOnly: true, model: settings.models.standard ?? settings.models.strong ?? null,
    prompt: reviewPrompt(opts.task, diff, opts.task.review_rounds), env: { YARDMASTER_REVIEW_ROUND: String(opts.task.review_rounds), YARDMASTER_TASK_ID: opts.task.id },
  });
  let review: Review;
  try {
    review = ReviewSchema.parse(extractJson(r.text));
  } catch {
    // An unreadable review never blocks a verified change; it is reported instead.
    return { skipped: `the reviewer (${reviewer}) did not return a readable verdict${r.error ? `: ${clip(r.error, 200)}` : ''}` };
  }
  const blocking = review.verdict === 'request_changes' ? review.issues.filter((i) => i.severity !== 'minor') : [];
  return { reviewer, review, blocking, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

export function formatIssues(issues: Review['issues']): string[] {
  return issues.map((i) => `[${i.severity}]${i.file ? ` ${i.file}:` : ''} ${clip(i.note, 300)}`);
}
