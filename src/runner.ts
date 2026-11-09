import { materializeNativeArtifact, nativeArtifactRef, parseHandoff, type NativeHandoff } from './handoff.ts';
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getAdapter } from './adapters/index.ts';
import type { AdapterContext, AgentEvent, LaunchSpec } from './adapters/types.ts';
import { agentSettings, priceFor, type Config, worktreeRootOf } from './config.ts';
import { expandHome, paths } from './paths.ts';
import { addWorktree, branchExists, changedFiles, commitAll, conflictedFiles, git, hasConflictMarkers, isAncestor, isClean, isLinkedWorktreeOf, revParse } from './git.ts';
import { rememberChecked } from './ci/verified.ts';
import { cleanEnv, startOwnedProcess, runShell, type OwnedProcess } from './proc.ts';
import { escalate } from './router.ts';
import { inScope, matches } from './scope.ts';
import { clip, errorFingerprint, formatUsd, tail } from './text.ts';
import type { Project, Task } from './types.ts';
import { Watchdog, type Verdict } from './watchdog.ts';
import type { Client } from './api.ts';
import type { TaskPatch } from './coordinator.ts';
import { changedLineCount, formatIssues, runReview, shouldReview } from './review.ts';
import { siblingWorktrees, warmStart } from './warmstart.ts';
import { emptyUsage, UsageMeter, type UsageSnapshot } from './usage.ts';
import { routeEffort, routedEffortOf } from './jev.ts';
import { withProcessScope, UtilityProcessError, currentProcessScopeSignal } from './proc.ts';
import { EffortPolicyError, launchEffort, launchIdentity } from './effort.ts';
import { verifyArtifact as runVerify } from './verification.ts';

export class Semaphore {
  private queue: { grant: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) { if (!Number.isInteger(max) || max < 1) throw new Error('Capacity must be a positive integer.'); this.max = max; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('Capacity wait canceled.');
    if (this.active < this.max) this.active++;
    else await new Promise<void>((grant, reject) => {
      const waiter = { grant, reject, signal, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error('Capacity wait canceled.'));
      } };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.grant(); }
      else this.active--;
    };
  }
  async use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { if (signal?.aborted) throw new Error('Capacity wait canceled.'); return await fn(); }
    finally { release(); }
  }
}

export interface RunContext {
  api: Client;
  machineId: string;
  task: Task;
  project: Project;
  /** Local checkout of the project on this machine. */
  repoPath: string;
  agent: string;
  model: string | null;
  config: Config;
  /** Commit new worktrees start from (the integration branch head). */
  startPoint: string;
  verifySlots: Semaphore;
  /** Agents installed on this machine (for picking a reviewer). */
  installed?: string[];
  onSpawn?: (stop: (reason: StopReason, message: string) => void) => void;
  signal?: AbortSignal;
  stopTask?: (reason: StopReason, message: string) => void;
  stopReason?: () => StopReason | null;
  cleanup?: (fn: () => void | Promise<void>) => void;
  reserveAgent?: (agent: string, signal?: AbortSignal) => Promise<() => void>;
  /** Remote base materialization runs inside this attempt's durable utility scope. */
  prepareBase?: (signal?: AbortSignal) => Promise<void>;
  runId?: string;
}

export type StopReason = Verdict['kind'] | 'budget' | 'canceled' | 'stopped' | 'preempted' | 'shutdown' | 'redirected' | 'lost';

export interface RunOutcome {
  /** "superseded": the task was canceled or re-claimed elsewhere while this attempt ran; nothing was written. */
  status: Task['status'] | 'superseded';
  message: string;
}

function underRoot(path: string, root: string): boolean {
  return resolve(path).startsWith(resolve(root) + '/');
}

function isStale(err: unknown): boolean {
  return /no longer owned by this attempt/.test((err as Error)?.message ?? '');
}

export function worktreePathFor(config: Config, project: Project, taskId: string): string {
  return join(worktreeRootOf(config), `${project.name}-${project.id.slice(2, 8)}`, taskId);
}

/** A task's own checks run in addition to the project's: work never merges on a lower bar than the project sets. */
export function verifyCommands(task: Pick<Task, 'verify'>, config: Pick<Config, 'verify'>): string[] {
  return [...config.verify, ...(task.verify ?? []).filter((c) => !config.verify.includes(c))];
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The checks a task runs on itself: quick, change-scoped ones when configured, otherwise the full list. */
export function taskChecks(task: Task, config: Config, files: string[]): string[] {
  // Quick checks are only safe when the full suite runs later, at merge time.
  if (!config.verifyQuick.length || config.integration.mode === 'none') return verifyCommands(task, config);
  const list = files.map(shellQuote).join(' ');
  const quick = config.verifyQuick.filter((c) => !c.includes('{files}') || files.length).map((c) => c.replaceAll('{files}', list));
  return [...quick, ...(task.verify ?? []).filter((c) => !quick.includes(c))];
}

/**
 * The brief is ordered from most stable to most specific: the fixed rules first (identical for every task, so model
 * providers can cache that opening across tasks and retries), then the task, then what's happening around it.
 */
/**
 * What "done" means for this task. With quick checks configured, the agent is told to run those on its own
 * changes and that the full suite runs once at merge time: running the whole suite inside the agent costs minutes
 * and floods its context with test output, and Yardmaster runs the checks again anyway.
 */
function doneMeans(task: Task, config: Config): string {
  const quick = config.verifyQuick.length && config.integration.mode !== 'none';
  if (quick) {
    const cmds = config.verifyQuick.map((c) => `\`${c.replaceAll('{files}', '<the files you changed>')}\``).join(', ');
    return `## Done means\nThese pass for your changes: ${cmds}. The full suite runs once at merge time, so you don't need to run all of it.`;
  }
  const verify = verifyCommands(task, config);
  return verify.length ? `## Done means\nThese pass: ${verify.map((v) => `\`${v}\``).join(', ')}.` : '## Done means\nYour change works; check it runs before finishing.';
}

/**
 * The message for a resumed session: the agent already has the task, the rules and everything it read, so it only
 * needs what's new. This is the main saving of resuming: no re-sent brief and no re-exploring the code.
 */
function buildResumePrompt(ctx: RunContext, extra: { messages: { from: string; body: string }[]; conflicts: string[] }): string {
  const { task, config } = ctx;
  const parts = ['## Continue this task (same worktree, same branch)'];
  if (task.retry_note) parts.push(`What happened since your last turn:\n${task.retry_note}`);
  if (extra.conflicts.length) parts.push(`First resolve the merge conflict markers in: ${extra.conflicts.join(', ')} (the latest merged work was combined into your branch).`);
  if (extra.messages.length) parts.push(`Notes from teammates:\n${extra.messages.map((m) => `- ${m.from}: ${clip(m.body, 400)}`).join('\n')}`);
  parts.push(doneMeans(task, config));
  parts.push('Fix what is described, keep your other work, and end with a 1-3 sentence summary of what you changed.');
  return parts.join('\n\n');
}

function buildPrompt(ctx: RunContext, extra: { deps: { id: string; title: string; summary: string }[]; others: { id: string; title: string; scope: string[] }[]; messages: { from: string; body: string }[]; conflicts: string[]; guidance?: string | null; coupling?: string[]; lessons?: string; map?: string[] }): string {
  const { task, config } = ctx;
  const parts: string[] = [];
  parts.push(
    [
      'You are working on one task in an isolated git worktree managed by Yardmaster. Other agents may be working on other tasks in parallel.',
      '## Rules',
      '- Do not push, switch branches, or run destructive git commands (reset --hard, clean, checkout of other branches). Yardmaster commits your work for you.',
      '- Do not ask questions; nobody is watching this session. If information is missing, make a reasonable choice and note it.',
      '- Stay focused on the task: read what you need, change what it requires, and stop.',
      '- End with a short summary (1-3 sentences) of what you changed.',
    ].join('\n'),
  );
  parts.push(`## Task (${task.id})\n${task.title}\n\n${task.prompt !== task.title ? task.prompt : ''}`.trim());
  parts.push(doneMeans(task, config));
  if (task.scope.length) {
    parts.push(`## Files you own\n${task.scope.join(', ')}\nKeep your changes inside these. If something outside them must change, keep it minimal and say why in your final message.`);
  }
  if (extra.map?.length) parts.push(`## Where things are (from the import graph)\n${extra.map.map((m) => `- ${m}`).join('\n')}`);
  const others = extra.others.filter((o) => o.scope.length);
  if (others.length) {
    parts.push(`## Do not edit (other agents are changing these right now)\n${others.map((o) => `- ${o.scope.join(', ')} (${o.id} "${clip(o.title, 50)}")`).join('\n')}`);
  }
  if (extra.coupling?.length) {
    parts.push(`## Coordinate: code you touch is linked to work in progress\n${extra.coupling.map((c) => `- ${c}`).join('\n')}\nKeep exported names and signatures those files rely on stable. If you must change one, say exactly what changed in your final summary so the other agent can adapt.`);
  }
  if (extra.guidance) parts.push(`## House rules for this kind of change\n${extra.guidance}`);
  if (extra.lessons) parts.push(`## Lessons from earlier work in this repo\n${extra.lessons}`);
  if (extra.deps.length) {
    parts.push(`## Finished work you build on\n${extra.deps.map((d) => `- ${d.id} "${clip(d.title, 60)}": ${d.summary || 'done'}`).join('\n')}`);
  }
  if (extra.messages.length) {
    parts.push(`## Notes from teammates\n${extra.messages.map((m) => `- ${m.from}: ${clip(m.body, 400)}`).join('\n')}`);
  }
  if (extra.conflicts.length) {
    parts.push(`## First: resolve merge conflicts\nThe latest merged work was combined into your branch and these files have conflict markers: ${extra.conflicts.join(', ')}. Resolve them, keeping both sides' intent, before continuing.`);
  }
  if (task.retry_note) parts.push(`## Notes from the previous attempt or the person supervising\n${task.retry_note}\nYour earlier changes (if any) are still in this worktree. Build on them rather than starting over.`);
  return parts.join('\n\n');
}

class LogBuffer {
  private pending: string[] = [];
  private timer: NodeJS.Timeout;
  private readonly api: Client;
  private readonly runId: string;
  constructor(api: Client, runId: string) {
    this.api = api;
    this.runId = runId;
    this.timer = setInterval(() => void this.flush(), 1500);
  }
  push(line: string) {
    this.pending.push(`${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${line}`);
    if (this.pending.length >= 200) void this.flush();
  }
  async flush() {
    if (!this.pending.length) return;
    const lines = this.pending.splice(0, 500);
    await this.api['run.log']({ runId: this.runId, lines }).catch(() => undefined);
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

function describe(ev: AgentEvent): string | null {
  switch (ev.type) {
    case 'tool': {
      const input = typeof ev.input === 'object' && ev.input ? (ev.input as Record<string, unknown>) : {};
      const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? (typeof ev.input === 'string' ? ev.input : '');
      return `${ev.write ? 'edit' : 'tool'} ${ev.name} ${clip(String(target ?? ''), 140)}`;
    }
    case 'tool_result':
      return ev.ok ? null : `error ${clip(ev.text, 200)}`;
    case 'text':
      return `says ${clip(ev.text, 240)}`;
    case 'error':
      return `error ${clip(ev.text, 240)}`;
    case 'result':
      return `finished ${ev.ok ? 'ok' : 'with errors'}: ${clip(ev.text, 200)}`;
    default:
      return null;
  }
}

/** Runs one attempt of a task end to end: worktree, agent, watchdog, commit, scope check, verification. */
export async function runAttempt(ctx: RunContext): Promise<RunOutcome> {
  const cleanups: (() => void | Promise<void>)[] = [];
  const lifetime = new AbortController();
  let stopped: { reason: StopReason; message: string } | null = null;
  let activeStop: RunContext['stopTask'];
  let polling = false;
  let lease = ctx.task.lease_until ?? Date.now();
  const stopTask = (reason: StopReason, message: string) => {
    if (stopped) return;
    stopped = { reason, message };
    lifetime.abort(message);
    activeStop?.(reason, message);
  };
  ctx.onSpawn?.(stopTask);
  const control = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    void ctx.api['task.peek']({ id: ctx.task.id }).then((t) => {
      if (t.generation !== ctx.task.generation || t.assignee !== ctx.task.assignee) stopTask('lost', 'This claim was superseded.');
      else if (t.status === 'canceled') stopTask('canceled', 'Canceled on request.');
      else if (t.control === 'stop') stopTask('stopped', 'Stopped on request.');
      else if (t.control === 'stop-pause') stopTask('shutdown', 'Paused; work is preserved.');
      else if (t.control === 'redirect') stopTask('redirected', 'Restarting with your new guidance.');
      else if (['running', 'verifying'].includes(t.status)) {
        lease = t.lease_until ?? lease;
        if (lease <= Date.now()) stopTask('lost', 'The claim lease expired; this process must stop before work is reassigned.');
      }
    }).catch(() => { if (lease <= Date.now()) stopTask('lost', 'Hub unreachable beyond the claim lease.'); })
      .finally(() => { polling = false; });
  }, 250);
  try {
    const owner = claimOwner(ctx.task);
    const fenced = new Set(['task.update', 'task.usage', 'task.touched', 'task.event', 'run.start', 'run.update', 'run.log', 'run.usage', 'run.utility', 'lesson.outcome']);
    const api = new Proxy(ctx.api, { get: (target, key: string) => {
      const call = target[key as keyof Client];
      return fenced.has(key) ? (params: Record<string, unknown>) => {
        const status = (params.patch as TaskPatch | undefined)?.status;
        if (lifetime.signal.aborted && (key === 'run.start' || (key === 'task.update' &&
            (status === 'ready' || (status === 'queued' && ['stopped', 'canceled', 'lost'].includes(stopped?.reason ?? '')))))) throw new Error('Task lifetime stopped.');
        return (call as (p: unknown) => unknown)({ ...params, owner });
      } : call;
    } });
    return await runAttemptInner({ ...ctx, api, signal: lifetime.signal, stopTask, stopReason: () => stopped?.reason ?? null, cleanup: (fn) => cleanups.push(fn), onSpawn: (handler) => {
      activeStop = handler;
      const pending = stopped as { reason: StopReason; message: string } | null;
      if (pending) handler(pending.reason, pending.message);
    } });
  } catch (err) {
    const control = /Task control pending: (.+)/.exec((err as Error)?.message ?? '')?.[1];
    if (control) stopTask(control === 'cancel' ? 'canceled' : control === 'redirect' ? 'redirected' : control === 'stop-pause' ? 'shutdown' : 'stopped',
      control === 'cancel' ? 'Canceled on request.' : control === 'redirect' ? 'Restarting with your new guidance.' : control === 'stop-pause' ? 'Paused; work is preserved.' : 'Stopped on request.');
    if (isStale(err)) return { status: 'superseded', message: (err as Error).message };
    const pending = stopped as { reason: StopReason; message: string } | null;
    if (pending) {
      if (pending.reason === 'lost') return { status: 'superseded', message: pending.message };
      if (pending.reason === 'canceled') return { status: 'canceled', message: pending.message };
      const requeue = ['shutdown', 'redirected', 'preempted'].includes(pending.reason);
      await ctx.api['task.update']({ id: ctx.task.id, owner: claimOwner(ctx.task), patch: {
        status: requeue ? 'queued' : 'needs_human', attention: requeue ? null : pending.message,
        ...(requeue ? { attempts: Math.max(0, ctx.task.attempts - 1), assignee: null, machine_id: null } : {}), lease_until: null,
      } }).catch(() => undefined);
      return { status: requeue ? 'queued' : 'needs_human', message: pending.message };
    }
    throw err;
  } finally {
    clearInterval(control);
    await Promise.allSettled(cleanups.map((fn) => Promise.resolve().then(fn)));
  }
}

async function runAttemptInner(ctx: RunContext): Promise<RunOutcome> {
  const { api, task, config } = ctx;
  if (!Number.isSafeInteger(task.generation) || task.generation < 1) throw new Error('A valid claim generation is required. Upgrade the worker and claim the task again.');
  let preparationStop: { reason: StopReason; message: string } | null = null;
  const preparationAbort = new AbortController();
  // Install before the first await: shutdown must also stop attempts preparing a worktree or waiting on JEV.
  ctx.onSpawn?.((reason, message) => {
    preparationStop = { reason, message };
    preparationAbort.abort();
  });
  const initial = await api['task.peek']({ id: task.id });
  if (initial.generation !== task.generation || initial.assignee !== task.assignee || initial.status !== 'running' ||
      initial.lease_until === null || initial.lease_until <= Date.now()) return { status: 'superseded', message: 'This attempt no longer owns the task.' };

  // Where the attempt's time went: prepare (worktree, dependencies), agent, collect (commit, scope, bookkeeping), verify, review.
  const phases: Record<string, number> = {};
  let phaseStart = Date.now();
  const phase = (name: string) => {
    const now = Date.now();
    phases[name] = (phases[name] ?? 0) + (now - phaseStart);
    phaseStart = now;
  };
  const adapter = getAdapter(ctx.agent, config)!;
  if (!adapter && !task.native_handoff) return finishNeedsHuman(ctx, `No adapter for agent "${ctx.agent}".`);

  const rawLog = join(paths.logs(), `${task.id}-${task.generation}.jsonl`);
  const runId = await api['run.start']({ taskId: task.id, machineId: ctx.machineId, agent: ctx.agent, model: ctx.model, logPath: rawLog });
  let attemptReaped = true;
  let finalUsageRecorded = true;
  ctx.cleanup?.(() => attemptReaped && finalUsageRecorded ? api['run.exit']({ runId, taskId: task.id, owner: claimOwner(task), reaped: true }) : undefined);
  try {
    return await withProcessScope({ signal: ctx.signal,
      beforeSpawn: child => api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'intent', token: child.token, command: child.command } }),
      onSpawn: (token, child) => api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'spawn', token, pid: child.pid, startedAt: child.startedAt } }),
      onExit: (token, result) => api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'exit', token, pid: result.pid, startedAt: result.startedAt, reaped: result.reaped } }),
    }, async () => {
  ctx = { ...ctx, runId, signal: currentProcessScopeSignal() ?? ctx.signal };
  await ctx.prepareBase?.(ctx.signal);
  const log = new LogBuffer(api, runId);
  ctx.cleanup?.(() => log.close());
  await api['run.update']({ runId, patch: { phase: 'prepare' } });
  if (task.native_handoff) return runNativeArtifact(ctx, runId, log, phase, value => { attemptReaped = value; });
  const prepareState = await api['task.peek']({ id: task.id });
  if (prepareState.status !== 'running' || prepareState.generation !== task.generation || prepareState.assignee !== task.assignee) {
    ctx.stopTask?.(prepareState.status === 'canceled' ? 'canceled' : 'lost', 'Claim changed before preparation.');
    throw new Error('Task lifetime stopped before preparation.');
  }

  // Only ever reuse a worktree that is ours: under our root and linked to this repo.
  const defaultPath = worktreePathFor(config, ctx.project, task.id);
  const ourRoot = dirname(defaultPath);
  const reusable = (p: string | null) => !!p && existsSync(p) && underRoot(p, ourRoot) && isLinkedWorktreeOf(p, ctx.repoPath);
  const wt = reusable(task.worktree) ? task.worktree! : defaultPath;
  if (existsSync(wt) && !reusable(wt)) return finishNeedsHuman(ctx, `${wt} already exists and is not a Yardmaster worktree of this repo. Move it away, then retry.`);
  const branch = task.branch ?? `yardmaster/${task.id}`;
  let baseSha = task.base_sha;
  const conflicts: string[] = [];
  let freshWorktree = false;
  try {
    if (!existsSync(wt)) {
      freshWorktree = true;
      const hadBranch = await branchExists(ctx.repoPath, branch);
      await addWorktree(ctx.repoPath, wt, branch, ctx.startPoint);
      if (hadBranch) {
        // An older attempt's branch on this machine: bring it up to date with merged work first.
        const merge = await git(wt, ['merge', '--no-edit', ctx.startPoint], { allowFail: true });
        if (merge.code !== 0) conflicts.push(...(await conflictedFiles(wt)));
      }
      baseSha = ctx.startPoint;
    } else if (task.pending_rebase) {
      const merge = await git(wt, ['merge', '--no-edit', ctx.startPoint], { allowFail: true });
      if (merge.code !== 0) conflicts.push(...(await conflictedFiles(wt)));
      baseSha = ctx.startPoint;
    }
    baseSha ??= (await revParse(wt, 'HEAD')) ?? ctx.startPoint;
  } catch (err) {
    if (/Task control pending:/.test((err as Error)?.message ?? '')) throw err;
    return finishNeedsHuman(ctx, `Could not prepare a git worktree: ${(err as Error).message}`);
  }
  await update(ctx, { worktree: wt, branch, base_sha: baseSha, pending_rebase: false });
  // Fresh worktree: bring over installed dependencies and run setup, so the agent starts on the actual task.
  if (freshWorktree) {
    const warm = await warmStart(ctx.repoPath, wt, config, { candidates: siblingWorktrees(wt) }).catch((err: Error) => ({ cloned: [], skipped: [{ rel: '*', why: err.message }], copied: [], ms: 0, source: null, stale: false }));
    if (warm.cloned.length || warm.copied.length) {
      const from = warm.source === ctx.repoPath ? 'your checkout' : 'another worktree with the same lockfiles';
      await event(ctx, 'info', 'task.warm_start', `Ready in ${(warm.ms / 1000).toFixed(1)}s with ${[...warm.cloned.map((c) => c.rel), ...warm.copied].join(', ')} from ${from} (no reinstall needed)`);
    }
    if (warm.stale && warm.cloned.length) {
      await event(ctx, 'info', 'task.warm_start_stale', `No checkout has this task's exact lockfiles, so its dependencies may be out of date. If checks fail on missing packages, add a worktree "setup" command such as "npm ci".`);
    }
    for (const sk of warm.skipped) await event(ctx, 'info', 'task.warm_start_skipped', `Didn't bring over ${sk.rel}: ${sk.why}`);
    for (const command of config.worktree.setup) {
      await api['run.update']({ runId, patch: { phase: 'setup:spawning' } });
      attemptReaped = false;
      const r = await runShell(command, { cwd: wt, timeoutMs: config.verifyTimeoutMinutes * 60_000, signal: ctx.signal, onSpawn: async ({ pid, startedAt }) => { await api['run.update']({ runId, patch: { phase: 'setup', pid, proc_started: startedAt } }); } });
      attemptReaped = r.reaped;
      if (!r.reaped) { attemptReaped = false; await api['run.update']({ runId, patch: { status: 'cleanup_failed' } }); return finishNeedsHuman(ctx, 'A setup process survived cleanup; work is held for recovery.'); }
      await api['run.update']({ runId, patch: { phase: 'prepare', pid: null, proc_started: null } });
      if (r.code !== 0) return finishNeedsHuman(ctx, `Worktree setup \`${command}\` failed:\n${tail(r.stdout, 20, 1500)}`);
    }
  }

  const context = await api['task.context']({ id: task.id });
  if (context.lessonIds.length) await api['run.update']({ runId, patch: { lessons: context.lessonIds } });
  const settings = agentSettings(config, ctx.agent);
  // Resume only a recent, same-agent conversation whose managed launch shape still matches.
  let resumeId = adapter.resumable && settings.resume && !freshWorktree && task.agent_session && task.session_agent === ctx.agent && task.session_at !== null && Date.now() - task.session_at < 60 * 60_000 ? task.agent_session : null;
  let pinned = !resumeId && adapter.resumable ? randomUUID() : null;
  let baseline = resumeId ? task.session_cost : 0;
  const reservation = await api['run.update']({ runId, patch: {}, launch: true });
  if (!reservation) throw new Error('Missing launch budget authorization.');
  const taskRemaining = reservation.amountUsd;
  phase('prepare');
  const effort = await routeEffort({ config: config.effortRouting, agent: ctx.agent, model: ctx.model, settings,
    tier: task.tier, task, repoPath: ctx.repoPath, signal: ctx.signal,
    beforeSpawn: async () => {
      await api['run.update']({ runId, patch: { phase: 'route:spawning' } });
      attemptReaped = false;
    },
    onSpawn: async ({ pid, startedAt }) => {
      await api['run.update']({ runId, patch: { phase: 'route', pid, proc_started: startedAt } });
    },
  });
  if (effort.process?.reaped) {
    attemptReaped = true;
    await api['run.update']({ runId, patch: { phase: 'prepare', pid: null, proc_started: null } });
  }
  if (effort.reason === 'process_unreaped' || effort.reason === 'registration_failed') {
    if (!attemptReaped) await api['run.update']({ runId, patch: { status: 'cleanup_failed', stop_reason: `JEV ${effort.reason}` } });
    return finishNeedsHuman(ctx, `Effort routing could not finish safely (${effort.reason}). Work is preserved; confirm process recovery before retrying.`);
  }
  if (config.effortRouting.enabled) phase('route');
  const input: AdapterContext = { prompt: resumeId ? buildResumePrompt(ctx, { messages: context.messages, conflicts }) : buildPrompt(ctx, { ...context, conflicts }),
    cwd: wt, model: ctx.model, settings, tier: task.tier, routedEffort: routedEffortOf(effort),
    budgetUsd: taskRemaining,
    session: resumeId ? { resume: resumeId } : pinned ? { pin: pinned } : undefined };
  const build = (): LaunchSpec => {
    const spec = adapter.build(input);
    if (ctx.agent === 'claude' && effort.managed) spec.env = { ...spec.env, JEV_ROUTER_HOST_ROUTING: '1' };
    return spec;
  };
  let toolConfigDigest: string | null = null;
  if (settings.mcpConfig) {
    try { toolConfigDigest = createHash('sha256').update(readFileSync(resolve(wt, expandHome(settings.mcpConfig)))).digest('hex'); }
    catch { toolConfigDigest = 'unreadable'; }
  }
  let spec: LaunchSpec;
  let effective;
  let fingerprint: string;
  try {
    spec = build();
    effective = launchEffort(ctx.agent, input, spec);
    const identity = launchIdentity(ctx.agent, input, spec).fingerprint;
    fingerprint = createHash('sha256').update(`${identity}:${toolConfigDigest ?? ''}`).digest('hex');
    if (resumeId && task.session_fingerprint !== fingerprint) {
      resumeId = null;
      baseline = 0;
      pinned = adapter.resumable ? randomUUID() : null;
      input.prompt = buildPrompt(ctx, { ...context, conflicts });
      input.session = pinned ? { pin: pinned } : undefined;
      input.budgetUsd = taskRemaining;
      spec = build();
      await event(ctx, 'info', 'task.resume_identity_changed', 'Starting a fresh conversation because its model, effort, tools or launch configuration changed (or the previous identity was not recorded). Worktree changes are preserved; provider cache impact remains unknown.');
    }
  } catch (error) {
    if (!(error instanceof EffortPolicyError)) throw error;
    return finishNeedsHuman(ctx, error.message, runId);
  }
  await api['run.update']({ runId, patch: { effort: effective.effective, effort_source: effective.source, launch_fingerprint: fingerprint } });
  const beforeLaunch = async (): Promise<RunOutcome | null> => {
    // The routing wait may outlive a cancellation, redirect or ownership change. Never launch stale work.
    const current = await api['task.peek']({ id: task.id });
    if (current.assignee !== task.assignee || current.generation !== task.generation || !['running', 'canceled'].includes(current.status)) return { status: 'superseded', message: 'This attempt no longer owns the task.' };
    const pending = preparationStop as { reason: StopReason; message: string } | null;
    if (current.status === 'canceled' || pending?.reason === 'canceled') return { status: 'canceled', message: 'Canceled before the agent started.' };
    const reason = pending?.reason ?? (current.control === 'stop-pause' ? 'shutdown' : current.control === 'redirect' ? 'redirected' : current.control === 'stop' ? 'stopped' : null);
    if (!reason) return null;
    if (reason === 'lost') return { status: 'superseded', message: 'This attempt no longer owns the task.' };
    if (reason === 'shutdown' || reason === 'redirected') {
      await savePartialWork(ctx, wt);
      await update(ctx, { status: 'queued', control: null, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, not_before: null });
      return { status: 'queued', message: pending?.message ?? 'Paused before the agent started.' };
    }
    return finishNeedsHuman(ctx, pending?.message ?? 'Stopped before the agent started.');
  };
  {
    const stopped = await beforeLaunch();
    if (stopped) return stopped;
  }
  phase('prepare');

  log.push(`start ${adapter.label}${ctx.model ? ` (${ctx.model})` : ''} in ${wt}${resumeId ? ` (continuing session ${resumeId.slice(0, 8)})` : ''}`);
  if (effort.status !== 'disabled') log.push(`JEV effort: ${effort.status} (${effort.reason}, ${effort.latencyMs} ms)`);
  if (resumeId) await api['run.update']({ runId, patch: { resumed: true } });
  {
    const stopped = await beforeLaunch();
    if (stopped) {
      await log.close();
      await api['run.update']({ runId, patch: { status: 'stopped', ended_at: Date.now(), stop_reason: 'before_launch' } });
      return stopped;
    }
  }
  let sessionId: string | null = resumeId ?? pinned;
  let toolCalls = 0;

  const raw: WriteStream = createWriteStream(rawLog, { flags: 'a' });
  ctx.cleanup?.(() => { raw.end(); });
  const watchdog = new Watchdog(config.watchdog);
  const meter = new UsageMeter(priceFor(config, ctx.agent, ctx.model), baseline);
  let usageSequence = 0;
  const recordUsage = (usage: UsageSnapshot) => api['run.usage']({ runId, taskId: task.id, owner: claimOwner(task), sequence: ++usageSequence, usage });
  let resultText = '';
  let resultOk: boolean | null = null;
  let lastText = '';
  let stderrTail = '';
  let stop: { reason: StopReason; message: string } | null = null;
  let lastActivity = '';
  const budget = reservation.amountUsd;
  const owner = claimOwner(task);

  let coding: OwnedProcess | null = null;
  const requestStop = (reason: StopReason, message: string) => {
    if (stop) return;
    stop = { reason, message };
    log.push(`stop ${reason}: ${message}`);
    coding?.stop(message);
    ctx.stopTask?.(reason, message);
  };
  ctx.onSpawn?.(requestStop);
  const pendingStop = preparationStop as { reason: StopReason; message: string } | null;
  if (pendingStop) requestStop(pendingStop.reason, pendingStop.message);

  const spent = () => meter.spent;
  const onEvent = (ev: AgentEvent) => {
    if (ev.type === 'session') {
      sessionId = ev.id;
      return;
    }
    if (ev.type === 'tool') toolCalls++;
    if (ev.type === 'usage') {
      meter.add(ev);
      if (budget !== null && spent() > budget) {
        requestStop('budget', `This run exceeded its reserved budget allowance of ${formatUsd(budget)} (observed ${formatUsd(spent())}).`);
      }
      return;
    }
    if (ev.type === 'text') lastText = ev.text;
    if (ev.type === 'result') {
      resultText = ev.text;
      resultOk = ev.ok;
    }
    const line = describe(ev);
    if (line) {
      log.push(line);
      lastActivity = line;
    }
    const verdict = watchdog.feed(ev);
    if (verdict) requestStop(verdict.kind, verdict.message);
  };

  const decoder = new StringDecoder('utf8');
  let buffered = '';
  const consume = (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      raw.write(line + '\n');
      try { for (const ev of adapter.parse(line)) onEvent(ev); }
      catch (err) { requestStop('stopped', `The agent adapter could not parse its output: ${(err as Error).message}`); }
    }
    if (buffered.length > 1_000_000) requestStop('stopped', 'Agent output exceeded the bounded line size.');
  };
  const releaseAgent = await ctx.reserveAgent?.(ctx.agent, ctx.signal);
  if (releaseAgent) ctx.cleanup?.(releaseAgent);
  await api['run.update']({ runId, patch: {}, launch: true });
  await api['run.update']({ runId, patch: { phase: 'agent:spawning' } });
  attemptReaped = false;
  finalUsageRecorded = false;
  coding = startOwnedProcess(spec.command, spec.args, {
    cwd: wt, env: cleanEnv({ ...spec.env, YARDMASTER_TASK_ID: task.id, YARDMASTER_ATTEMPT: String(task.attempts),
      YARDMASTER_GENERATION: String(task.generation), YARDMASTER_PROJECT_ID: task.project_id }),
    stdin: spec.stdin, signal: ctx.signal,
    onSpawn: async ({ pid, startedAt }) => {
      await api['run.update']({ runId, patch: { phase: 'agent', pid, proc_started: startedAt } });
    },
    onStdout: (chunk) => consume(decoder.write(chunk)),
    onStderr: (chunk) => {
      const text = chunk.toString();
      raw.write(JSON.stringify({ stderr: text }) + '\n');
      stderrTail = tail(stderrTail + text, 40);
    },
  });

  let lastTouchedCheck = 0;
  const tickMs = Math.min(2000, Math.max(200, config.liveOverlapIntervalSeconds * 500));
  let ticking: Promise<void> | null = null;
  const tick = async () => {
    const v = watchdog.tick();
    if (v) requestStop(v.kind, v.message);
    await recordUsage(meter.snapshot()).catch(() => undefined);
    const patch: Record<string, unknown> = { last_activity: lastActivity };
    await api['run.update']({ runId, patch }).catch(() => undefined);
    try {
      const control = await api['task.peek']({ id: task.id });
      if (control.assignee !== owner.assignee || control.generation !== owner.generation) requestStop('lost', 'This attempt no longer owns the task (it was re-queued or claimed elsewhere).');
      else if (control.status === 'canceled') requestStop('canceled', 'Canceled.');
      else if (control.control === 'stop') requestStop('stopped', 'Stopped on request.');
      else if (control.control === 'stop-pause') requestStop('shutdown', 'Paused by the supervisor; partial work is saved.');
      else if (control.control === 'redirect') requestStop('redirected', 'Restarting with new guidance from the supervisor.');
      if (Date.now() - lastTouchedCheck > config.liveOverlapIntervalSeconds * 1000 && !stop) {
        lastTouchedCheck = Date.now();
        const touched = await changedFiles(wt, baseSha!);
        const overlap = await api['task.touched']({ taskId: task.id, runId, files: touched });
        if (overlap) {
          requestStop('preempted', `Paused: it started editing ${overlap.file}, which ${overlap.otherId} "${clip(overlap.otherTitle, 50)}" is also changing. It will continue automatically after that task merges, so the two never collide.`);
          await update(ctx, { wait_for: overlap.otherId });
        }
      }
    } catch {
      // Hub briefly unreachable: keep working, the lease gives us time.
    }
  };
  const ticker = setInterval(() => {
    if (ticking) return;
    ticking = tick().finally(() => { ticking = null; });
  }, tickMs);

  const result = await coding.done.finally(async () => {
    clearInterval(ticker);
    await ticking;
    releaseAgent?.();
    consume(decoder.end() + (buffered ? '\n' : ''));
    raw.end();
  });
  attemptReaped = result.reaped;
  const code = result.code ?? 127;
  if (!result.reaped) {
    await recordUsage(meter.snapshot());
    attemptReaped = false;
    await log.close();
    await api['run.update']({ runId, patch: { status: 'cleanup_failed', stop_reason: result.reap.reason ?? 'Process cleanup could not be verified', ended_at: Date.now() } }).catch(() => undefined);
    return finishNeedsHuman(ctx, 'An owned process may still be alive. This worktree is held until process recovery proves it stopped.');
  }
  if (result.end === 'hook_failed' || result.end === 'spawn_failed') {
    stderrTail = `${result.error}\n${stderrTail}`;
  }
  phase('agent');
  const cost = spent();
  const { tokensIn, tokensOut } = meter;
  await recordUsage(meter.snapshot());
  finalUsageRecorded = true;
  await api['run.update']({ runId, patch: { exit_code: code, last_activity: lastActivity, phase: 'collect', pid: null, proc_started: null } }).catch((err) => { if (!isStale(err)) throw err; });
  if (result.end === 'hook_failed' || result.end === 'spawn_failed') return finishNeedsHuman(ctx, `The agent could not be safely started/registered: ${result.error || stderrTail}`, runId);
  const totals: TaskPatch = {};
  const summary = clip(resultText || lastText, 1200);
  // Remember the session, and what it has cost so far, so a retry can continue it without charging this run again.
  // Interrupted runs (redirect, preemption, shutdown) count too: they are resumed next. Owner-fenced like every write.
  const stopReason = (stop as { reason: StopReason } | null)?.reason;
  if (sessionId && adapter.resumable && stopReason !== 'lost' && stopReason !== 'canceled') {
    await update(ctx, { agent_session: sessionId, session_agent: ctx.agent, session_cost: meter.sessionTotal, session_at: Date.now(), session_fingerprint: fingerprint });
  }

  const finishRun = async (status: string, reason?: string) => {
    phase('collect');
    await log.close();
    await api['run.update']({ runId, patch: { status, stop_reason: reason ?? null, phases, phase: 'collect', ended_at: Date.now() } });
  };

  // ---- stopped by us ----
  const stopped = stop as { reason: StopReason; message: string } | null;
  if (stopped) {
    await finishRun('stopped', stopped.reason);
    switch (stopped.reason) {
      case 'canceled':
        return { status: 'canceled', message: stopped.message };
      case 'lost':
        return { status: 'superseded', message: stopped.message };
      case 'preempted':
        await savePartialWork(ctx, wt);
        await event(ctx, 'warn', 'task.preempted', stopped.message);
        await update(ctx, { status: 'queued', pending_rebase: true, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, retry_note: 'You were paused because another task was editing the same files. Its work is now merged into your branch.' });
        return { status: 'queued', message: stopped.message };
      case 'redirected':
        await savePartialWork(ctx, wt);
        await update(ctx, { status: 'queued', control: null, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, not_before: null });
        return { status: 'queued', message: stopped.message };
      case 'shutdown':
        await savePartialWork(ctx, wt);
        await update(ctx, { status: 'queued', attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, retry_note: 'Your previous run was interrupted because Yardmaster restarted. Continue from the current state of the worktree.' });
        return { status: 'queued', message: stopped.message };
      case 'loop':
      case 'oscillation':
      case 'repeated_error':
      case 'stall':
        return retryOrStop(ctx, totals, stopped.message, `stuck:${stopped.reason}`, { escalateNow: true });
      default:
        return finishNeedsHuman(ctx, stopped.message, undefined, totals);
    }
  }

  // ---- agent exited by itself ----
  const failureText = [stderrTail, resultOk === false ? resultText : ''].join('\n');
  if ((code !== 0 || resultOk === false) && resumeId && toolCalls === 0) {
    // The session couldn't be continued (expired, cleaned up, or the CLI refused): start fresh, without charging an attempt.
    await finishRun('failed', 'resume_failed');
    await event(ctx, 'info', 'task.resume_failed', `Couldn't continue the earlier ${adapter.label} session; starting a fresh one.`);
    await update(ctx, { status: 'queued', agent_session: null, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, not_before: null });
    return { status: 'queued', message: 'resume failed; retrying fresh' };
  }
  if (code !== 0 || resultOk === false) {
    await finishRun('failed');
    const kind = adapter.classifyFailure?.(`${failureText}\n${lastText}`) ?? null;
    if (kind === 'auth') return finishNeedsHuman(ctx, `${adapter.label} is not signed in on this machine. ${adapter.setupHint ?? ''}`, undefined, totals);
    if (kind === 'rate_limit') {
      const wait = config.retry.backoffSeconds * 1000 * Math.max(1, task.attempts) * 3;
      await event(ctx, 'warn', 'task.rate_limited', `${adapter.label} hit a usage limit. Trying again in ${Math.round(wait / 1000)}s.`);
      await update(ctx, { status: 'queued', attempts: Math.max(0, task.attempts - 1), not_before: Date.now() + wait, assignee: null, machine_id: null, lease_until: null });
      return { status: 'queued', message: 'rate limited' };
    }
    if (code === 127 || /ENOENT|command not found/i.test(failureText)) return finishNeedsHuman(ctx, `${adapter.label} is not installed on this machine. ${adapter.setupHint ?? ''}`, undefined, totals);
    return retryOrStop(ctx, totals, `The agent exited with an error: ${clip(tail(failureText || lastText, 12), 900)}`, errorFingerprint(failureText || lastText));
  }

  // ---- collect the work ----
  const onBranch = (await git(wt, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
  if (onBranch !== `refs/heads/${branch}`) {
    // The agent switched branches or detached HEAD. Adopt its commits if they build on our branch; never drop them.
    if (await isAncestor(wt, branch, 'HEAD')) await git(wt, ['checkout', '-B', branch]);
    else {
      await finishRun('failed');
      return finishNeedsHuman(ctx, `The agent left its worktree on ${onBranch || 'a detached HEAD'} instead of ${branch}. Nothing was deleted: inspect ${wt} and retry.`);
    }
  }
  let files: string[] = [];
  try {
    await commitAll(wt, `${task.title}\n\nYardmaster-Task: ${task.id}\nAgent: ${ctx.agent}${ctx.model ? `/${ctx.model}` : ''}`);
    files = await changedFiles(wt, baseSha!);
  } catch (err) {
    await finishRun('failed');
    return retryOrStop(ctx, totals, `Committing the agent's work failed (a commit hook may have rejected it): ${clip((err as Error).message, 600)}`, errorFingerprint((err as Error).message), { backoff: false });
  }
  if (!files.length && !task.allow_no_changes) {
    await finishRun('failed');
    return retryOrStop(ctx, totals, `The agent said it was finished but no files changed. Its last message: "${clip(summary, 300)}"`, 'no_changes', { backoff: false });
  }
  return acceptArtifact(ctx, wt, baseSha!, files, summary, runId, log, phase, finishRun, cost, totals, value => { attemptReaped = value; });
    });
  } catch (error) {
    if (!(error instanceof UtilityProcessError)) throw error;
    if (task.native_handoff && error.result.reaped && attemptReaped && !ctx.stopReason?.()) {
      // A synchronous cancel/expiry can reject a utility intent before the control poll observes it.
      const current = await api['task.peek']({ id: task.id });
      if (current.generation !== task.generation || current.assignee !== task.assignee || current.status === 'canceled' || current.control || (current.lease_until !== null && current.lease_until <= Date.now())) {
        ctx.stopTask?.(current.status === 'canceled' ? 'canceled' : 'lost', 'Native handoff no longer owns the artifact verification.');
      }
    }
    if (ctx.stopReason?.() && error.result.reaped && attemptReaped) {
      // Expected cancellation is safe only after every child exit is durably acknowledged.
      await api['run.exit']({ runId, taskId: task.id, owner: claimOwner(task), reaped: true });
      throw error;
    }
    attemptReaped = false;
    await api['run.update']({ runId, patch: { status: 'cleanup_failed', stop_reason: 'Utility process ownership requires recovery.' } }).catch(() => undefined);
    return finishNeedsHuman(ctx, 'A Git or copy process could not finish its ownership checks. Work is preserved and held for recovery.');
  }
}

/** Artifact-only path: never constructs an implementation prompt or launches a coding adapter/JEV. */
async function runNativeArtifact(ctx: RunContext, runId: string, log: LogBuffer, phase: (name: string) => void, setAttemptReaped: (value: boolean) => void): Promise<RunOutcome> {
  const { task, api, config } = ctx;
  const data = parseHandoff(task.native_handoff)!;
  const branch = `yardmaster/native-${task.id}-${task.generation}`;
  const wt = worktreePathFor(config, ctx.project, `${task.id}-native-${task.generation}`);
  // Persist the owned destination before creating any files; recovery never targets the native source.
  await update(ctx, { worktree: wt, branch, base_sha: ctx.startPoint });
  try { await materializeNativeArtifact(ctx.repoPath, task, wt, branch); }
  catch (error) {
    if (error instanceof UtilityProcessError || /Task control pending:/.test((error as Error).message) || ctx.signal?.aborted) throw error;
    return finishNeedsHuman(ctx, `Native artifact could not be prepared: ${(error as Error).message}`, runId);
  }
  if (!(await isAncestor(wt, ctx.startPoint, data.sha!))) return finishNeedsHuman(ctx, 'Native commit must contain the current integration base. Take this task again by id, rebase/merge in the native client and resubmit.', runId);
  await warmStart(ctx.repoPath, wt, config, { candidates: siblingWorktrees(wt) });
  for (const command of config.worktree.setup) {
    await api['run.update']({ runId, patch: { phase: 'setup:spawning' } });
    setAttemptReaped(false);
    const result = await runShell(command, { cwd: wt, timeoutMs: config.verifyTimeoutMinutes * 60_000, signal: ctx.signal,
      onSpawn: async ({ pid, startedAt }) => { await api['run.update']({ runId, patch: { phase: 'setup', pid, proc_started: startedAt } }); } });
    setAttemptReaped(result.reaped);
    if (!result.reaped) { await api['run.update']({ runId, patch: { status: 'cleanup_failed' } }); return finishNeedsHuman(ctx, 'Native setup process requires recovery.'); }
    await api['run.update']({ runId, patch: { phase: 'prepare', pid: null, proc_started: null } });
    if (result.code !== 0) return finishNeedsHuman(ctx, `Native artifact setup failed: ${tail(result.stdout, 20, 1500)}`, runId);
  }
  if (await revParse(wt, 'HEAD') !== data.sha || !(await isClean(wt))) return finishNeedsHuman(ctx, 'Setup mutated the captured native artifact; preserve and inspect the verification checkout.', runId);
  const files = await changedFiles(wt, ctx.startPoint);
  if (!files.length && !task.allow_no_changes) return finishNeedsHuman(ctx, 'Native artifact contains no changes against integration.', runId);
  const overlap = await api['task.touched']({ taskId: task.id, runId, files });
  if (overlap) return finishNeedsHuman(ctx, `Native artifact overlaps active work in ${overlap.file}; source preserved.`, runId);
  const finishRun = async (status: string, reason?: string) => {
    await log.close();
    await api['run.update']({ runId, patch: { status, phase: 'collect', ended_at: Date.now(), stop_reason: reason ?? null } });
  };
  return acceptArtifact({ ...ctx, agent: data.agent }, wt, ctx.startPoint, files, task.summary ?? 'Native artifact submitted', runId,
    log, phase, finishRun, 0, {}, setAttemptReaped, data);
}

/** Shared immutable checks/review gate for managed implementation and native artifacts. */
async function acceptArtifact(ctx: RunContext, wt: string, baseSha: string, files: string[], summary: string, runId: string,
  log: LogBuffer, phase: (name: string) => void, finishRun: (status: string, reason?: string) => Promise<void>,
  cost: number, totals: TaskPatch, setAttemptReaped: (value: boolean) => void, native?: NativeHandoff): Promise<RunOutcome> {
  const { api, task, config } = ctx;
  const artifactFailure = (message: string, fingerprint: string, options: { backoff?: boolean }) => native
    ? finishNeedsHuman(ctx, message, runId) : retryOrStop(ctx, totals, message, fingerprint, options);
  const markers = await hasConflictMarkers(wt, files);
  if (markers.length) {
    await finishRun('failed');
    return artifactFailure(`Unresolved merge conflict markers remain in ${markers.join(', ')}.`, errorFingerprint(markers.join(',')), { backoff: false });
  }
  const hot = files.filter((f) => config.hotFiles.some((h) => matches(f, h)));
  const outside = task.scope.length ? files.filter((f) => !inScope(f, task.scope)) : [];
  if (outside.length) {
    const msg = `Changed files outside its declared scope: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? '…' : ''}`;
    if (config.scopeEnforcement === 'block') {
      await finishRun('failed');
      return artifactFailure(`${msg}. Only change ${task.scope.join(', ')}.`, errorFingerprint(outside.join(',')), { backoff: false });
    }
    await event(ctx, 'warn', 'task.scope', msg);
  }
  if (hot.length) await event(ctx, 'info', 'task.hotfiles', `Touches shared files (${hot.join(', ')}); it will be merged on its own.`);

  // ---- verify: "done" is measured, not claimed ----
  const reportOnly = task.allow_no_changes && files.length === 0;
  const commands = native ? verifyCommands(task, config) : taskChecks(task, config, files);
  if (!commands.length && !reportOnly) return finishNeedsHuman(ctx, `${native ? 'Native handoff' : 'Managed work'} requires configured verification commands. Work is preserved; add verify commands to yardmaster.json and retry.`, runId);
  const head = await revParse(wt, 'HEAD');
  await update(ctx, { status: 'verifying', head_sha: head, summary });
  if (commands.length) {
    await api['run.update']({ runId, patch: { phase: 'verify' } });
    log.push(`verify ${commands.join(' && ')}`);
    phase('collect');
    const result = await ctx.verifySlots.use(() => runVerify(wt, commands, config.verifyTimeoutMinutes, ctx.signal,
      async ({ pid, startedAt }) => { await api['run.update']({ runId, patch: { phase: 'verify', pid, proc_started: startedAt } }); }, {
        beforeSpawn: async () => {
          await api['run.update']({ runId, patch: { phase: 'verify:spawning' } });
          setAttemptReaped(false);
        },
        onExit: async (reaped) => {
          setAttemptReaped(reaped);
          if (reaped) await api['run.update']({ runId, patch: { phase: 'verify', pid: null, proc_started: null } });
        },
      }), ctx.signal);
    phase('verify');
    if (!result.ok) {
      if (!result.reaped) {
        setAttemptReaped(false);
        await api['run.update']({ runId, patch: { status: 'cleanup_failed' } });
        return finishNeedsHuman(ctx, result.output);
      }
      await finishRun('failed');
      log.push(`verify failed`);
      return artifactFailure(`Checks failed (\`${result.command}\`):\n${tail(result.output, 40, 2500)}`, errorFingerprint(result.output), { backoff: false });
    }
    log.push('verify passed');
    await api['run.update']({ runId, patch: { phase: 'collect', pid: null, proc_started: null } });
    if (head && (await isClean(wt))) await rememberChecked(wt, head, commands);
  } else {
    await event(ctx, 'info', 'task.report', 'Explicit report-only task changed no files. No code verification is claimed.');
  }
  // ---- second opinion: a different model family reviews what tests can't judge ----
  let reviewNote = '';
  const lines = await changedLineCount(wt, baseSha!);
  const why = shouldReview(task, config, files, lines);
  if (why) {
    log.push(`review requested: ${why}`);
    await event(ctx, 'info', 'task.review', `Getting a second opinion on "${task.title}" (${why})`);
    phase('collect');
    await api['run.update']({ runId, patch: { phase: 'review_wait' } });
    let reviewRun: string | null = null;
    let reviewReaped = true;
    let reviewAccounted = true;
    let reviewSequence = 0;
    let reviewFinalizing = false;
    let releaseReviewer: (() => void) | undefined;
    const reviewConfig = { ...config, review: { ...config.review } };
    const outcome = await runReview({ task, config: reviewConfig,
      implementer: ctx.agent, installed: ctx.installed ?? [ctx.agent], cwd: wt, base: baseSha!, signal: ctx.signal,
      hooks: {
        beforeLaunch: async ({ reviewer, model }) => {
          releaseReviewer = await ctx.reserveAgent?.(reviewer, ctx.signal);
          if (releaseReviewer) ctx.cleanup?.(releaseReviewer);
          reviewRun = await api['run.start']({ taskId: task.id, machineId: ctx.machineId, agent: reviewer, model, logPath: '', role: 'review', implementationExited: runId });
          const captured = reviewRun;
          ctx.cleanup?.(() => reviewReaped && reviewAccounted ? api['run.exit']({ runId: captured, taskId: task.id, owner: claimOwner(task), reaped: true }) : undefined);
          const held = await api['run.update']({ runId: reviewRun, patch: {}, launch: true });
          if (!held || held.amountUsd === null) throw new Error('Review requires a finite phase allowance.');
          reviewConfig.review.budgetUsd = held.amountUsd;
          await api['run.update']({ runId: reviewRun, patch: { phase: 'review', verdict_sha: head } });
        },
        beforeSpawn: async () => {
          if (!reviewRun) throw new Error('No admitted review run.');
          await api['run.update']({ runId: reviewRun, patch: { phase: 'review:spawning' } });
          reviewReaped = false;
          reviewAccounted = false;
        },
        onSpawn: async ({ pid, startedAt }) => { if (reviewRun) await api['run.update']({ runId: reviewRun, patch: { phase: 'review', pid, proc_started: startedAt } }); },
        onUsage: async (usage) => { if (reviewRun && !reviewFinalizing) await api['run.usage']({ runId: reviewRun, taskId: task.id, owner: claimOwner(task), sequence: ++reviewSequence, usage }); },
      },
    }).catch((err: Error) => ({ skipped: err.message, reason: 'failed' as const, reviewer: null, required: config.review.required,
      costUsd: 0, tokensIn: 0, tokensOut: 0, costEstimated: true, usage: emptyUsage(), model: null, startedAt: Date.now(), endedAt: Date.now(), status: 'not_started' as const, error: err.message, reaped: reviewReaped })).finally(() => releaseReviewer?.());
    reviewFinalizing = true;
    reviewReaped = outcome.reaped;
    phase('review');
    if (reviewRun) {
      await api['run.usage']({ runId: reviewRun, taskId: task.id, owner: claimOwner(task), sequence: ++reviewSequence, usage: outcome.usage });
      reviewAccounted = true;
      await api['run.update']({ runId: reviewRun, patch: { status: !outcome.reaped ? 'cleanup_failed' : 'skipped' in outcome ? outcome.status === 'not_started' ? 'skipped' : 'failed' : 'succeeded',
        ended_at: outcome.endedAt, stop_reason: 'skipped' in outcome ? outcome.skipped : null, verdict: 'review' in outcome ? JSON.stringify(outcome.review) : null,
        ...(outcome.reaped ? { phase: 'review', pid: null, proc_started: null } : {}) } }).catch((err) => { if (!isStale(err)) throw err; });
    }
    if (reviewRun && outcome.reaped) await api['run.exit']({ runId: reviewRun, taskId: task.id, owner: claimOwner(task), reaped: true });
    if (!outcome.reaped) return finishNeedsHuman(ctx, 'The reviewer process may still be alive; work is held for process recovery.', runId);
    if ((await revParse(wt, 'HEAD')) !== head || !(await isClean(wt))) return finishNeedsHuman(ctx, 'The reviewer changed the accepted artifact. Its verdict cannot approve this work; the changes are preserved.', runId);
    if ('skipped' in outcome) {
      log.push(`review skipped: ${outcome.skipped}`);
      await event(ctx, 'warn', 'task.review_skipped', `Review skipped: ${outcome.skipped}.`);
      if (native || outcome.required || config.review.onUnresolved === 'needs_human') return finishNeedsHuman(ctx, `${native || outcome.required ? 'Required' : 'Requested'} review did not complete: ${outcome.skipped}`, runId);
    } else {
      const issues = formatIssues(outcome.blocking);
      log.push(`review by ${outcome.reviewer}: ${outcome.review.verdict}${issues.length ? ` (${issues.length} issue${issues.length > 1 ? 's' : ''})` : ''}`);
      if (issues.length && native) return finishNeedsHuman(ctx, `Native artifact review requested changes: ${clip(issues.join(' '), 1500)}`, runId);
      if (issues.length && task.review_rounds < config.review.maxRounds) {
        await finishRun('succeeded');
        await event(ctx, 'warn', 'task.review_changes', `${outcome.reviewer} asked for changes to "${task.title}": ${clip(issues.join(' '), 200)}`);
        await update(ctx, {
          status: 'queued', attempts: Math.max(0, task.attempts - 1), review_rounds: task.review_rounds + 1, assignee: null, machine_id: null, lease_until: null, not_before: null,
          retry_note: `A reviewer (${outcome.reviewer}) asked for changes before merging. Address each point, keep the rest of your work:\n${issues.map((i) => `- ${i}`).join('\n')}`,
        });
        return { status: 'queued', message: 'review requested changes' };
      }
      if (issues.length) {
        if (config.review.required || config.review.onUnresolved === 'needs_human') {
          await finishRun('succeeded');
          return finishNeedsHuman(ctx, `Checks pass, but the reviewer (${outcome.reviewer}) still has concerns: ${clip(issues.join(' '), 600)}`);
        }
        reviewNote = ` Reviewer still noted: ${clip(issues.join(' '), 300)}`;
        await event(ctx, 'warn', 'task.review_unresolved', `"${task.title}" goes ahead with open review notes: ${clip(issues.join(' '), 200)}`);
      }
    }
  }

  if (native) {
    if (await revParse(ctx.repoPath, nativeArtifactRef(task.id, native.sessionGeneration)) !== native.sha) return finishNeedsHuman(ctx, 'The captured native ref changed; take this task again by id and resubmit.', runId);
    if (await revParse(wt, 'HEAD') !== native.sha || !(await isClean(wt))) return finishNeedsHuman(ctx, 'Native accepted artifact changed after checks/review.', runId);
  }
  await finishRun('succeeded');
  // Learn from this attempt: what fixed an earlier failure, which review points were addressed.
  // Every earlier review point counts as resolved now, except the latest one if it was waved through unresolved.
  const reviews = task.review_rounds > 0 || why ? (await api['task.get']({ id: task.id })).runs.filter((r) => r.role === 'review' && r.verdict) : [];
  const resolved = (reviewNote ? reviews.slice(0, -1) : reviews).flatMap((r) => {
    try {
      return formatIssues((JSON.parse(r.verdict!) as { issues: Parameters<typeof formatIssues>[0] }).issues.filter((i) => i.severity !== 'minor'));
    } catch {
      return [];
    }
  });
  await api['lesson.outcome']({ taskId: task.id, runId, summary: summary || 'completed', failureBefore: task.attempts > 1 ? task.last_error : null, reviewIssues: resolved.slice(0, 5) }).catch((err: Error) => { if (process.env.YARDMASTER_DEBUG) console.error('lesson.outcome', err.message); });
  const needsApproval = (config.integration.requireApproval || task.needs_approval) && !task.approved;
  await update(ctx, {
    status: reportOnly ? 'done' : 'ready', ready_at: reportOnly ? null : Date.now(), ...(reportOnly ? { finished_at: Date.now() } : {}), head_sha: head, summary: clip(summary + reviewNote, 1500), attention: !reportOnly && needsApproval ? 'Waiting for your approval to merge' : null,
    retry_note: null, lease_until: null,
    // A failure that only shows up at merge time is kept on record, so a repeat of it stops early.
    ...(task.error_fp?.startsWith('merge:') ? {} : { last_error: null, error_fp: null, same_error_count: 0 }),
  });
  await event(ctx, 'success', reportOnly ? 'task.done' : 'task.ready', reportOnly ? `Completed report "${task.title}" without file changes; no code integration requested.` : `"${task.title}" passed checks (${files.length} file${files.length === 1 ? '' : 's'} changed, ${formatUsd(task.cost_usd + cost)})${needsApproval ? '. Waiting for your approval to merge.' : ''}`);
  return { status: reportOnly ? 'done' : 'ready', message: summary };
}

export { runVerify };

function claimOwner(task: Task) {
  return { generation: task.generation, attempt: task.attempts, assignee: task.assignee ?? '' };
}

/** Every state change from a runner is fenced to this attempt (see Coordinator.updateTaskIfOwner). */
async function update(ctx: RunContext, patch: TaskPatch) {
  await ctx.api['task.update']({ id: ctx.task.id, patch, owner: claimOwner(ctx.task) });
}

async function event(ctx: RunContext, level: 'info' | 'warn' | 'error' | 'success', kind: string, message: string) {
  await ctx.api['task.event']({ projectId: ctx.task.project_id, taskId: ctx.task.id, level, kind, message, owner: claimOwner(ctx.task) }).catch(() => undefined);
}

async function finishNeedsHuman(ctx: RunContext, message: string, runId?: string, totals: TaskPatch = {}): Promise<RunOutcome> {
  if (ctx.signal?.aborted && ['stopped', 'canceled', 'lost', 'shutdown', 'redirected', 'preempted'].includes(ctx.stopReason?.() ?? '')) throw new Error('Task lifetime stopped.');
  if (runId) await ctx.api['run.update']({ runId, patch: { status: 'failed', ended_at: Date.now() } });
  await update(ctx, { status: 'needs_human', attention: message, last_error: message, lease_until: null });
  await event(ctx, 'error', 'task.needs_human', `"${ctx.task.title}" needs you: ${message}`);
  return { status: 'needs_human', message };
}

/** Commits what an interrupted agent left, so the next attempt starts from it. If that fails, say so plainly. */
async function savePartialWork(ctx: RunContext, wt: string): Promise<void> {
  const { task } = ctx;
  try {
    if (!ctx.runId) throw new Error('Partial-work preservation has no recorded attempt.');
    const runId = ctx.runId;
    const preservationId = randomUUID();
    await withProcessScope({ timeoutMs: 10_000,
      beforeSpawn: child => ctx.api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'intent', token: child.token, command: child.command, preserving: true, preservationId } }),
      onSpawn: (token, child) => ctx.api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'spawn', token, pid: child.pid, startedAt: child.startedAt } }),
      onExit: (token, result) => ctx.api['run.utility']({ runId, taskId: task.id, owner: claimOwner(task), operation: { action: 'exit', token, pid: result.pid, startedAt: result.startedAt, reaped: result.reaped } }),
    }, () => commitAll(wt, `yardmaster: partial work on ${task.title} (${task.id})`));
  } catch (err) {
    await event(ctx, 'warn', 'task.partial_uncommitted', `Couldn't commit the interrupted work on "${task.title}" (${clip((err as Error).message, 200)}). It stays uncommitted in ${wt}, and the next attempt starts from there.`);
  }
}

/**
 * Retry policy. Identical failures stop early (no burning budget on the same error), otherwise retry
 * with the failure as context and, if enabled, a stronger model.
 */
async function retryOrStop(ctx: RunContext, totals: TaskPatch, message: string, fingerprint: string, opts: { escalateNow?: boolean; backoff?: boolean } = {}): Promise<RunOutcome> {
  const { task, config } = ctx;
  const same = task.error_fp === fingerprint ? task.same_error_count + 1 : 1;
  const base: TaskPatch = { last_error: clip(message, 3000), error_fp: fingerprint, same_error_count: same, lease_until: null };
  if (same >= config.retry.sameFailureLimit) {
    // The same model failing the same way again rarely changes; a stronger one often does. Once per tier, with a
    // fresh session (the old one is anchored on its failed approach), then stop.
    const stronger = config.retry.escalate ? escalate(task.tier) : task.tier;
    if (stronger !== task.tier && task.attempts < task.max_attempts) {
      await event(ctx, 'warn', 'task.retry', `"${task.title}" failed the same way ${same} times; trying once more with a stronger model (${stronger}). ${clip(message, 200)}`);
      await update(ctx, { ...base, agent_session: null, status: 'queued', tier: stronger, not_before: null, assignee: null, machine_id: null, retry_note: clip(message, 2500) });
      return { status: 'queued', message };
    }
    return finishNeedsHuman(ctx, `It failed the same way ${same} times, so it was stopped to save budget. ${message}`, undefined, base);
  }
  if (task.attempts >= task.max_attempts) {
    await event(ctx, 'error', 'task.failed', `"${task.title}" failed after ${task.attempts} attempts: ${clip(message, 200)}`);
    await update(ctx, { ...base, status: 'failed', attention: `Gave up after ${task.attempts} attempts. ${clip(message, 600)}`, finished_at: Date.now() });
    return { status: 'failed', message };
  }
  // A stronger (pricier) model only after a second failure, or when the agent got stuck: a first failure is usually
  // fixed by the same model once it sees the error, and resuming its session makes that retry cheap.
  const tier = config.retry.escalate && (opts.escalateNow || task.attempts >= 2) ? escalate(task.tier) : task.tier;
  // Waiting only helps with flaky infrastructure; a failed check or a missing change won't fix itself by waiting.
  const wait = opts.backoff === false ? 0 : config.retry.backoffSeconds * 1000 * task.attempts;
  // A stuck agent starts over with a fresh session; anything else continues where it left off.
  const session: TaskPatch = opts.escalateNow ? { agent_session: null } : {};
  await event(ctx, 'warn', 'task.retry', `"${task.title}" attempt ${task.attempts} didn't work; retrying${tier !== task.tier ? ` with a stronger model (${tier})` : ''}. ${clip(message, 200)}`);
  await update(ctx, { ...base, ...session, status: 'queued', tier, not_before: wait ? Date.now() + wait : null, assignee: null, machine_id: null, retry_note: clip(message, 2500) });
  return { status: 'queued', message };
}
