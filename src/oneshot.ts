import { StringDecoder } from 'node:string_decoder';
import { getAdapter } from './adapters/index.ts';
import type { AgentEvent } from './adapters/types.ts';
import { agentSettings, priceFor, type Config, type Tier } from './config.ts';
import { emptyUsage, UsageMeter, type UsageSnapshot } from './usage.ts';
import { EffortPolicyError } from './effort.ts';
import { cleanEnv, startOwnedProcess, type OwnedProcessInfo, type OwnedRunResult, type TerminateResult } from './proc.ts';

/**
 * - succeeded: exited 0 and the agent did not report an error.
 * - failed: nonzero exit, or the agent's own result said it failed.
 * - timeout / canceled (the caller's signal) / interrupted (Ctrl-C with `interruptible`) / budget (reactive stop).
 * - spawn_failed: never started. hook_failed: started, then stopped because registering it or reading it failed.
 */
export type OneShotStatus = 'succeeded' | 'failed' | 'timeout' | 'canceled' | 'interrupted' | 'budget' | 'spawn_failed' | 'hook_failed';

export interface OneShotResult {
  ok: boolean;
  status: OneShotStatus;
  /** The final answer: the agent's result, else its last message (what structured outputs such as reviews use). */
  text: string;
  /** Every message joined, for plain CLIs that print an answer over many lines. */
  allText: string;
  /** Stopped because the user interrupted the CLI (only with `interruptible`). */
  interrupted?: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Mirrors runs.cost_estimated: true unless every figure came from the CLI itself. */
  costEstimated: boolean;
  /** Full accounting, present on every outcome, including failures before any output. */
  usage: UsageSnapshot;
  error: string;
  agent: string;
  model: string | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number;
  pid: number | null;
  /** Start identity of the CLI process (read when `onSpawn` is given). */
  procStartedAt: number | null;
  /** False when something the CLI started survived cleanup: do not start overlapping work. */
  reaped: boolean;
  reap: TerminateResult;
  /** Errors from `onUsage` or the adapter's parser. They do not change the status. */
  hookErrors: string[];
}

export interface OneShotHooks {
  /** Persist spawn intent before the supervisor can create a child. A failure launches nothing. */
  beforeSpawn?: () => void | Promise<void>;
  /** Register the CLI's pid/start identity (e.g. on a live run row). A failure stops the CLI (`hook_failed`). */
  onSpawn?: (proc: OwnedProcessInfo) => void | Promise<void>;
  /** Live usage, delivered in order. Errors are collected in `hookErrors`; they do not stop the run. */
  onUsage?: (usage: UsageSnapshot) => void | Promise<void>;
}

const HOOK_DRAIN_MS = 10_000;

/** Runs an agent once for a bounded job (planning, reviewing) and returns its final answer and spend. */
export async function runOneShot(opts: {
  agent: string;
  config: Config;
  prompt: string;
  cwd: string;
  model?: string | null;
  readOnly?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  tier?: Tier;
  maxTurns?: number;
  /**
   * Passed to CLIs that enforce a dollar cap themselves (Claude Code), and also enforced here as a reactive stop:
   * when metered spend passes it the CLI is stopped. Reactive means it can overshoot by what one usage event reports
   * plus whatever is spent before SIGTERM takes effect, and it cannot act on CLIs that report no usage.
   */
  budgetUsd?: number;
  /**
   * For runs started from a terminal (ym plan): Ctrl-C stops the agent too. It runs in its own process group so a
   * timeout can kill everything it started, which also means the terminal's Ctrl-C never reaches it on its own.
   * Never set inside the hub, where the hub's own shutdown handles this.
   */
  interruptible?: boolean;
  /** Cancels the run: the CLI's whole process group is stopped (TERM, grace, KILL) before this resolves. */
  signal?: AbortSignal;
  hooks?: OneShotHooks;
  termGraceMs?: number;
  exitGraceMs?: number;
  hookTimeoutMs?: number;
}): Promise<OneShotResult> {
  const startedAt = Date.now();
  const model = opts.model ?? null;
  const base = {
    text: '', allText: '', costUsd: 0, tokensIn: 0, tokensOut: 0, costEstimated: true, usage: emptyUsage(), agent: opts.agent, model,
    exitCode: null, signal: null, startedAt, endedAt: startedAt, pid: null, procStartedAt: null, reaped: true, reap: { status: 'exited' as const }, hookErrors: [],
  };
  const adapter = getAdapter(opts.agent, opts.config);
  if (!adapter) return { ...base, ok: false, status: 'spawn_failed', error: `unknown agent ${opts.agent}` };
  const settings = agentSettings(opts.config, opts.agent);
  let spec;
  try { spec = adapter.build({ prompt: opts.prompt, cwd: opts.cwd, model, settings, readOnly: opts.readOnly, tier: opts.tier, maxTurns: opts.maxTurns, budgetUsd: opts.budgetUsd }); }
  catch (error) {
    if (!(error instanceof EffortPolicyError)) throw error;
    return { ...base, ok: false, status: 'spawn_failed', error: error.message };
  }
  const meter = new UsageMeter(priceFor(opts.config, opts.agent, model));

  const interrupt = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, interrupt.signal]) : interrupt.signal;
  const onSignal = () => interrupt.abort('interrupted');
  if (opts.interruptible) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let result = '';
  let lastText = '';
  let allText = '';
  let resultOk: boolean | null = null;
  let stderr = '';
  let budgetHit = '';
  const hookErrors: string[] = [];
  let usageChain: Promise<void> = Promise.resolve();
  const budget = opts.budgetUsd !== undefined && opts.budgetUsd > 0 ? opts.budgetUsd : null;
  let proc: ReturnType<typeof startOwnedProcess> | null = null;

  const onEvent = (ev: AgentEvent) => {
    if (ev.type === 'result') {
      result = ev.text;
      resultOk = ev.ok;
    } else if (ev.type === 'text') {
      lastText = ev.text;
      allText = allText ? `${allText}\n${ev.text}` : ev.text;
    } else if (ev.type === 'usage') {
      meter.add(ev);
      const snap = meter.snapshot();
      if (opts.hooks?.onUsage) {
        const hook = opts.hooks.onUsage;
        usageChain = usageChain.then(() => hook(snap)).catch((err: unknown) => {
          hookErrors.push(`usage hook: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      if (budget !== null && !budgetHit && meter.spent > budget) {
        budgetHit = `stopped at its budget of $${budget.toFixed(2)} (metered $${meter.spent.toFixed(4)})`;
        proc?.stop(budgetHit);
      }
    }
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const parseLine = (line: string) => {
    let events: AgentEvent[];
    try {
      events = adapter.parse(line);
    } catch (err) {
      hookErrors.push(`parse: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const ev of events) onEvent(ev);
  };
  const onStdout = (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      parseLine(line);
    }
  };

  let run: OwnedRunResult;
  try {
    await opts.hooks?.beforeSpawn?.();
    proc = startOwnedProcess(spec.command, spec.args, {
      cwd: opts.cwd, env: cleanEnv({ ...spec.env, ...opts.env }), stdin: spec.stdin, signal,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000, termGraceMs: opts.termGraceMs, exitGraceMs: opts.exitGraceMs, hookTimeoutMs: opts.hookTimeoutMs,
      onSpawn: opts.hooks?.onSpawn, onStdout, onStderr: (d) => (stderr = (stderr + d.toString()).slice(-4000)),
    });
    run = await proc.done;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const rest = pending + decoder.end();
  if (rest.trim()) parseLine(rest);
  // Let in-flight usage hooks land (bounded), so a live row never trails the returned totals.
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([usageChain, new Promise<void>((r) => (drainTimer = setTimeout(r, HOOK_DRAIN_MS)))]);
  clearTimeout(drainTimer);

  const usage = meter.snapshot();
  const status = statusOf(run, interrupt.signal.aborted, budgetHit, resultOk);
  const error = errorOf(status, run, stderr, result || lastText);
  return {
    ok: status === 'succeeded', status, text: result || lastText, allText: result || allText, interrupted: status === 'interrupted',
    costUsd: usage.costUsd, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costEstimated: usage.provenance !== 'actual', usage, error,
    agent: opts.agent, model, exitCode: run.code, signal: run.signal, startedAt, endedAt: run.endedAt, pid: run.pid, procStartedAt: run.startedAt,
    reaped: run.reaped, reap: run.reap, hookErrors,
  };
}

function statusOf(run: OwnedRunResult, interrupted: boolean, budgetHit: string, resultOk: boolean | null): OneShotStatus {
  switch (run.end) {
    case 'aborted':
      return interrupted ? 'interrupted' : 'canceled';
    case 'timeout':
      return 'timeout';
    case 'stopped':
      return budgetHit ? 'budget' : 'canceled';
    case 'spawn_failed':
      return 'spawn_failed';
    case 'hook_failed':
      return 'hook_failed';
    case 'exit':
      return run.code === 0 && resultOk !== false ? 'succeeded' : 'failed';
  }
}

function errorOf(status: OneShotStatus, run: OwnedRunResult, stderr: string, text: string): string {
  switch (status) {
    case 'succeeded':
      return '';
    case 'failed': {
      const detail = stderr.trim().slice(-600);
      if (run.code !== 0) return detail || `exited with ${run.code === null ? `signal ${run.signal ?? 'unknown'}` : `code ${run.code}`}`;
      return detail || `the agent reported an error${text ? `: ${text.slice(0, 300)}` : ''}`;
    }
    case 'interrupted':
      return 'interrupted';
    default:
      return run.error || status;
  }
}
