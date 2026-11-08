import { submitSessionHandoff } from './handoff.ts';
import * as z from 'zod/v4';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLiveOverlap, type Coordinator, type TaskPatch } from './coordinator.ts';
import { NewTaskSchema, STATUS_LABEL, TASK_STATUSES, TERMINAL_STATUSES, type Task, type TaskStatus } from './types.ts';
import { paths } from './paths.ts';
import { clip, formatUsd, tail } from './text.ts';
import { revParse } from './git.ts';
import type { Config } from './config.ts';
import type { Supervisor } from './supervisor.ts';
import { diskReport } from './janitor.ts';
import { buildReport } from './report.ts';
import { addLesson, creditLessons, lessonFromFix, lessonsFor, listLessons, markUsed, renderLessons } from './lessons.ts';
import { coupling, filesIn } from './imports.ts';
import { PairingStore } from './pairing.ts';
import { buildRegistry } from './registry.ts';
import { tx } from './transaction.ts';
import { WORKER_ACTIVE_STATUSES, WORKER_FINALIZE_STATUSES } from './worker-policy.ts';
import { recordUtility, runUtilityKey, utilitiesStopped, utilities } from './utility-records.ts';

/**
 * The single API surface. The hub serves it over HTTP, the CLI and MCP server call it locally or
 * remotely, and remote workers use it to report progress. One implementation, so behavior cannot drift.
 */

export interface HubHooks {
  machineId: string;
  supervisor?: Supervisor;
  stopRunning?: (projectId?: string | null) => void;
  integrationHead?: (projectId: string) => Promise<string | null>;
  adoptIntegration?: (projectId: string, head: string, by: string, note: string) => Promise<void>;
  cleanPlan?: (projectId?: string) => Promise<unknown>;
  cleanRun?: (projectId?: string) => Promise<unknown>;
}

const Id = z.string().min(1);
/** Ids that end up in file paths must be plain. */
const TaskId = z.string().regex(/^t-[a-z0-9]+$/, 'not a task id');
const RunId = z.string().regex(/^r-[a-z0-9]+$/, 'not a run id');
// statuses: which states the owner may still update from (default running/verifying). A remote worker reporting a
// failed upload does so from "ready".
const Generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Owner = z.object({ generation: Generation.optional(), attempt: z.number().int().optional(), assignee: z.string(), statuses: z.array(z.enum(['running', 'verifying', 'ready'])).optional() });
const StatusList = z.array(z.enum(TASK_STATUSES)).optional();

function method<S extends z.ZodType, R>(schema: S, fn: (p: z.infer<S>) => R | Promise<R>) {
  return { schema, fn };
}

export function activityLogPath(runId: string): string {
  if (!/^r-[a-z0-9]+$/.test(runId)) throw new Error('bad run id');
  return join(paths.logs(), `${runId}.log`);
}

function attentionItems(coord: Coordinator, tasks: Task[]) {
  return tasks
    .filter((t) => t.status === 'needs_human' || t.status === 'failed' || (t.status === 'ready' && t.attention))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, why: t.attention ?? t.last_error ?? 'Needs a decision' }));
}

export function boardSummary(coord: Coordinator, projectId?: string | null, supervisor?: Supervisor) {
  return coord.pass(() => boardSummaryInPass(coord, projectId, supervisor));
}

function boardSummaryInPass(coord: Coordinator, projectId?: string | null, supervisor?: Supervisor) {
  // Open work, plus the latest failures for "needs you": the board costs the same with any amount of history.
  const tasks = [...coord.openTasks(projectId ?? null), ...coord.recentlyFinished(projectId, 'failed', 20)];
  const totals = coord.taskTotals(projectId ?? null);
  const counts = totals.counts;
  const now = Date.now();
  const active = tasks
    .filter((t) => !TERMINAL_STATUSES.includes(t.status) && t.status !== 'needs_human')
    .map((t) => {
      const run = coord.latestRun(t.id);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        label: STATUS_LABEL[t.status],
        agent: run?.agent ?? t.agent,
        model: run?.model ?? t.model,
        machine: t.machine_id,
        assignee: t.assignee,
        cost: t.cost_usd,
        lastActivity: t.status === 'running' ? run?.last_activity ?? null : null,
        waiting: t.status === 'queued' ? coord.blocker(t, now) : null,
        scope: t.scope,
      };
    });
  return {
    projects: coord.listProjects().map((p) => ({ id: p.id, name: p.name, base: p.base_branch })),
    counts,
    active,
    attention: attentionItems(coord, tasks),
    recentDone: coord.recentlyFinished(projectId, 'done', 8).map((t) => ({ id: t.id, title: t.title, summary: clip(t.summary, 160), cost: t.cost_usd, finishedAt: t.finished_at })),
    spentToday: coord.spentToday(),
    dailyBudget: (() => {
      const pid = projectId ?? coord.listProjects()[0]?.id;
      return pid ? coord.configFor(pid).budget.dailyUsd : null;
    })(),
    totalSpent: totals.spent,
    machines: coord.listMachines().map((m) => ({ id: m.id, name: m.name, online: now - m.last_seen < 60_000, isHub: m.is_hub, agents: m.info.agents, running: m.info.running, maxParallel: m.info.maxParallel, diskFreeGb: m.info.diskFreeGb ?? null, worktreesGb: m.info.worktreesGb ?? null, loadPerCpu: m.info.loadPerCpu, freeMemMb: m.info.freeMemMb })),
    paused: coord.pausedState(projectId),
    warnings: (supervisor?.current(projectId) ?? []).map((w) => ({ taskId: w.taskId, message: w.message, since: w.since })),
    budgetRunsOutAt: supervisor?.projectedBudgetOut() ?? null,
    sessions: coord.listSessions(projectId ?? undefined).filter((s) => now - s.last_seen < 30 * 60_000).map((s) => ({ id: s.id, agent: s.agent, cwd: s.cwd })),
  };
}

/** Compact text form for agents: a few hundred tokens instead of a JSON dump. */
export function boardText(coord: Coordinator, projectId?: string | null, supervisor?: Supervisor): string {
  const b = boardSummary(coord, projectId, supervisor);
  const lines: string[] = [];
  const counts = Object.entries(b.counts).map(([k, v]) => `${STATUS_LABEL[k as TaskStatus] ?? k}: ${v}`).join(', ');
  lines.push(`Tasks: ${counts || 'none'}. Spent today: ${formatUsd(b.spentToday)}.${b.paused.paused ? ` PAUSED by ${b.paused.by}: no new work starts.` : ''}`);
  for (const w of b.warnings) lines.push(`~ ${clip(w.message, 200)}`);
  for (const a of b.attention) lines.push(`! ${a.id} ${clip(a.title, 60)}: ${clip(a.why, 160)}`);
  for (const t of b.active) {
    const who = t.assignee?.startsWith('session:') ? t.assignee.slice(8) : t.agent ?? '';
    const detail = t.waiting ?? t.lastActivity ?? '';
    lines.push(`- ${t.id} [${t.label}] ${clip(t.title, 60)}${who ? ` (${who})` : ''}${detail ? ` - ${clip(detail, 90)}` : ''}`);
  }
  return lines.join('\n');
}

export function buildMethods(coord: Coordinator, hooks: HubHooks) {
  const pairing = new PairingStore(coord.db, { ownerId: 'personal' });
  const owner = { kind: 'owner' as const, ownerId: 'personal' };
  const resolveProject = async (cwd?: string, projectId?: string) => {
    if (projectId) {
      const p = coord.getProject(projectId);
      if (!p) throw new Error(`Unknown project ${projectId}. Run "ym init" in that repository.`);
      return p;
    }
    if (!cwd) throw new Error('Pass a project id or a working directory.');
    return (await coord.projectForPath(cwd)) ?? (await coord.registerProject(cwd));
  };

  return {
    'run.utility': method(z.object({ runId: RunId, taskId: TaskId, owner: Owner,
      operation: z.discriminatedUnion('action', [
        z.object({ action: z.literal('intent'), token: Id, command: z.string().min(1).max(2000), preserving: z.boolean().optional(), preservationId: Id.optional() }),
        z.object({ action: z.literal('spawn'), token: Id, pid: z.number().int().positive(), startedAt: z.number().nullable() }),
        z.object({ action: z.literal('exit'), token: Id, pid: z.number().int().positive().nullable(), startedAt: z.number().nullable(), reaped: z.boolean() }),
      ]) }), p => tx(coord.db, () => {
      const run = coord.getRun(p.runId);
      if (!run || run.task_id !== p.taskId || run.generation !== p.owner.generation || p.owner.assignee !== `machine:${run.machine_id}`) throw new Error('Utility does not belong to this recorded run.');
      if (p.operation.action === 'exit' && !['running', 'lost', 'cleanup_failed'].includes(run.status) &&
          !coord.db.prepare("SELECT 1 FROM budget_reservations WHERE run_id = ? AND state = 'held'").get(run.id) && coord.getMeta(runUtilityKey(run.id)) === null) return;
      if (p.operation.action === 'intent') {
        const current = coord.getTask(p.taskId);
        if (current?.generation === p.owner.generation && current.assignee === p.owner.assignee && current.status === 'canceled') throw new Error('Task control pending: cancel');
        const task = coord.assertTaskOwner(p.taskId, { ...p.owner, statuses: WORKER_ACTIVE_STATUSES });
        const preservationId = p.operation.preservationId;
        const preserving = p.operation.preserving && !!preservationId && run.status === 'stopped' && run.pid === null &&
          utilities(coord.db, runUtilityKey(run.id)).every(child => child.state === 'exited' || child.preservationId === preservationId);
        if (task.control && !preserving) throw new Error(`Task control pending: ${task.control}`);
        if (run.status === 'cleanup_failed') throw new Error('Run cannot launch another utility while process cleanup is unconfirmed.');
      }
      recordUtility(coord.db, runUtilityKey(p.runId), p.operation);
    })),
    'run.usage': method(z.object({ runId: RunId, taskId: TaskId, owner: Owner, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      usage: z.object({ costUsd: z.number().finite().nonnegative(), tokensIn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tokensOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        provenance: z.enum(['actual', 'estimated', 'mixed', 'unknown']), cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative().nullable() }) }),
      (p) => coord.recordRunUsage(p.runId, p.taskId, p.owner, p.sequence, p.usage)),
    'run.exit': method(z.object({ runId: RunId, taskId: TaskId, owner: Owner, reaped: z.literal(true), process: z.object({ pid: z.number().int().positive(), startedAt: z.number().finite().positive() }).optional(), noLaunchPhase: z.string().min(1).optional() }), (p) => {
      coord.confirmRunExit(p.runId, p.taskId, p.owner, p.process, p.noLaunchPhase);
    }),
    'fleet.identity': method(z.object({}), () => ({ kind: 'owner' } as { kind: 'owner' | 'worker'; machineId?: string; projectId?: string; expiresAt?: number })),
    'integration.confirmStopped': method(z.object({ projectId: Id, by: z.string().default('you'), note: z.string().min(12).max(4000) }),
      (p) => coord.confirmIntegrationStopped(p.projectId, p.by, p.note)),
    'integration.adopt': method(z.object({ projectId: Id, head: z.string().regex(/^[a-f0-9]{40,64}$/), by: z.string().default('you'), note: z.string().min(12).max(4000) }), p => {
      if (!hooks.adoptIntegration) throw new Error('Start the hub before adopting interrupted integration work.');
      return hooks.adoptIntegration(p.projectId, p.head, p.by, p.note);
    }),
    'registry.list': method(z.object({ projectId: Id.optional(), historyLimit: z.number().int().min(0).max(500).default(100) }), (p) => buildRegistry(coord.db, p)),
    'fleet.invite': method(z.object({ projectId: Id, ttlMs: z.number().int().optional(), credentialTtlMs: z.number().int().optional() }), (p) => pairing.createInvitation(owner, p)),
    'fleet.devices': method(z.object({}), () => ({ credentials: pairing.listCredentials(owner), invitations: pairing.listInvitations(owner) })),
    'fleet.revoke': method(z.object({ id: Id, invitation: z.boolean().default(false) }), (p) => p.invitation ? pairing.revokeInvitation(owner, p.id) : pairing.revokeCredential(owner, p.id)),
    'project.register': method(z.object({ cwd: z.string() }), (p) => coord.registerProject(p.cwd)),
    'project.resolve': method(z.object({ cwd: z.string().optional(), projectId: z.string().optional() }), (p) => resolveProject(p.cwd, p.projectId)),
    'project.list': method(z.object({}), () => coord.listProjects()),

    'task.add': method(
      z.object({ projectId: Id, tasks: z.array(NewTaskSchema).min(1).max(50), createdBy: z.string().default('cli'), force: z.boolean().optional() }),
      (p) => coord.addTasks(p.projectId, p.tasks, p.createdBy, { force: p.force }),
    ),
    'task.list': method(z.object({ projectId: z.string().nullish(), statuses: StatusList }), (p) => coord.listTasks(p.projectId ?? null, p.statuses)),
    'task.get': method(z.object({ id: Id }), (p) => {
      const task = coord.getTask(p.id);
      if (!task) throw new Error(`No task ${p.id}`);
      return {
        task,
        label: STATUS_LABEL[task.status],
        waiting: task.status === 'queued' ? coord.blocker(task) : null,
        deps: coord.depsOf(task.id).map((d) => ({ id: d.id, title: d.title, status: d.status })),
        dependents: coord.dependentsOf(task.id).map((d) => ({ id: d.id, title: d.title, status: d.status })),
        runs: coord.runsFor(task.id),
        events: coord.eventsSince(0, null, 40, task.id),
      };
    }),
    'task.peek': method(z.object({ id: Id }), (p) => {
      const t = coord.getTask(p.id);
      return { status: t?.status ?? 'missing', control: t?.control ?? null, assignee: t?.assignee ?? null, attempts: t?.attempts ?? 0, generation: t?.generation ?? 0, head_sha: t?.head_sha ?? null, branch: t?.branch ?? null, lease_until: t?.lease_until ?? null };
    }),
    'task.control': method(z.object({ id: Id, action: z.enum(['retry', 'cancel', 'stop', 'approve', 'prioritize', 'redirect', 'confirm-stopped']), by: z.string().default('you'), note: z.string().max(4000).optional(), remote: z.boolean().optional() }), (p) => coord.control(p.id, p.action, p.by, p.note, { remote: p.remote })),
    'task.logs': method(z.object({ id: Id, lines: z.number().int().min(1).max(2000).default(80) }), (p) => {
      const run = coord.latestRun(p.id);
      if (!run) return '';
      const file = activityLogPath(run.id);
      return existsSync(file) ? tail(readFileSync(file, 'utf8'), p.lines, 200_000) : '';
    }),
    'task.update': method(z.object({ id: TaskId, patch: z.record(z.string(), z.unknown()), owner: Owner.optional() }), (p) =>
      coord.updateTaskIfOwner(p.id, p.owner ?? { assignee: '' }, p.patch as TaskPatch),
    ),
    // Explicit administrative writes never masquerade as a worker claim.
    'task.adminUpdate': method(z.object({ id: TaskId, patch: z.record(z.string(), z.unknown()) }), (p) => coord.updateTask(p.id, p.patch as TaskPatch)),
    'task.context': method(z.object({ id: Id }), (p) => {
      const task = coord.getTask(p.id);
      if (!task) throw new Error(`No task ${p.id}`);
      const cfg = coord.configFor(task.project_id);
      // A raced dependency is represented by whichever member won.
      const winner = (d: Task) => (d.race_group ? coord.raceMembers(d.race_group).find((x) => x.status === 'done') ?? d : d);
      const others = coord.activeScopes(task.project_id, task.id).map(({ task: o, scope }) => ({ id: o.id, title: o.title, scope }));
      const graph = cfg.coupling !== 'off' ? coord.graphs.get(task.project_id) : undefined;
      const coupled = graph && task.scope.length
        ? others.flatMap((o) => coupling(graph, task.scope, o.scope).slice(0, 2).map((c) => `${c.mine} ${c.direction === 'imports' ? 'imports' : 'is imported by'} ${c.theirs}, which ${o.id} "${clip(o.title, 40)}" is changing`))
        : [];
      const lessons = cfg.learning.lessons ? lessonsFor(coord, task, cfg.learning.maxLessonsPerBrief) : [];
      // A small map of how the owned files connect to the rest of the code, so the agent spends fewer steps exploring.
      const fullGraph = coord.graphs.get(task.project_id);
      const map = fullGraph && task.scope.length
        ? filesIn(fullGraph, task.scope).slice(0, 8).map((f) => {
            const uses = [...(fullGraph.deps.get(f) ?? [])].slice(0, 5);
            const usedBy = [...(fullGraph.rdeps.get(f) ?? [])].slice(0, 5);
            return `${f}${uses.length ? ` imports ${uses.join(', ')}` : ''}${usedBy.length ? `${uses.length ? ';' : ''} used by ${usedBy.join(', ')}` : ''}`;
          }).filter((l) => l.includes(' '))
        : [];
      return {
        deps: coord.depsOf(task.id).map(winner).filter((d) => d.status === 'done').map((d) => ({ id: d.id, title: d.title, summary: clip(d.summary, 500) })),
        others,
        messages: coord.inbox(task.project_id, task.id),
        guidance: task.guidance,
        coupling: coupled.slice(0, 6),
        lessons: lessons.length ? renderLessons(lessons) : '',
        lessonIds: lessons.map((l) => l.id),
        map,
      };
    }),
    'task.usage': method(z.object({ id: TaskId, costUsd: z.number().min(0), tokensIn: z.number().int().min(0), tokensOut: z.number().int().min(0), owner: Owner.optional(), runId: RunId.optional() }), (p) => {
      return coord.withRunOwner(p.runId ?? '', p.owner && { ...p.owner, statuses: WORKER_FINALIZE_STATUSES },
        () => { throw new Error('Unsequenced task usage is no longer accepted. Upgrade the worker to run.usage absolute snapshots.'); }, p.id);
    }),
    'task.touched': method(z.object({ taskId: TaskId, runId: RunId, files: z.array(z.string()).max(2000), owner: Owner.optional() }), (p) => checkLiveOverlap(coord, p.taskId, p.runId, p.files, p.owner)),
    'task.event': method(
      z.object({ projectId: z.string().nullable(), taskId: z.string().nullable(), level: z.enum(['info', 'warn', 'error', 'success']), kind: z.string(), message: z.string(), data: z.unknown().optional(), owner: Owner.optional() }),
      (p) => tx(coord.db, () => {
        if (p.taskId) {
          const task = coord.assertTaskOwner(p.taskId, p.owner && { ...p.owner, statuses: WORKER_FINALIZE_STATUSES });
          if (task.project_id !== p.projectId) throw new Error('Event project does not match its task.');
        }
        return coord.event(p.projectId, p.taskId, p.level, p.kind, p.message, p.data);
      }),
    ),
    'task.wait': method(z.object({ ids: z.array(Id).min(1).max(50), timeoutSec: z.number().min(0).max(600).default(60) }), async (p) => {
      const settled = (t: Task | null) => !t || TERMINAL_STATUSES.includes(t.status) || t.status === 'needs_human' || (t.status === 'ready' && !!t.attention);
      const deadline = Date.now() + p.timeoutSec * 1000;
      for (;;) {
        const tasks = p.ids.map((id) => coord.getTask(id));
        if (tasks.every(settled) || Date.now() >= deadline) {
          return tasks.map((t, i) => (t ? { id: t.id, title: t.title, status: t.status, label: STATUS_LABEL[t.status], summary: clip(t.summary, 400), attention: t.attention, waiting: t.status === 'queued' ? coord.blocker(t) : null } : { id: p.ids[i], status: 'missing' }));
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }),

    // One round trip per hook (hooks run on every prompt and edit, so they must be cheap).
    'hook.check': method(z.object({ projectId: Id, paths: z.array(z.string()).min(1).max(50), cwd: z.string(), sessionId: Id }), (p) => {
      const holders = coord.whoHas(p.projectId, p.paths);
      if (!holders.length) return null;
      const mine = new Set(coord.listSessions(p.projectId).filter((x) => x.cwd === p.cwd).map((x) => x.id));
      mine.add(p.sessionId);
      return holders.find((h) => !mine.has(h.holder)) ?? null;
    }),
    'hook.reserve': method(z.object({ projectId: Id, sessionName: Id, cwd: z.string(), paths: z.array(z.string()).min(1).max(50), machineId: z.string().nullish() }), (p) => {
      const sessionId = coord.registerSession(p.sessionName, 'hooked-agent', p.projectId, p.cwd, p.machineId ?? null);
      return coord.claimLocks(p.projectId, sessionId, p.paths, 'edited in an interactive session', 20);
    }),
    'board.status': method(z.object({ projectId: z.string().nullish() }), (p) => boardSummary(coord, p.projectId, hooks.supervisor)),
    'board.text': method(z.object({ projectId: z.string().nullish() }), (p) => boardText(coord, p.projectId, hooks.supervisor)),
    'fleet.pause': method(z.object({ projectId: z.string().nullish(), stopRunning: z.boolean().default(false), by: z.string().default('you') }), (p) => {
      coord.setPaused(p.projectId ?? null, true, p.by);
      if (p.stopRunning) {
        // Running agents save their partial work and go back to the queue; they continue on resume.
        for (const t of coord.listTasks(p.projectId ?? null, ['running', 'verifying'])) if (!t.assignee?.startsWith('session:')) coord.updateTask(t.id, { control: 'stop-pause' });
        hooks.stopRunning?.(p.projectId);
      }
      return coord.pausedState(p.projectId);
    }),
    'fleet.resume': method(z.object({ projectId: z.string().nullish(), by: z.string().default('you') }), (p) => {
      coord.setPaused(p.projectId ?? null, false, p.by);
      if (p.projectId) coord.setPaused(null, false, p.by);
      return coord.pausedState(p.projectId);
    }),
    'disk.report': method(z.object({ projectId: z.string().nullish() }), (p) => diskReport(coord, p.projectId ?? null)),
    'events.since': method(z.object({ after: z.number().int().default(0), projectId: z.string().nullish(), taskId: z.string().nullish(), limit: z.number().int().max(1000).default(200) }), (p) =>
      coord.eventsSince(p.after, p.projectId, p.limit, p.taskId),
    ),

    'lock.claim': method(
      z.object({ projectId: Id, holder: Id, patterns: z.array(z.string()).min(1).max(100), reason: z.string().nullish(), ttlMinutes: z.number().min(1).max(24 * 60).default(30) }),
      (p) => coord.claimLocks(p.projectId, p.holder, p.patterns, p.reason ?? null, p.ttlMinutes),
    ),
    'lock.release': method(z.object({ projectId: Id, holder: Id, patterns: z.array(z.string()).optional() }), (p) => coord.releaseLocks(p.projectId, p.holder, p.patterns)),
    'lock.check': method(z.object({ projectId: Id, paths: z.array(z.string()).min(1).max(200) }), (p) => coord.whoHas(p.projectId, p.paths)),

    'session.register': method(z.object({ name: Id, agent: z.string().nullish(), projectId: z.string().nullish(), cwd: z.string().nullish(), machineId: z.string().nullish() }), (p) =>
      coord.registerSession(p.name, p.agent ?? null, p.projectId ?? null, p.cwd ?? null, p.machineId ?? null),
    ),
    'session.heartbeat': method(z.object({ sessionId: Id, claims: z.array(z.object({ taskId: TaskId, generation: Generation })).max(50) }), (p) =>
      p.claims.map((claim) => ({ taskId: claim.taskId, renewed: coord.renewSessionLease(claim.taskId, p.sessionId, claim.generation) })),
    ),
    'session.claim': method(z.object({ sessionId: Id, projectId: Id, taskId: z.string().optional() }), (p) => coord.claimForSession(p.sessionId, p.projectId, p.taskId)),
    'session.finish': method(z.object({ sessionId: Id, taskId: Id, summary: z.string(), outcome: z.enum(['done', 'failed']).default('done'), branch: z.string().optional(), generation: Generation.optional() }), (p) =>
      p.branch ? submitSessionHandoff(coord, hooks.machineId, { ...p, branch: p.branch }) : coord.finishForSession(p.sessionId, p.taskId, p.summary, p.outcome, undefined, p.generation),
    ),

    'msg.send': method(z.object({ projectId: Id, from: Id, to: Id, body: z.string().min(1).max(4000), taskId: z.string().nullish() }), (p) => coord.sendMessage(p.projectId, p.from, p.to, p.body, p.taskId)),
    'msg.inbox': method(z.object({ projectId: Id, reader: Id, aliases: z.array(z.string()).default([]) }), (p) => coord.inbox(p.projectId, p.reader, p.aliases)),

    'machine.heartbeat': method(
      z.object({ id: Id, name: z.string(), info: z.record(z.string(), z.unknown()), running: z.array(z.object({ taskId: Id, generation: Generation.optional(), runId: z.string().nullish() })).default([]) }),
      (p) => {
        if (p.running.some((r) => !r.generation)) throw new Error('Heartbeat requires a valid claim generation. Upgrade the worker and reclaim the task.');
        coord.heartbeatMachine(p.id, p.name, p.info as never, false);
        return {
          controls: p.running.map((r) => {
            const renewed = coord.renewLease(r.taskId, p.id, r.generation);
            const t = coord.getTask(r.taskId);
            return { taskId: r.taskId, status: t?.status ?? 'missing', control: t?.control ?? null, assignee: t?.assignee ?? null, generation: t?.generation ?? 0, renewed };
          }),
        };
      },
    ),
    'machine.list': method(z.object({}), () => coord.listMachines()),

    'worker.claim': method(
      z.object({ machineId: Id, agents: z.array(z.string()), repos: z.record(z.string(), z.string()), runningByAgent: z.record(z.string(), z.number()).default({}), activeTaskIds: z.array(TaskId).max(100).default([]) }),
      async (p) => {
        const claim = coord.claimNext(p);
        if (!claim) return null;
        try {
          const startPoint = (await hooks.integrationHead?.(claim.project.id)) ?? (await revParse(claim.project.root, claim.project.base_branch));
          if (!startPoint) throw new Error(`could not find a starting commit for ${claim.project.name}`);
          coord.assertTaskOwner(claim.task.id, { generation: claim.task.generation, assignee: claim.task.assignee! });
          const config: Config = coord.configFor(claim.project.id);
          return { ...claim, config, startPoint };
        } catch (err) {
          coord.abandonUnlaunchedClaim(claim.task.id, claim.task.generation, p.machineId);
          // Give the claim back rather than leaving the task "running" with nobody on it.
          try {
            coord.updateTaskIfOwner(claim.task.id, { generation: claim.task.generation, assignee: claim.task.assignee! }, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: Math.max(0, claim.task.attempts - 1) });
          } catch { /* A canceled/reclaimed task belongs to its newer state. */ }
          throw err;
        }
      },
    ),
    'run.start': method(z.object({ taskId: TaskId, machineId: Id, agent: Id, model: z.string().nullish(), logPath: z.string(), role: z.enum(['implement', 'review']).default('implement'), lessons: z.array(z.string()).max(20).default([]), owner: Owner.optional(), implementationExited: RunId.optional() }), (p) => {
      const task = coord.getTask(p.taskId);
      if (!task) throw new Error(`No task ${p.taskId}`);
      coord.assertTaskOwner(p.taskId, p.owner);
      if (p.owner!.assignee !== `machine:${p.machineId}`) throw new Error('Run machine does not match the claim owner.');
      const run = coord.startRun({ ...task, generation: p.owner!.generation! }, p.machineId, p.agent, p.model ?? null, p.logPath, p.role, p.implementationExited);
      if (p.lessons.length) {
        coord.updateRun(run.id, { lessons: p.lessons });
        markUsed(coord, p.lessons);
      }
      return run.id;
    }),
    'lesson.add': method(z.object({ projectId: Id, text: z.string().min(12).max(1000), files: z.array(z.string()).default([]), source: z.enum(['you', 'agent', 'review', 'fix']).default('agent'), taskId: z.string().nullish() }), (p) =>
      addLesson(coord, p.projectId, p.text, p.source, p.files, p.taskId ?? null),
    ),
    'lesson.list': method(z.object({ projectId: Id, all: z.boolean().default(false) }), (p) => listLessons(coord, p.projectId, p.all)),
    'lesson.forget': method(z.object({ id: Id }), (p) => coord.db.prepare('UPDATE lessons SET disabled = 1 WHERE id = ?').run(p.id).changes),
    /** Called by a runner when an attempt ends well: learn from what it fixed, and credit the lessons it was given. */
    'lesson.outcome': method(z.object({ taskId: TaskId, runId: RunId, summary: z.string().max(4000), failureBefore: z.string().max(4000).nullish(), reviewIssues: z.array(z.string()).max(20).default([]), owner: Owner.optional() }), (p) => {
      coord.assertRunOwner(p.runId, p.owner, p.taskId);
      const task = coord.getTask(p.taskId);
      if (!task) return null;
      const cfg = coord.configFor(task.project_id);
      const run = coord.getRun(p.runId);
      creditLessons(coord, run?.lessons ?? [], task.attempts <= 1 && task.review_rounds === 0);
      if (!cfg.learning.lessons) return null;
      if (p.failureBefore) {
        const text = lessonFromFix(task, p.failureBefore, p.summary);
        if (text) addLesson(coord, task.project_id, text, 'fix', task.scope, task.id);
      }
      for (const issue of p.reviewIssues) addLesson(coord, task.project_id, `A reviewer flagged, and the fix was accepted: ${issue}`, 'review', task.scope, task.id);
      return null;
    }),
    'run.update': method(z.object({ runId: RunId, patch: z.record(z.string(), z.unknown()), owner: Owner.optional(), launch: z.boolean().optional() }), (p) => {
      if (p.launch) {
        if (Object.keys(p.patch).length) throw new Error('Launch authorization cannot update a run.');
        return coord.launchBudget(p.runId, p.owner);
      }
      return coord.withRunOwner(p.runId, p.owner && { ...p.owner, statuses: WORKER_FINALIZE_STATUSES },
        () => {
          if (['cost_usd', 'tokens_in', 'tokens_out', 'cost_estimated'].some(k => k in p.patch)) throw new Error('Usage must be recorded through sequenced run.usage.');
          return coord.updateRun(p.runId, p.patch as never);
        });
    }),
    'run.log': method(z.object({ runId: RunId, lines: z.array(z.string()).max(500), owner: Owner.optional() }), (p) => {
      return coord.withRunOwner(p.runId, p.owner && { ...p.owner, statuses: WORKER_FINALIZE_STATUSES }, () => {
        if (p.lines.length) appendFileSync(activityLogPath(p.runId), p.lines.join('\n') + '\n');
      });
    }),

    // Owner-only: scoped worker RPC authorization denies all plan.* methods.
    'plan.confirmStopped': method(z.object({ runId: RunId, by: z.string().default('you'), note: z.string().min(12).max(4000) }),
      (p) => coord.confirmPlanStopped(p.runId, p.by, p.note)),
    'plan.start': method(z.object({ projectId: Id, machineId: Id, agent: Id, model: z.string().nullable(), owner: z.object({ pid: z.number().int().positive(), startedAt: z.number().finite().positive() }).optional() }),
      (p) => coord.startPlan(p.projectId, p.machineId, p.agent, p.model, p.owner)),
    'plan.heartbeat': method(z.object({ runId: RunId, owner: z.object({ pid: z.number().int().positive(), startedAt: z.number().finite().positive() }) }),
      (p) => coord.heartbeatPlan(p.runId, p.owner)),
    'plan.spawning': method(z.object({ runId: RunId }), (p) => {
      const run = coord.getRun(p.runId);
      if (!run || String(run.role) !== 'plan' || run.status !== 'running') throw new Error('No live planning run.');
      if (run.pid !== null || run.phase !== 'plan') throw new Error('Planning child launch is already in progress.');
      const invocation = coord.getPlanInvocation(run.id);
      if (!invocation || invocation.leaseUntil <= Date.now()) throw new Error('Planning invocation lease expired before launch.');
      coord.updateRun(run.id, { phase: 'plan:spawning' });
    }),
    'plan.spawn': method(z.object({ runId: RunId, pid: z.number().int().positive(), startedAt: z.number().finite().positive() }), (p) => {
      const run = coord.getRun(p.runId);
      if (!run || String(run.role) !== 'plan' || run.status !== 'running') throw new Error('No live planning run.');
      if (run.pid === p.pid && run.proc_started === p.startedAt) return;
      if (run.pid !== null || run.phase !== 'plan:spawning') throw new Error('Planning child requires a recorded spawn intent.');
      coord.updateRun(run.id, { phase: 'plan', pid: p.pid, proc_started: p.startedAt });
    }),
    'plan.usage': method(z.object({ runId: RunId, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      usage: z.object({ costUsd: z.number().finite().nonnegative(), tokensIn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tokensOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        provenance: z.enum(['actual', 'estimated', 'mixed', 'unknown']), cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative().nullable() }) }), (p) => {
      const run = coord.getRun(p.runId);
      if (!run || String(run.role) !== 'plan') throw new Error('No planning run.');
      coord.recordRunUsage(run.id, run.task_id, { generation: run.generation, assignee: `machine:${run.machine_id}` }, p.sequence, p.usage);
    }),
    'plan.finish': method(z.object({ runId: RunId, reaped: z.boolean(), succeeded: z.boolean(), reason: z.string().optional(),
      process: z.object({ pid: z.number().int().positive(), startedAt: z.number().finite().positive() }).optional(), noLaunchPhase: z.string().optional(),
      spawnFailure: z.object({ status: z.literal('spawn_failed'), pid: z.null() }).optional() }), (p) => coord.finishPlan(p.runId, p)),
    'budget.today': method(z.object({}), () => coord.spentToday()),
    'spend.record': method(z.object({ projectId: z.string().nullable(), agent: Id, model: z.string().nullable(), costUsd: z.number().min(0), tokensIn: z.number().int().min(0), tokensOut: z.number().int().min(0), role: z.enum(['plan']) }), (p) =>
      coord.recordSpend({ ...p, machineId: hooks.machineId }),
    ),
    'report.summary': method(z.object({ projectId: z.string().nullish(), days: z.number().min(1).max(365).default(7) }), (p) => buildReport(coord.db, { projectId: p.projectId ?? null, days: p.days })),
    'clean.plan': method(z.object({ projectId: z.string().optional() }), (p) => {
      if (!hooks.cleanPlan) throw new Error('Cleanup runs on the hub machine.');
      return hooks.cleanPlan(p.projectId);
    }),
    'clean.run': method(z.object({ projectId: z.string().optional() }), (p) => {
      if (!hooks.cleanRun) throw new Error('Cleanup runs on the hub machine.');
      return hooks.cleanRun(p.projectId);
    }),
  };
}

export type Methods = ReturnType<typeof buildMethods>;
export type MethodName = keyof Methods;
export type Client = {
  [K in MethodName]: (params: z.input<Methods[K]['schema']>) => Promise<Awaited<ReturnType<Methods[K]['fn']>>>;
};

export async function dispatch(methods: Methods, name: string, params: unknown): Promise<unknown> {
  // Own properties only: names such as "constructor" exist on every object.
  const m = Object.hasOwn(methods, name) ? (methods as Record<string, { schema: z.ZodType; fn: (p: unknown) => unknown }>)[name] : undefined;
  if (!m) throw new Error(`Unknown method ${name}`);
  const parsed = m.schema.safeParse(params ?? {});
  if (!parsed.success) throw new Error(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
  return await m.fn(parsed.data);
}

export function localClient(methods: Methods): Client {
  return new Proxy({} as Client, {
    get: (_t, name: string) => (name === 'then' ? undefined : (params: unknown) => dispatch(methods, name, params)),
  });
}

export { remoteClient } from './rpc.ts';
