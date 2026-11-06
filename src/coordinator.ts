import { tx, type Db } from './db.ts';
import { loadConfig, routingFor, type Config, type Tier } from './config.ts';
import { findCycle } from './graph.ts';
import { chooseAgent, inferTier, type AgentStats, type RouteChoice } from './router.ts';
import { applyPolicies } from './policies.ts';
import { coupling, type ImportGraph } from './imports.ts';
import { addLesson, widenScope } from './lessons.ts';
import { inferScope, normalizePattern, scopesOverlap } from './scope.ts';
import { clip, jaccard, shortId, taskFingerprint, wordSet } from './text.ts';
import {
  ACTIVE_STATUSES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  type Machine,
  type MachineInfo,
  type NewTask,
  type Project,
  type Run,
  type Task,
  type TaskStatus,
  type YardEvent,
} from './types.ts';
import { defaultBranch, mainRepoRoot, projectIdFor } from './git.ts';
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { paths } from './paths.ts';

type Row = Record<string, unknown>;

const DUPLICATE_THRESHOLD = 0.85;
const LEASE_MS = 90_000;

function toTask(r: Row): Task {
  return {
    ...(r as unknown as Task),
    scope: JSON.parse(String(r.scope ?? '[]')) as string[],
    verify: r.verify ? (JSON.parse(String(r.verify)) as string[]) : null,
    scope_inferred: Boolean(r.scope_inferred),
    allow_no_changes: Boolean(r.allow_no_changes),
    pending_rebase: Boolean(r.pending_rebase),
    approved: Boolean(r.approved),
    needs_approval: Boolean(r.needs_approval),
    policies: JSON.parse(String(r.policies ?? '[]')) as string[],
  };
}

function toRun(r: Row): Run {
  return {
    ...(r as unknown as Run),
    touched: JSON.parse(String(r.touched ?? '[]')) as string[],
    lessons: JSON.parse(String(r.lessons ?? '[]')) as string[],
    cost_estimated: Boolean(r.cost_estimated),
    phases: JSON.parse(String(r.phases ?? '{}')) as Record<string, number>,
    resumed: Boolean(r.resumed),
  };
}

const TASK_COLUMNS = new Set([
  'status', 'priority', 'tier', 'agent', 'model', 'scope', 'verify', 'attempts', 'max_attempts', 'budget_usd', 'cost_usd',
  'tokens_in', 'tokens_out', 'assignee', 'machine_id', 'branch', 'worktree', 'base_sha', 'head_sha', 'lease_until',
  'not_before', 'wait_for', 'pending_rebase', 'control', 'summary', 'last_error', 'retry_note', 'error_fp',
  'same_error_count', 'conflict_rounds', 'attention', 'approved', 'started_at', 'finished_at', 'ready_at', 'prompt', 'title',
  'review', 'review_rounds', 'race_group', 'guidance', 'needs_approval', 'policies', 'scope_inferred',
  'agent_session', 'session_agent', 'session_cost', 'session_at',
]);

const RUN_COLUMNS = new Set(['pid', 'proc_started', 'status', 'stop_reason', 'exit_code', 'cost_usd', 'tokens_in', 'tokens_out', 'cost_estimated', 'last_activity', 'touched', 'ended_at', 'lessons', 'verdict', 'phases', 'resumed']);

export class StaleAttemptError extends Error {
  constructor(id: string, status: string) {
    super(`${id} is no longer owned by this attempt (it is now ${status}).`);
    this.name = 'StaleAttemptError';
  }
}

export type TaskPatch = Partial<Omit<Task, 'id' | 'project_id' | 'created_at' | 'created_by' | 'fingerprint'>>;

export interface ClaimRequest {
  machineId: string;
  agents: string[];
  repos: Record<string, string>;
  runningByAgent: Record<string, number>;
}

export interface Claim {
  task: Task;
  project: Project;
  route: RouteChoice;
}

export interface AddResult {
  created: Task[];
  duplicates: { title: string; existing: string; existingTitle: string }[];
}

/** Every status a task can still leave. */
const OPEN_STATUSES: TaskStatus[] = TASK_STATUSES.filter((s: TaskStatus) => !TERMINAL_STATUSES.includes(s));

export class Coordinator {
  readonly db: Db;
  private readonly configCache = new Map<string, { at: number; cfg: Config }>();
  /** Import graphs per project, refreshed by the hub in the background (see Hub.refreshGraphs). */
  readonly graphs = new Map<string, ImportGraph>();
  private budgetWarnedDay = '';

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Called after any change that could let work move (a task changed state, work was added, a reservation was
   * released). The hub uses it to schedule and merge immediately instead of waiting for its next timer tick.
   */
  onChange: (() => void) | null = null;

  private changed(): void {
    this.onChange?.();
  }

  // ---------- per-pass read cache ----------
  //
  // A scheduling pass or a board read asks the same questions once per queued task (what's active, what's locked,
  // what's been spent). Within one pass the answers can't change except through our own writes, so they are
  // computed once; any write clears the cache.

  private passMemo: Map<string, unknown> | null = null;

  pass<T>(fn: () => T): T {
    if (this.passMemo) return fn();
    this.passMemo = new Map();
    try {
      return fn();
    } finally {
      this.passMemo = null;
    }
  }

  private memo<T>(key: string, fn: () => T): T {
    const m = this.passMemo;
    if (!m) return fn();
    if (m.has(key)) return m.get(key) as T;
    const v = fn();
    m.set(key, v);
    return v;
  }

  private invalidate(): void {
    this.passMemo?.clear();
  }

  // ---------- config ----------

  configFor(projectId: string): Config {
    const hit = this.configCache.get(projectId);
    if (hit && Date.now() - hit.at < 2000) return hit.cfg;
    const p = this.getProject(projectId);
    const cfg = loadConfig(p?.root);
    this.configCache.set(projectId, { at: Date.now(), cfg });
    return cfg;
  }

  // ---------- projects ----------

  async registerProject(cwd: string): Promise<Project> {
    const root = await mainRepoRoot(cwd);
    if (!root) throw new Error(`${cwd} is not inside a git repository. Run "git init" and make a first commit, then try again.`);
    const id = await projectIdFor(root);
    const existing = this.getProject(id);
    // A second clone of the same repo on the hub machine reuses the first registration, which owns integration.
    if (existing) return existing;
    const cfg = loadConfig(root);
    const base = cfg.baseBranch ?? (await defaultBranch(root));
    const project: Project = { id, name: basename(root), root, base_branch: base, created_at: Date.now() };
    this.db.prepare('INSERT INTO projects (id, name, root, base_branch, created_at) VALUES (?, ?, ?, ?, ?)').run(id, project.name, root, base, project.created_at);
    this.event(id, null, 'info', 'project.registered', `Project "${project.name}" is now managed by Yardmaster`);
    this.writeManagedRoots();
    return project;
  }

  writeManagedRoots(): void {
    writeFileSync(paths.managedRoots(), this.listProjects().map((p) => p.root).join('\n') + '\n');
  }

  getProject(id: string): Project | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Project[];
  }

  async projectForPath(cwd: string): Promise<Project | null> {
    const root = await mainRepoRoot(cwd);
    if (!root) return null;
    try {
      return this.getProject(await projectIdFor(root));
    } catch {
      return null;
    }
  }

  // ---------- tasks ----------

  addTasks(projectId: string, inputs: NewTask[], createdBy: string, opts: { force?: boolean } = {}): AddResult {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const cfg = this.configFor(projectId);
    return tx(this.db, () => {
      const open = this.openTasks(projectId);
      const keyToId = new Map<string, string>();
      const created: Task[] = [];
      const duplicates: AddResult['duplicates'] = [];
      const batchSeen: { words: Set<string>; id: string; title: string }[] = open.map((t) => ({ words: wordSet(`${t.title} ${t.prompt}`), id: t.id, title: t.title }));
      const now = Date.now();

      const plans = inputs.map((input) => {
        const prompt = input.prompt?.trim() || input.title;
        const words = wordSet(`${input.title} ${prompt}`);
        const dup = opts.force ? undefined : batchSeen.find((s) => jaccard(s.words, words) >= DUPLICATE_THRESHOLD);
        if (dup) {
          duplicates.push({ title: input.title, existing: dup.id, existingTitle: dup.title });
          if (input.key) keyToId.set(input.key, dup.id);
          return null;
        }
        const id = shortId('t');
        if (input.key) keyToId.set(input.key, id);
        batchSeen.push({ words, id, title: input.title });
        return { input, prompt, id };
      });

      const raceVariants: { id: string; of: string }[] = [];
      for (const plan of plans) {
        if (!plan) continue;
        const { input, prompt, id } = plan;
        const explicit = input.files?.map(normalizePattern) ?? [];
        const scope = explicit.length ? explicit : inferScope(`${input.title}\n${prompt}`);
        const guessed: Tier = input.tier ?? inferTier(`${input.title} ${prompt}`, cfg.defaultTier ?? 'standard');
        const { effects, matched } = applyPolicies(cfg, { title: input.title, prompt, scope, tier: guessed, createdBy });
        const tier: Tier = input.tier ?? effects.tier ?? guessed;
        const bestOf = input.bestOf ?? effects.bestOf ?? 1;
        const insert = (taskId: string, title: string, agent: string | null, raceGroup: string | null) =>
          this.db
            .prepare(
              `INSERT INTO tasks (id, project_id, title, prompt, fingerprint, status, priority, tier, agent, scope, scope_inferred, verify,
                allow_no_changes, max_attempts, budget_usd, created_by, created_at, updated_at, review, race_group, guidance, needs_approval, policies, created_tier)
               VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              taskId, projectId, title, prompt, taskFingerprint(title, prompt), input.priority ?? effects.priority ?? 0, tier, agent,
              JSON.stringify(scope), explicit.length ? 0 : 1, (input.verify ?? effects.verify) ? JSON.stringify(input.verify ?? effects.verify) : null,
              input.allowNoChanges ? 1 : 0, effects.maxAttempts ?? cfg.retry.maxAttempts, input.budgetUsd ?? effects.budgetUsd ?? cfg.budget.perTaskUsd,
              createdBy, now, now, input.review ?? effects.review ?? null, raceGroup, effects.guidance ?? null, effects.requireApproval ? 1 : 0, JSON.stringify(matched), tier,
            );
        if (bestOf < 2) {
          insert(id, input.title.trim(), input.agent ?? effects.agent ?? null, null);
          continue;
        }
        // Best-of-N: the same work raced by different agents; the first verified (and reviewed) result wins.
        const agents = this.raceAgents(cfg, tier, bestOf, input.agent ?? effects.agent ?? null);
        insert(id, input.title.trim(), agents[0] ?? null, id);
        for (let i = 1; i < bestOf; i++) {
          const vid = shortId('t');
          insert(vid, `${input.title.trim()} (try ${i + 1})`, agents[i] ?? null, id);
          raceVariants.push({ id: vid, of: id });
        }
      }

      for (const plan of plans) {
        if (!plan) continue;
        const members = [plan.id, ...raceVariants.filter((v) => v.of === plan.id).map((v) => v.id)];
        for (const ref of plan.input.after ?? []) {
          const dep = keyToId.get(ref) ?? ref;
          if (!this.getTask(dep)) throw new Error(`"${plan.input.title}" depends on ${ref}, which does not exist.`);
          if (dep === plan.id) throw new Error(`"${plan.input.title}" cannot depend on itself.`);
          for (const m of members) this.db.prepare('INSERT OR IGNORE INTO deps (task_id, depends_on) VALUES (?, ?)').run(m, dep);
        }
      }

      const cycle = this.dependencyCycle(projectId);
      if (cycle) throw new Error(`These tasks would wait on each other forever: ${cycle.join(' -> ')}. Remove one of the "after" links.`);

      for (const plan of plans) {
        if (!plan) continue;
        const t = this.getTask(plan.id)!;
        created.push(t);
        const scopeNote = t.scope.length ? ` (files: ${t.scope.join(', ')})` : '';
        const ruleNote = t.policies.length ? ` [rules: ${t.policies.join(', ')}]` : '';
        const race = raceVariants.filter((v) => v.of === t.id).length;
        this.event(projectId, t.id, 'info', 'task.created', `New task "${t.title}"${scopeNote}${ruleNote}${race ? ` raced by ${race + 1} agents` : ''}`, { tier: t.tier, by: createdBy });
      }
      for (const v of raceVariants) created.push(this.getTask(v.id)!);
      for (const d of duplicates) this.event(projectId, d.existing, 'warn', 'task.duplicate', `Skipped "${d.title}": it duplicates ${d.existing} "${d.existingTitle}"`);
      if (created.length) this.changed();
      return { created, duplicates };
    });
  }

  /** Distinct agents for a race, from the tier's preference list, preferring ones some online machine has. */
  private raceAgents(cfg: Config, tier: Tier, n: number, forced: string | null): (string | null)[] {
    const online = new Set(this.listMachines().filter((m) => Date.now() - m.last_seen < 120_000).flatMap((m) => m.info.agents));
    const prefs = routingFor(cfg, tier).filter((a) => online.has(a));
    const pool = forced ? [forced, ...prefs.filter((a) => a !== forced)] : prefs;
    return Array.from({ length: n }, (_, i) => pool[i] ?? null);
  }

  /** A dependency on a raced task is satisfied as soon as any member of the race is done. */
  depState(dep: Task): 'done' | 'dead' | 'pending' {
    const group = dep.race_group ? this.memo(`race:${dep.race_group}`, () => this.raceMembers(dep.race_group!)) : [dep];
    if (group.some((t) => t.status === 'done')) return 'done';
    if (group.every((t) => t.status === 'failed' || t.status === 'canceled')) return 'dead';
    return 'pending';
  }

  /** Length of the longest chain of open tasks waiting on this one: work on the critical path starts first. */
  criticalPath(projectId: string): Map<string, number> {
    const open = this.openTasks(projectId);
    const ids = new Set(open.map((t) => t.id));
    const dependents = new Map<string, string[]>();
    // Only edges between open tasks matter, so only those are read: the cost follows the open work, not the history.
    const marks = OPEN_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT d.task_id, d.depends_on FROM deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? AND t.status IN (${marks})`)
      .all(projectId, ...OPEN_STATUSES) as { task_id: string; depends_on: string }[];
    for (const r of rows) if (ids.has(r.task_id) && ids.has(r.depends_on)) dependents.set(r.depends_on, [...(dependents.get(r.depends_on) ?? []), r.task_id]);
    const memo = new Map<string, number>();
    const depth = (id: string, seen: Set<string>): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(0, ...(dependents.get(id) ?? []).map((c) => 1 + depth(c, seen)));
      memo.set(id, d);
      return d;
    };
    for (const t of open) depth(t.id, new Set());
    return memo;
  }

  dependencyCycle(projectId: string): string[] | null {
    const rows = this.db.prepare('SELECT d.task_id, d.depends_on FROM deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?').all(projectId) as { task_id: string; depends_on: string }[];
    const edges = new Map<string, string[]>();
    for (const r of rows) edges.set(r.task_id, [...(edges.get(r.task_id) ?? []), r.depends_on]);
    return findCycle(edges);
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  /** Tasks not finished yet (including ones waiting on a person). */
  openTasks(projectId?: string | null): Task[] {
    return this.listTasks(projectId, OPEN_STATUSES);
  }

  /** Members of a best-of-N race, wherever they are in their life. */
  raceMembers(group: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE race_group = ? ORDER BY created_at').all(group) as Row[]).map(toTask);
  }

  /** How many tasks are in each status, and what they cost in total, without loading them. */
  taskTotals(projectId?: string | null): { counts: Record<string, number>; spent: number } {
    const rows = (projectId
      ? this.db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS s FROM tasks WHERE project_id = ? GROUP BY status').all(projectId)
      : this.db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS s FROM tasks GROUP BY status').all()) as { status: string; n: number; s: number }[];
    return { counts: Object.fromEntries(rows.map((r) => [r.status, r.n])), spent: rows.reduce((t, r) => t + r.s, 0) };
  }

  /** The most recently finished tasks in a status, newest first. */
  recentlyFinished(projectId: string | null | undefined, status: 'done' | 'failed', limit: number): Task[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY finished_at DESC LIMIT ?').all(projectId, status, limit)
      : this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY finished_at DESC LIMIT ?').all(status, limit);
    return (rows as Row[]).map(toTask);
  }

  listTasks(projectId?: string | null, statuses?: TaskStatus[]): Task[] {
    const where: string[] = [];
    const params: string[] = [];
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (statuses?.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toTask);
  }

  depsOf(taskId: string): Task[] {
    if (!this.passMemo) return (this.db.prepare('SELECT t.* FROM deps d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ?').all(taskId) as Row[]).map(toTask);
    const all = this.memo('deps', () => {
      const map = new Map<string, Task[]>();
      for (const r of this.db.prepare('SELECT d.task_id AS for_task, t.* FROM deps d JOIN tasks t ON t.id = d.depends_on').all() as Row[]) {
        const k = String(r.for_task);
        map.set(k, [...(map.get(k) ?? []), toTask(r)]);
      }
      return map;
    });
    return all.get(taskId) ?? [];
  }

  dependentsOf(taskId: string): Task[] {
    const rows = this.db.prepare('SELECT t.* FROM deps d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on = ?').all(taskId) as Row[];
    return rows.map(toTask);
  }

  /**
   * Fenced update for a runner. It only applies while the caller still owns the attempt (same attempt number and
   * assignee, still running or verifying), so a canceled task, or one re-claimed after its lease expired, can never
   * be overwritten by the old attempt.
   */
  updateTaskIfOwner(id: string, owner: { attempt: number; assignee: string }, patch: TaskPatch): Task {
    const t = this.getTask(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    if (t.attempts !== owner.attempt || t.assignee !== owner.assignee || !['running', 'verifying'].includes(t.status)) {
      throw new StaleAttemptError(id, t.status);
    }
    return this.updateTask(id, patch);
  }

  updateTask(id: string, patch: TaskPatch): Task {
    this.invalidate();
    this.changed();
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!TASK_COLUMNS.has(k)) throw new Error(`Cannot update task column ${k}`);
      sets.push(`${k} = ?`);
      if (v === undefined || v === null) vals.push(null);
      else if (typeof v === 'boolean') vals.push(v ? 1 : 0);
      else if (Array.isArray(v)) vals.push(JSON.stringify(v));
      else vals.push(v as string | number);
    }
    sets.push('updated_at = ?');
    vals.push(Date.now());
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const t = this.getTask(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  }

  addUsage(id: string, costUsd: number, tokensIn: number, tokensOut: number): void {
    this.db.prepare('UPDATE tasks SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?').run(costUsd, tokensIn, tokensOut, Date.now(), id);
  }

  /** User and agent controls. All are safe to repeat. */
  control(id: string, action: 'retry' | 'cancel' | 'stop' | 'approve' | 'prioritize' | 'redirect', by: string, note?: string): Task {
    const t = this.getTask(id);
    if (!t) throw new Error(`No task ${id}`);
    switch (action) {
      case 'redirect': {
        const text = note?.trim();
        if (!text) throw new Error('Say what the agent should do differently.');
        if (this.configFor(t.project_id).learning.lessons) addLesson(this, t.project_id, text, 'you', widenScope(t.scope), t.id);
        if (TERMINAL_STATUSES.includes(t.status)) throw new Error(`${id} is ${t.status}; retry it instead.`);
        const guidance = clip(`${by} says: ${text}`, 2000);
        const running = t.status === 'running';
        const next = this.updateTask(id, {
          retry_note: guidance,
          control: running ? 'redirect' : t.control,
          ...(t.status === 'needs_human' ? { status: 'queued' as const, attention: null, same_error_count: 0, not_before: null, max_attempts: Math.max(t.max_attempts, t.attempts + 1) } : {}),
        });
        this.event(t.project_id, id, 'info', 'task.redirect', `${by} redirected "${t.title}": ${clip(text, 160)}${running ? ' (the agent restarts with this guidance, keeping its work so far)' : ''}`);
        return next;
      }
      case 'retry': {
        if (!['needs_human', 'failed', 'canceled', 'queued'].includes(t.status)) throw new Error(`${id} is ${t.status}; only stopped tasks can be retried.`);
        const fresh = this.updateTask(id, {
          status: 'queued', attention: null, not_before: null, same_error_count: 0, error_fp: null, control: null,
          max_attempts: Math.max(t.max_attempts, t.attempts + 1), wait_for: null, conflict_rounds: 0,
        });
        this.event(t.project_id, id, 'info', 'task.retry', `${by} asked to retry "${t.title}"`);
        return fresh;
      }
      case 'cancel': {
        if (TERMINAL_STATUSES.includes(t.status)) return t;
        const next = this.updateTask(id, { status: 'canceled', control: ACTIVE_STATUSES.includes(t.status) ? 'stop' : null, finished_at: Date.now(), attention: null });
        this.releaseLocks(t.project_id, id);
        this.event(t.project_id, id, 'warn', 'task.canceled', `${by} canceled "${t.title}". Its branch and worktree are kept until cleanup confirms nothing is lost.`);
        return next;
      }
      case 'stop': {
        if (!['running', 'verifying'].includes(t.status)) throw new Error(`${id} is not running.`);
        const next = this.updateTask(id, { control: 'stop' });
        this.event(t.project_id, id, 'warn', 'task.stop', `${by} asked to stop "${t.title}"`);
        return next;
      }
      case 'approve': {
        const next = this.updateTask(id, { approved: true, attention: t.status === 'ready' ? null : t.attention });
        this.event(t.project_id, id, 'info', 'task.approved', `${by} approved merging "${t.title}"`);
        return next;
      }
      case 'prioritize':
        return this.updateTask(id, { priority: t.priority + 5 });
    }
  }

  // ---------- fleet pause ----------

  getMeta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Pausing stops new work from starting. Running agents finish unless the caller also stops them. */
  setPaused(projectId: string | null, paused: boolean, by: string): void {
    this.setMeta(`paused:${projectId ?? '*'}`, paused ? JSON.stringify({ by, at: Date.now() }) : null);
    this.changed();
    const name = projectId ? `"${this.getProject(projectId)?.name ?? projectId}"` : 'all projects';
    this.event(projectId, null, paused ? 'warn' : 'info', paused ? 'fleet.paused' : 'fleet.resumed', paused ? `${by} paused new work on ${name}` : `${by} resumed work on ${name}`);
  }

  pausedState(projectId?: string | null): { paused: boolean; by: string | null; scope: 'all' | 'project' | null } {
    return this.memo(`paused:${projectId ?? ''}`, () => this.pausedStateUncached(projectId));
  }

  private pausedStateUncached(projectId?: string | null): { paused: boolean; by: string | null; scope: 'all' | 'project' | null } {
    const all = this.getMeta('paused:*');
    if (all) return { paused: true, by: (JSON.parse(all) as { by: string }).by, scope: 'all' };
    const one = projectId ? this.getMeta(`paused:${projectId}`) : null;
    if (one) return { paused: true, by: (JSON.parse(one) as { by: string }).by, scope: 'project' };
    return { paused: false, by: null, scope: null };
  }

  async anyMerging(projectId: string): Promise<boolean> {
    return this.listTasks(projectId, ['merging']).length > 0;
  }

  // ---------- scheduling ----------

  activeScopes(projectId: string, excludeId?: string): { task: Task; scope: string[] }[] {
    const all = this.memo(`active:${projectId}`, () => {
      const active = this.listTasks(projectId, ACTIVE_STATUSES);
      if (!active.length) return [];
      // Files each active task has actually touched, from its latest run: one query instead of one per task.
      const touched = new Map<string, string[]>();
      const rows = this.db
        .prepare(`SELECT task_id, touched FROM runs WHERE role = 'implement' AND task_id IN (${active.map(() => '?').join(',')}) ORDER BY started_at, rowid`)
        .all(...active.map((t) => t.id)) as { task_id: string; touched: string }[];
      for (const r of rows) touched.set(r.task_id, JSON.parse(r.touched ?? '[]') as string[]);
      return active.map((task) => ({ task, scope: [...new Set([...this.effectiveScope(task), ...(touched.get(task.id) ?? [])])] }));
    });
    if (!excludeId) return all;
    // Members of the same race intentionally work on the same files in separate worktrees.
    const group = all.find((a) => a.task.id === excludeId)?.task.race_group ?? this.getTask(excludeId)?.race_group ?? null;
    return all.filter((a) => a.task.id !== excludeId && (!group || a.task.race_group !== group));
  }

  effectiveScope(task: Task): string[] {
    if (task.scope.length) return task.scope;
    return this.configFor(task.project_id).unknownScope === 'exclusive' ? ['**'] : [];
  }

  activeLocks(projectId: string): { pattern: string; holder: string; reason: string | null; lease_until: number }[] {
    return this.memo(`locks:${projectId}`, () => this.activeLocksUncached(projectId));
  }

  private activeLocksUncached(projectId: string): { pattern: string; holder: string; reason: string | null; lease_until: number }[] {
    return this.db.prepare('SELECT pattern, holder, reason, lease_until FROM locks WHERE project_id = ? AND lease_until > ?').all(projectId, Date.now()) as {
      pattern: string; holder: string; reason: string | null; lease_until: number;
    }[];
  }

  /** Records spend outside any task (planning), so the daily budget sees it. */
  recordSpend(s: { projectId: string | null; agent: string; model: string | null; costUsd: number; tokensIn: number; tokensOut: number; role: string; machineId: string }): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO runs (id, task_id, attempt, machine_id, agent, model, status, cost_usd, tokens_in, tokens_out, cost_estimated, started_at, ended_at, role)
                VALUES (?, ?, 0, ?, ?, ?, 'succeeded', ?, ?, ?, 0, ?, ?, ?)`)
      .run(shortId('r'), `${s.role}:${s.projectId ?? 'none'}`, s.machineId, s.agent, s.model, s.costUsd, s.tokensIn, s.tokensOut, now, now, s.role);
    this.invalidate();
  }

  spentToday(): number {
    return this.memo('spent', () => this.spentTodayUncached());
  }

  private spentTodayUncached(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE started_at >= ?').get(start.getTime()) as { s: number };
    return r.s;
  }

  /** Verified track record per agent on this project (overall and per tier), used by the learned router. */
  agentStats(projectId: string): Record<string, AgentStats> {
    return this.memo(`stats:${projectId}`, () => this.agentStatsUncached(projectId));
  }

  private agentStatsUncached(projectId: string): Record<string, AgentStats> {
    const rows = this.db
      .prepare(
        `SELECT r.agent, COALESCE(r.tier, t.tier) AS tier, COUNT(*) AS runs,
                SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END) AS verified,
                SUM(r.cost_usd) AS cost, SUM(CASE WHEN r.status = 'succeeded' THEN (r.ended_at - r.started_at) ELSE 0 END) AS ms
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE t.project_id = ? AND r.role = 'implement' AND r.status IN ('succeeded', 'failed', 'stopped')
         GROUP BY r.agent, COALESCE(r.tier, t.tier)`,
      )
      .all(projectId) as { agent: string; tier: string; runs: number; verified: number; cost: number; ms: number }[];
    const out: Record<string, AgentStats> = {};
    for (const r of rows) {
      const a = (out[r.agent] ??= { runs: 0, verified: 0, cost: 0, ms: 0, byTier: {} });
      a.runs += r.runs;
      a.verified += r.verified;
      a.cost += r.cost ?? 0;
      a.ms += r.ms ?? 0;
      a.byTier[r.tier] = { runs: r.runs, verified: r.verified, cost: r.cost ?? 0 };
    }
    return out;
  }

  /** Why a queued task is not running yet, in plain language. Null means it can start now. */
  blocker(task: Task, now = Date.now()): string | null {
    const pause = this.pausedState(task.project_id);
    if (pause.paused) return `Paused by ${pause.by ?? 'you'}. Resume to start new work.`;
    if (task.not_before && task.not_before > now) return `Retrying in ${Math.ceil((task.not_before - now) / 1000)}s`;
    const deps = this.depsOf(task.id).filter((d) => this.depState(d) !== 'done');
    if (deps.length) {
      const d = deps[0]!;
      const more = deps.length > 1 ? ` and ${deps.length - 1} more` : '';
      return this.depState(d) === 'dead'
        ? `Blocked: it needs ${d.id} "${clip(d.title, 40)}", which ${d.status === 'failed' ? 'failed' : 'was canceled'}`
        : `Waiting for ${d.id} "${clip(d.title, 40)}"${more} to finish`;
    }
    if (task.wait_for) {
      const w = this.getTask(task.wait_for);
      if (w && !TERMINAL_STATUSES.includes(w.status)) return `Paused until ${w.id} "${clip(w.title, 40)}" merges (both edit the same files)`;
    }
    const mine = this.effectiveScope(task);
    if (mine.length) {
      const graph = this.configFor(task.project_id).coupling === 'serialize' ? this.graphs.get(task.project_id) : undefined;
      for (const { task: other, scope } of this.activeScopes(task.project_id, task.id)) {
        const hits = scopesOverlap(mine, scope);
        if (hits.length) return `Waiting: ${other.id} "${clip(other.title, 40)}" is changing overlapping files (${clip(hits[0], 50)})`;
        const tied = graph ? coupling(graph, mine, scope)[0] : undefined;
        if (tied) return `Waiting: ${other.id} "${clip(other.title, 40)}" is changing ${tied.theirs}, which ${tied.mine} ${tied.direction === 'imports' ? 'imports' : 'is imported by'}`;
      }
      for (const lock of this.activeLocks(task.project_id)) {
        if (lock.holder === task.id) continue;
        const hits = scopesOverlap(mine, [lock.pattern]);
        if (hits.length) return `Waiting: ${lock.holder} has reserved ${lock.pattern}${lock.reason ? ` (${clip(lock.reason, 40)})` : ''}`;
      }
    }
    const daily = this.configFor(task.project_id).budget.dailyUsd;
    if (daily !== null && this.spentToday() >= daily) return `Paused: today's budget of $${daily} is used up`;
    return null;
  }

  /** Atomically hands the best runnable task to a machine. Safe to call concurrently from many processes. */
  claimNext(req: ClaimRequest): Claim | null {
    return this.pass(() => this.claimNextInPass(req));
  }

  private claimNextInPass(req: ClaimRequest): Claim | null {
    return tx(this.db, () => {
      const now = Date.now();
      const queued = (this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' AND assignee IS NULL ORDER BY priority DESC, created_at ASC").all() as Row[]).map(toTask);
      const paths = new Map<string, Map<string, number>>();
      const cp = (t: Task) => {
        if (!paths.has(t.project_id)) paths.set(t.project_id, this.criticalPath(t.project_id));
        return paths.get(t.project_id)!.get(t.id) ?? 0;
      };
      // Priority first, then the task that unblocks the most downstream work, then age.
      queued.sort((a, b) => b.priority - a.priority || cp(b) - cp(a) || a.created_at - b.created_at);
      for (const task of queued) {
        if (!req.repos[task.project_id]) continue;
        if (this.blocker(task, now)) continue;
        // Retries go back to the machine that has the task's worktree (and its partial work), while it is online.
        const prev = this.latestRun(task.id);
        if (prev && prev.machine_id !== req.machineId) {
          const home = this.getMachine(prev.machine_id);
          const cfg = this.configFor(task.project_id);
          const wanted = task.agent ? [task.agent] : routingFor(cfg, task.tier);
          const homeCanRun = home && now - home.last_seen < 60_000 && home.info.repos?.[task.project_id] && home.info.running < home.info.maxParallel && home.info.agents.some((a) => wanted.includes(a));
          // Only wait for the home machine while it could actually take the retry; otherwise start fresh here.
          if (homeCanRun) continue;
        }
        const cfg = this.configFor(task.project_id);
        const route = chooseAgent({
          config: cfg, tier: task.tier, forced: task.agent, installed: req.agents,
          runningByAgent: req.runningByAgent, stats: this.agentStats(task.project_id),
        });
        if (!route) continue;
        const project = this.getProject(task.project_id)!;
        const claimed = this.updateTask(task.id, {
          status: 'running', machine_id: req.machineId, assignee: `machine:${req.machineId}`, attempts: task.attempts + 1,
          started_at: task.started_at ?? now, lease_until: now + LEASE_MS, model: route.model, control: null, attention: null,
          branch: task.branch ?? `yardmaster/${task.id}`,
        });
        const machine = this.getMachine(req.machineId);
        this.event(task.project_id, task.id, 'info', 'task.started',
          `${route.agent}${route.model ? ` (${route.model})` : ''} started "${task.title}" on ${machine?.name ?? req.machineId}${claimed.attempts > 1 ? ` (attempt ${claimed.attempts})` : ''}`,
          { agent: route.agent, reason: route.reason });
        return { task: claimed, project, route };
      }
      const daily = queued[0] ? this.configFor(queued[0].project_id).budget.dailyUsd : null;
      const day = new Date().toDateString();
      if (daily !== null && queued.length && this.spentToday() >= daily && this.budgetWarnedDay !== day) {
        this.budgetWarnedDay = day;
        this.event(null, null, 'warn', 'budget.daily', `Today's budget ($${daily}) is used up. New work will wait until tomorrow or until you raise budget.dailyUsd.`);
      }
      return null;
    });
  }

  renewLease(taskId: string, machineId: string): boolean {
    const r = this.db.prepare('UPDATE tasks SET lease_until = ? WHERE id = ? AND machine_id = ? AND status IN (\'running\', \'verifying\')').run(Date.now() + LEASE_MS, taskId, machineId);
    return Number(r.changes) > 0;
  }

  // ---------- runs ----------

  startRun(task: Task, machineId: string, agent: string, model: string | null, logPath: string, role: 'implement' | 'review' = 'implement'): Run {
    const id = shortId('r');
    this.db.prepare('INSERT INTO runs (id, task_id, attempt, machine_id, agent, model, log_path, status, started_at, role, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, task.id, task.attempts, machineId, agent, model, logPath, 'running', Date.now(), role, task.tier);
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }

  latestRun(taskId: string): Run | null {
    return this.memo(`run:${taskId}`, () => this.latestRunUncached(taskId));
  }

  private latestRunUncached(taskId: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE task_id = ? AND role = 'implement' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as Row | undefined;
    return r ? toRun(r) : null;
  }

  runsFor(taskId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at').all(taskId) as Row[]).map(toRun);
  }

  runningRunsOn(machineId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE machine_id = ? AND status = 'running'").all(machineId) as Row[]).map(toRun);
  }

  updateRun(id: string, patch: Partial<Omit<Run, 'id' | 'task_id'>>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!RUN_COLUMNS.has(k)) throw new Error(`Cannot update run column ${k}`);
      sets.push(`${k} = ?`);
      if (v === undefined || v === null) vals.push(null);
      else if (typeof v === 'boolean') vals.push(v ? 1 : 0);
      else if (Array.isArray(v) || typeof v === 'object') vals.push(JSON.stringify(v));
      else vals.push(v as string | number);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  // ---------- locks ----------

  claimLocks(projectId: string, holder: string, patterns: string[], reason: string | null, ttlMinutes: number) {
    return tx(this.db, () => {
      const norm = patterns.map(normalizePattern);
      const conflicts: { pattern: string; holder: string; reason: string | null }[] = [];
      for (const lock of this.activeLocks(projectId)) {
        if (lock.holder === holder) continue;
        if (scopesOverlap(norm, [lock.pattern]).length) conflicts.push({ pattern: lock.pattern, holder: lock.holder, reason: lock.reason });
      }
      for (const { task, scope } of this.activeScopes(projectId)) {
        if (task.id === holder || task.assignee === holder) continue;
        const hits = scopesOverlap(norm, scope);
        if (hits.length) conflicts.push({ pattern: hits[0]!, holder: task.id, reason: `task "${clip(task.title, 50)}" (${task.status})` });
      }
      if (conflicts.length) return { ok: false, conflicts };
      const until = Date.now() + ttlMinutes * 60_000;
      for (const p of norm) {
        this.db.prepare('DELETE FROM locks WHERE project_id = ? AND holder = ? AND pattern = ?').run(projectId, holder, p);
        this.db.prepare('INSERT INTO locks (id, project_id, pattern, holder, reason, lease_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(shortId('l'), projectId, p, holder, reason, until, Date.now());
      }
      this.event(projectId, null, 'info', 'lock.claimed', `${holder} reserved ${norm.join(', ')}${reason ? ` for ${clip(reason, 60)}` : ''}`);
      return { ok: true, conflicts };
    });
  }

  releaseLocks(projectId: string, holder: string, patterns?: string[]): number {
    this.changed();
    if (patterns?.length) {
      let n = 0;
      for (const p of patterns.map(normalizePattern)) n += Number(this.db.prepare('DELETE FROM locks WHERE project_id = ? AND holder = ? AND pattern = ?').run(projectId, holder, p).changes);
      return n;
    }
    return Number(this.db.prepare('DELETE FROM locks WHERE project_id = ? AND holder = ?').run(projectId, holder).changes);
  }

  whoHas(projectId: string, filePaths: string[]): { path: string; holder: string; detail: string }[] {
    const out: { path: string; holder: string; detail: string }[] = [];
    for (const path of filePaths.map(normalizePattern)) {
      for (const lock of this.activeLocks(projectId)) {
        if (scopesOverlap([path], [lock.pattern]).length) out.push({ path, holder: lock.holder, detail: `reserved ${lock.pattern}${lock.reason ? `: ${lock.reason}` : ''}` });
      }
      for (const { task, scope } of this.activeScopes(projectId)) {
        if (scopesOverlap([path], scope).length) out.push({ path, holder: task.assignee?.startsWith('session:') ? task.assignee : task.id, detail: `task "${clip(task.title, 50)}" (${task.status})` });
      }
    }
    return out;
  }

  // ---------- machines and sessions ----------

  heartbeatMachine(id: string, name: string, info: MachineInfo, isHub = false): void {
    this.db.prepare(
      `INSERT INTO machines (id, name, info, last_seen, is_hub) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, info = excluded.info, last_seen = excluded.last_seen, is_hub = MAX(machines.is_hub, excluded.is_hub)`,
    ).run(id, name, JSON.stringify(info), Date.now(), isHub ? 1 : 0);
  }

  getMachine(id: string): Machine | null {
    return this.memo(`machine:${id}`, () => this.getMachineUncached(id));
  }

  private getMachineUncached(id: string): Machine | null {
    const r = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...(r as unknown as Machine), info: JSON.parse(String(r.info)) as MachineInfo, is_hub: Boolean(r.is_hub) } : null;
  }

  listMachines(): Machine[] {
    return (this.db.prepare('SELECT * FROM machines ORDER BY is_hub DESC, name').all() as Row[]).map((r) => ({
      ...(r as unknown as Machine), info: JSON.parse(String(r.info)) as MachineInfo, is_hub: Boolean(r.is_hub),
    }));
  }

  registerSession(name: string, agent: string | null, projectId: string | null, cwd: string | null, machineId: string | null): string {
    const existing = this.db.prepare('SELECT id FROM sessions WHERE name = ? AND COALESCE(project_id, \'\') = COALESCE(?, \'\')').get(name, projectId) as { id: string } | undefined;
    const id = existing?.id ?? `session:${name}`;
    this.db.prepare(
      `INSERT INTO sessions (id, name, agent, project_id, cwd, machine_id, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, cwd = excluded.cwd, agent = excluded.agent`,
    ).run(id, name, agent, projectId, cwd, machineId, Date.now());
    // A live session keeps the tasks it took; the lease only lapses if the session goes away.
    this.db.prepare("UPDATE tasks SET lease_until = ? WHERE assignee = ? AND status = 'running'").run(Date.now() + 60 * 60_000, id);
    return id;
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  listSessions(projectId?: string): { id: string; name: string; agent: string | null; cwd: string | null; last_seen: number }[] {
    const sql = projectId ? 'SELECT * FROM sessions WHERE project_id = ? ORDER BY last_seen DESC' : 'SELECT * FROM sessions ORDER BY last_seen DESC';
    return (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as { id: string; name: string; agent: string | null; cwd: string | null; last_seen: number }[];
  }

  /** An interactive agent (Claude Code, Codex, T3...) takes a task to do in its own checkout. */
  claimForSession(sessionId: string, projectId: string, taskId?: string): Task | null {
    return tx(this.db, () => {
      const candidates = taskId ? [this.getTask(taskId)].filter((t): t is Task => !!t) : this.listTasks(projectId, ['queued']).sort((a, b) => b.priority - a.priority);
      for (const t of candidates) {
        if (t.status !== 'queued') {
          if (taskId) throw new Error(`${t.id} is ${t.status}, not available.`);
          continue;
        }
        const why = this.blocker(t);
        if (why) {
          if (taskId) throw new Error(`${t.id} cannot start yet: ${why}`);
          continue;
        }
        const claimed = this.updateTask(t.id, { status: 'running', assignee: sessionId, machine_id: null, attempts: t.attempts + 1, started_at: Date.now(), lease_until: Date.now() + 60 * 60_000 });
        this.event(projectId, t.id, 'info', 'task.claimed', `${sessionId.replace('session:', '')} is working on "${t.title}" in its own session`);
        return claimed;
      }
      return null;
    });
  }

  finishForSession(sessionId: string, taskId: string, summary: string, outcome: 'done' | 'failed', branch?: string): Task {
    const t = this.getTask(taskId);
    if (!t) throw new Error(`No task ${taskId}`);
    if (t.assignee !== sessionId) throw new Error(`${taskId} is assigned to ${t.assignee ?? 'nobody'}, not this session.`);
    const now = Date.now();
    const patch: TaskPatch = branch
      ? { status: 'ready', branch, summary: clip(summary, 1200), ready_at: now, lease_until: null, base_sha: null }
      : { status: outcome, summary: clip(summary, 1200), finished_at: now, lease_until: null, attention: null };
    const next = this.updateTask(taskId, patch);
    this.releaseLocks(t.project_id, sessionId);
    this.event(t.project_id, taskId, outcome === 'done' ? 'success' : 'error', `task.${outcome}`, `${sessionId.replace('session:', '')} finished "${t.title}": ${clip(summary, 160)}`);
    return next;
  }

  // ---------- messages ----------

  sendMessage(projectId: string, from: string, to: string, body: string, taskId?: string | null): number {
    const r = this.db.prepare('INSERT INTO messages (project_id, sender, recipient, task_id, body, ts) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, from, to, taskId ?? null, clip(body, 2000), Date.now());
    return Number(r.lastInsertRowid);
  }

  inbox(projectId: string, reader: string, aliases: string[] = []): { id: number; from: string; body: string; task_id: string | null; ts: number }[] {
    const names = [reader, ...aliases, '*'];
    const rows = this.db
      .prepare(
        `SELECT m.id, m.sender AS "from", m.body, m.task_id, m.ts FROM messages m
         WHERE m.project_id = ? AND m.recipient IN (${names.map(() => '?').join(',')}) AND m.sender != ?
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader = ?) ORDER BY m.id LIMIT 50`,
      )
      .all(projectId, ...names, reader, reader) as { id: number; from: string; body: string; task_id: string | null; ts: number }[];
    for (const r of rows) this.db.prepare('INSERT OR IGNORE INTO message_reads (message_id, reader) VALUES (?, ?)').run(r.id, reader);
    return rows;
  }

  // ---------- events ----------

  event(projectId: string | null, taskId: string | null, level: YardEvent['level'], kind: string, message: string, data?: unknown): void {
    this.db.prepare('INSERT INTO events (project_id, task_id, level, kind, message, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, taskId, level, kind, message, data === undefined ? null : JSON.stringify(data), Date.now());
  }

  eventsSince(afterId: number, projectId?: string | null, limit = 200, taskId?: string | null): YardEvent[] {
    const where = ['id > ?'];
    const params: (string | number)[] = [afterId];
    if (projectId) {
      where.push('(project_id = ? OR project_id IS NULL)');
      params.push(projectId);
    }
    if (taskId) {
      where.push('task_id = ?');
      params.push(taskId);
    }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Row[];
    return rows.reverse().map((r) => ({ ...(r as unknown as YardEvent), data: r.data ? JSON.parse(String(r.data)) : null }));
  }

  lastEventId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
  }
}

export interface LiveOverlap {
  otherId: string;
  otherTitle: string;
  file: string;
}

/**
 * Edit-time conflict detection. When two running tasks touch the same file, the one that started
 * later is paused and resumes after the other merges, instead of both finishing and colliding at merge time.
 */
export function checkLiveOverlap(coord: Coordinator, taskId: string, runId: string, touched: string[]): LiveOverlap | null {
  coord.updateRun(runId, { touched });
  const me = coord.getTask(taskId);
  if (!me || !touched.length || !coord.configFor(me.project_id).liveOverlapCheck) return null;
  for (const { task: other, scope } of coord.activeScopes(me.project_id, me.id)) {
    const hits = scopesOverlap(touched, scope);
    if (!hits.length) continue;
    const otherFirst = ['ready', 'merging', 'verifying'].includes(other.status) || (other.started_at ?? 0) <= (me.started_at ?? 0);
    if (otherFirst) return { otherId: other.id, otherTitle: other.title, file: hits[0]!.split(' ~ ')[0]! };
  }
  return null;
}
