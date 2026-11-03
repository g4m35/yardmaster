import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { getAdapter } from './adapters/index.ts';
import type { AgentEvent } from './adapters/types.ts';
import { agentSettings, priceFor, type Config, worktreeRootOf } from './config.ts';
import { paths } from './paths.ts';
import { addWorktree, branchExists, changedFiles, commitAll, conflictedFiles, git, hasConflictMarkers, isAncestor, isLinkedWorktreeOf, revParse } from './git.ts';
import { cleanEnv, killGroup, processStartTime, runShell } from './proc.ts';
import { escalate } from './router.ts';
import { inScope, matches } from './scope.ts';
import { clip, errorFingerprint, formatUsd, tail } from './text.ts';
import type { Project, Task } from './types.ts';
import { Watchdog, type Verdict } from './watchdog.ts';
import type { Client } from './api.ts';
import type { TaskPatch } from './coordinator.ts';

export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
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
  onSpawn?: (stop: (reason: StopReason, message: string) => void) => void;
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

function verifyCommands(task: Task, config: Config): string[] {
  return task.verify ?? config.verify;
}

function buildPrompt(ctx: RunContext, extra: { deps: { id: string; title: string; summary: string }[]; others: { id: string; title: string; scope: string[] }[]; messages: { from: string; body: string }[]; conflicts: string[] }): string {
  const { task, config } = ctx;
  const parts: string[] = [];
  parts.push(`You are working on one task in an isolated git worktree managed by Yardmaster (task ${task.id}). Other agents may be working on other tasks in parallel.`);
  parts.push(`## Task\n${task.title}\n\n${task.prompt !== task.title ? task.prompt : ''}`.trim());
  if (task.scope.length) {
    parts.push(`## Files you own\n${task.scope.join(', ')}\nKeep your changes inside these. If something outside them must change, keep it minimal and say why in your final message.`);
  }
  const others = extra.others.filter((o) => o.scope.length);
  if (others.length) {
    parts.push(`## Do not edit (other agents are changing these right now)\n${others.map((o) => `- ${o.scope.join(', ')} (${o.id} "${clip(o.title, 50)}")`).join('\n')}`);
  }
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
  const verify = verifyCommands(task, config);
  parts.push(
    [
      '## Rules',
      verify.length ? `- Before finishing, make sure these pass: ${verify.map((v) => `\`${v}\``).join(', ')}.` : '- Check your work runs before finishing.',
      '- Do not push, switch branches, or run destructive git commands (reset --hard, clean, checkout of other branches). Yardmaster commits your work for you.',
      '- Do not ask questions; nobody is watching this session. If information is missing, make a reasonable choice and note it.',
      '- End with a short summary (1-3 sentences) of what you changed.',
    ].join('\n'),
  );
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
  try {
    return await runAttemptInner(ctx);
  } catch (err) {
    if (isStale(err)) return { status: 'superseded', message: (err as Error).message };
    throw err;
  }
}

async function runAttemptInner(ctx: RunContext): Promise<RunOutcome> {
  const { api, task, config } = ctx;
  const adapter = getAdapter(ctx.agent, config);
  if (!adapter) return finishNeedsHuman(ctx, `No adapter for agent "${ctx.agent}".`);

  // Only ever reuse a worktree that is ours: under our root and linked to this repo.
  const defaultPath = worktreePathFor(config, ctx.project, task.id);
  const ourRoot = dirname(defaultPath);
  const reusable = (p: string | null) => !!p && existsSync(p) && underRoot(p, ourRoot) && isLinkedWorktreeOf(p, ctx.repoPath);
  const wt = reusable(task.worktree) ? task.worktree! : defaultPath;
  if (existsSync(wt) && !reusable(wt)) return finishNeedsHuman(ctx, `${wt} already exists and is not a Yardmaster worktree of this repo. Move it away, then retry.`);
  const branch = task.branch ?? `yardmaster/${task.id}`;
  let baseSha = task.base_sha;
  const conflicts: string[] = [];
  try {
    if (!existsSync(wt)) {
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
    return finishNeedsHuman(ctx, `Could not prepare a git worktree: ${(err as Error).message}`);
  }
  await update(ctx, { worktree: wt, branch, base_sha: baseSha, pending_rebase: false });

  const context = await api['task.context']({ id: task.id });
  const prompt = buildPrompt(ctx, { ...context, conflicts });
  const settings = agentSettings(config, ctx.agent);
  const spec = adapter.build({ prompt, cwd: wt, model: ctx.model, settings });

  const rawLog = join(paths.logs(), `${task.id}-${task.attempts}.jsonl`);
  const runId = await api['run.start']({ taskId: task.id, machineId: ctx.machineId, agent: ctx.agent, model: ctx.model, logPath: rawLog });
  const log = new LogBuffer(api, runId);
  log.push(`start ${adapter.label}${ctx.model ? ` (${ctx.model})` : ''} in ${wt}`);

  const raw: WriteStream = createWriteStream(rawLog, { flags: 'a' });
  const watchdog = new Watchdog(config.watchdog);
  const price = priceFor(config, ctx.agent, ctx.model);
  let estimate = 0;
  let actualCost: number | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let resultText = '';
  let resultOk: boolean | null = null;
  let lastText = '';
  let stderrTail = '';
  let stop: { reason: StopReason; message: string } | null = null;
  let lastActivity = '';
  const budget = task.budget_usd;
  const owner = { attempt: task.attempts, assignee: task.assignee ?? '' };

  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: wt,
      env: cleanEnv({ ...spec.env, YARDMASTER_TASK_ID: task.id, YARDMASTER_ATTEMPT: String(task.attempts), YARDMASTER_PROJECT_ID: task.project_id }),
      stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    await log.close();
    raw.end();
    return finishNeedsHuman(ctx, `${adapter.label} could not start: ${(err as Error).message}. ${adapter.setupHint ?? ''}`, runId);
  }
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);

  const procStarted = child.pid ? await processStartTime(child.pid) : null;
  await api['run.update']({ runId, patch: { pid: child.pid ?? null, proc_started: procStarted } });

  const requestStop = (reason: StopReason, message: string) => {
    if (stop) return;
    stop = { reason, message };
    log.push(`stop ${reason}: ${message}`);
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
  };
  ctx.onSpawn?.(requestStop);

  const spent = () => (actualCost ?? estimate);
  const onEvent = (ev: AgentEvent) => {
    if (ev.type === 'usage') {
      const fresh = (ev.tokensIn * price.inPerM + (ev.cachedIn ?? 0) * (price.cachedInPerM ?? price.inPerM) + ev.tokensOut * price.outPerM) / 1e6;
      if (ev.cumulative) {
        tokensIn = ev.tokensIn + (ev.cachedIn ?? 0);
        tokensOut = ev.tokensOut;
        if (ev.costUsd !== undefined) actualCost = ev.costUsd;
        else estimate = fresh;
      } else {
        tokensIn += ev.tokensIn + (ev.cachedIn ?? 0);
        tokensOut += ev.tokensOut;
        if (ev.costUsd !== undefined) actualCost = (actualCost ?? 0) + ev.costUsd;
        estimate += ev.costUsd ?? fresh;
      }
      if (budget !== null && task.cost_usd + spent() > budget) {
        requestStop('budget', `This task reached its budget of ${formatUsd(budget)} (spent ${formatUsd(task.cost_usd + spent())}).`);
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

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    raw.write(line + '\n');
    for (const ev of adapter.parse(line)) onEvent(ev);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    raw.write(JSON.stringify({ stderr: s }) + '\n');
    stderrTail = tail(stderrTail + s, 40);
  });

  const exit = new Promise<number>((done) => {
    child.on('close', (code) => done(code ?? 1));
    // A background process the agent started (dev server, watcher) can hold stdout open after the agent exits.
    child.on('exit', (code) => {
      setTimeout(() => {
        killGroup(child.pid, 'SIGTERM');
        done(code ?? 1);
      }, 3000).unref();
    });
    child.on('error', (err) => {
      stderrTail += `\n${String(err)}`;
      done(127);
    });
  });

  let lastTouchedCheck = 0;
  const tickMs = Math.min(2000, Math.max(200, config.liveOverlapIntervalSeconds * 500));
  const ticker = setInterval(async () => {
    const v = watchdog.tick();
    if (v) requestStop(v.kind, v.message);
    const patch: Record<string, unknown> = { cost_usd: spent(), tokens_in: tokensIn, tokens_out: tokensOut, last_activity: lastActivity, cost_estimated: actualCost === null };
    await api['run.update']({ runId, patch }).catch(() => undefined);
    try {
      const control = await api['task.peek']({ id: task.id });
      if (control.assignee !== owner.assignee || control.attempts !== owner.attempt) requestStop('lost', 'This attempt no longer owns the task (it was re-queued or claimed elsewhere).');
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
  }, tickMs);

  let code: number;
  try {
    code = await exit;
  } finally {
    clearInterval(ticker);
    rl.close();
    raw.end();
    // Whatever happens next, nothing the agent started may outlive the attempt.
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), 3000).unref();
  }
  const cost = spent();
  await api['run.update']({ runId, patch: { cost_usd: cost, tokens_in: tokensIn, tokens_out: tokensOut, exit_code: code, ended_at: Date.now(), last_activity: lastActivity, cost_estimated: actualCost === null } });
  // Spend is recorded even when the attempt turns out to be stale: the tokens were really used.
  await api['task.usage']({ id: task.id, costUsd: cost, tokensIn, tokensOut });
  const totals: TaskPatch = {};
  const summary = clip(resultText || lastText, 1200);

  const finishRun = async (status: string, reason?: string) => {
    await log.close();
    await api['run.update']({ runId, patch: { status, stop_reason: reason ?? null } });
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
        await commitAll(wt, `yardmaster: partial work on ${task.title} (${task.id})`).catch(() => false);
        await update(ctx, { status: 'queued', pending_rebase: true, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, retry_note: 'You were paused because another task was editing the same files. Its work is now merged into your branch.' });
        await event(ctx, 'warn', 'task.preempted', stopped.message);
        return { status: 'queued', message: stopped.message };
      case 'redirected':
        await commitAll(wt, `yardmaster: partial work on ${task.title} (${task.id})`).catch(() => false);
        await update(ctx, { status: 'queued', control: null, attempts: Math.max(0, task.attempts - 1), assignee: null, machine_id: null, lease_until: null, not_before: null });
        return { status: 'queued', message: stopped.message };
      case 'shutdown':
        await commitAll(wt, `yardmaster: partial work on ${task.title} (${task.id})`).catch(() => false);
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
  if (code !== 0 || resultOk === false) {
    await finishRun('failed');
    const kind = adapter.classifyFailure?.(`${failureText}\n${lastText}`) ?? null;
    if (kind === 'auth') return finishNeedsHuman(ctx, `${adapter.label} is not signed in on this machine. ${adapter.setupHint ?? ''}`, undefined, totals);
    if (kind === 'rate_limit') {
      const wait = config.retry.backoffSeconds * 1000 * Math.max(1, task.attempts) * 3;
      await update(ctx, { status: 'queued', attempts: Math.max(0, task.attempts - 1), not_before: Date.now() + wait, assignee: null, machine_id: null, lease_until: null });
      await event(ctx, 'warn', 'task.rate_limited', `${adapter.label} hit a usage limit. Trying again in ${Math.round(wait / 1000)}s.`);
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
    return retryOrStop(ctx, totals, `Committing the agent's work failed (a commit hook may have rejected it): ${clip((err as Error).message, 600)}`, errorFingerprint((err as Error).message));
  }
  if (!files.length && !task.allow_no_changes) {
    await finishRun('failed');
    return retryOrStop(ctx, totals, `The agent said it was finished but no files changed. Its last message: "${clip(summary, 300)}"`, 'no_changes');
  }
  const markers = await hasConflictMarkers(wt, files);
  if (markers.length) {
    await finishRun('failed');
    return retryOrStop(ctx, totals, `Unresolved merge conflict markers remain in ${markers.join(', ')}.`, errorFingerprint(markers.join(',')));
  }
  const hot = files.filter((f) => config.hotFiles.some((h) => matches(f, h)));
  const outside = task.scope.length ? files.filter((f) => !inScope(f, task.scope)) : [];
  if (outside.length) {
    const msg = `Changed files outside its declared scope: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? '…' : ''}`;
    if (config.scopeEnforcement === 'block') {
      await finishRun('failed');
      return retryOrStop(ctx, totals, `${msg}. Only change ${task.scope.join(', ')}.`, errorFingerprint(outside.join(',')));
    }
    await event(ctx, 'warn', 'task.scope', msg);
  }
  if (hot.length) await event(ctx, 'info', 'task.hotfiles', `Touches shared files (${hot.join(', ')}); it will be merged on its own.`);

  // ---- verify: "done" is measured, not claimed ----
  const commands = verifyCommands(task, config);
  const head = await revParse(wt, 'HEAD');
  await update(ctx, { status: 'verifying', head_sha: head, summary });
  if (commands.length) {
    log.push(`verify ${commands.join(' && ')}`);
    const result = await ctx.verifySlots.use(() => runVerify(wt, commands, config.verifyTimeoutMinutes));
    if (!result.ok) {
      await finishRun('failed');
      log.push(`verify failed`);
      return retryOrStop(ctx, totals, `Checks failed (\`${result.command}\`):\n${tail(result.output, 40, 2500)}`, errorFingerprint(result.output));
    }
    log.push('verify passed');
  } else {
    await event(ctx, 'warn', 'task.unverified', 'No checks are configured, so this work was not tested. Add "verify" commands to yardmaster.json.');
  }
  await finishRun('succeeded');
  const needsApproval = config.integration.requireApproval && !task.approved;
  await update(ctx, {
    status: 'ready', ready_at: Date.now(), head_sha: head, summary, attention: needsApproval ? 'Waiting for your approval to merge' : null,
    last_error: null, error_fp: null, same_error_count: 0, retry_note: null, lease_until: null,
  });
  await event(ctx, 'success', 'task.ready', `"${task.title}" passed checks (${files.length} file${files.length === 1 ? '' : 's'} changed, ${formatUsd(task.cost_usd + cost)})${needsApproval ? '. Waiting for your approval to merge.' : ''}`);
  return { status: 'ready', message: summary };
}

export async function runVerify(cwd: string, commands: string[], timeoutMinutes: number): Promise<{ ok: boolean; command: string; output: string }> {
  for (const command of commands) {
    const r = await runShell(command, { cwd, timeoutMs: timeoutMinutes * 60_000 });
    if (r.code !== 0) return { ok: false, command, output: r.timedOut ? `${r.stdout}\n(timed out after ${timeoutMinutes} minutes)` : r.stdout };
  }
  return { ok: true, command: commands.join(' && '), output: '' };
}

/** Every state change from a runner is fenced to this attempt (see Coordinator.updateTaskIfOwner). */
async function update(ctx: RunContext, patch: TaskPatch) {
  await ctx.api['task.update']({ id: ctx.task.id, patch, owner: { attempt: ctx.task.attempts, assignee: ctx.task.assignee ?? '' } });
}

async function event(ctx: RunContext, level: 'info' | 'warn' | 'error' | 'success', kind: string, message: string) {
  await ctx.api['task.event']({ projectId: ctx.task.project_id, taskId: ctx.task.id, level, kind, message });
}

async function finishNeedsHuman(ctx: RunContext, message: string, runId?: string, totals: TaskPatch = {}): Promise<RunOutcome> {
  if (runId) await ctx.api['run.update']({ runId, patch: { status: 'failed', ended_at: Date.now() } });
  await update(ctx, { status: 'needs_human', attention: message, last_error: message, lease_until: null });
  await event(ctx, 'error', 'task.needs_human', `"${ctx.task.title}" needs you: ${message}`);
  return { status: 'needs_human', message };
}

/**
 * Retry policy. Identical failures stop early (no burning budget on the same error), otherwise retry
 * with the failure as context and, if enabled, a stronger model.
 */
async function retryOrStop(ctx: RunContext, totals: TaskPatch, message: string, fingerprint: string, opts: { escalateNow?: boolean } = {}): Promise<RunOutcome> {
  const { task, config } = ctx;
  const same = task.error_fp === fingerprint ? task.same_error_count + 1 : 1;
  const base: TaskPatch = { last_error: clip(message, 3000), error_fp: fingerprint, same_error_count: same, lease_until: null };
  if (same >= config.retry.sameFailureLimit) {
    return finishNeedsHuman(ctx, `It failed the same way ${same} times, so it was stopped to save budget. ${message}`, undefined, base);
  }
  if (task.attempts >= task.max_attempts) {
    await update(ctx, { ...base, status: 'failed', attention: `Gave up after ${task.attempts} attempts. ${clip(message, 600)}`, finished_at: Date.now() });
    await event(ctx, 'error', 'task.failed', `"${task.title}" failed after ${task.attempts} attempts: ${clip(message, 200)}`);
    return { status: 'failed', message };
  }
  const tier = config.retry.escalate || opts.escalateNow ? escalate(task.tier) : task.tier;
  const wait = config.retry.backoffSeconds * 1000 * task.attempts;
  await update(ctx, { ...base, status: 'queued', tier, not_before: Date.now() + wait, assignee: null, machine_id: null, retry_note: clip(message, 2500) });
  await event(ctx, 'warn', 'task.retry', `"${task.title}" attempt ${task.attempts} didn't work; retrying${tier !== task.tier ? ` with a stronger model (${tier})` : ''}. ${clip(message, 200)}`);
  return { status: 'queued', message };
}
