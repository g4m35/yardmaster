import * as z from 'zod/v4';
import { validatePattern } from './scope.ts';

export const ScopePattern = z.string().min(1).max(1024).refine(validatePattern, 'Too many scope wildcards (maximum 64).');
export const LiteralPath = z.string().min(1).max(1024).refine(p => !/[*?{}\0]/.test(p), 'Reported paths must be literal paths, without wildcard syntax.');
export const TouchedSchema = z.array(LiteralPath).max(2000);
export const LessonsSchema = z.array(z.string().min(1).max(200)).max(20);
const NonNegative = z.number().finite().nonnegative();
export const PhasesSchema = z.record(z.string().min(1).max(100), NonNegative).refine(p => Object.keys(p).length <= 100, 'Too many phases.');
const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  issues: z.array(z.object({ severity: z.enum(['blocker', 'major', 'minor']), file: z.string().max(4096).optional(), note: z.string().min(3).max(20000) })).max(200),
  summary: z.string().max(20000).optional(),
});
export const VerdictSchema = z.string().max(100000).refine(value => {
  try { return ReviewSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, 'Invalid review verdict JSON.').nullable();
const Text = z.string().max(20000).nullable();
export const RunPatchSchema = z.strictObject({
  pid: z.number().int().min(2).max(2147483647).nullable().optional(),
  proc_started: NonNegative.nullable().optional(),
  status: z.string().min(1).max(100).optional(),
  stop_reason: Text.optional(), exit_code: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  cost_usd: NonNegative.optional(), tokens_in: NonNegative.int().optional(), tokens_out: NonNegative.int().optional(),
  cost_estimated: z.boolean().optional(), last_activity: Text.optional(), touched: TouchedSchema.optional(),
  ended_at: NonNegative.nullable().optional(), lessons: LessonsSchema.optional(), verdict: VerdictSchema.optional(),
  phases: PhasesSchema.optional(), resumed: z.boolean().optional(), phase: z.string().max(200).nullable().optional(),
  effort: z.string().max(200).nullable().optional(), effort_source: z.string().max(200).nullable().optional(),
  launch_fingerprint: z.string().max(200).nullable().optional(), verdict_sha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(),
});
