import { worktreeRootOf } from './config.ts';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Coordinator } from './coordinator.ts';
import { paths } from './paths.ts';
import { git, gitOut, isAncestor, isClean, isLinkedWorktreeOf, listWorktrees, removeWorktree } from './git.ts';
import { isAlive, killGroup, processStartTime } from './proc.ts';
import { TERMINAL_STATUSES, type Project } from './types.ts';
import { clip } from './text.ts';
import { dirBytes, dirOfLogs, findArtifacts, freeGb, gb } from './disk.ts';

export interface CleanItem {
  kind: 'worktree' | 'branch' | 'lock' | 'session' | 'log' | 'tmp' | 'prune' | 'artifacts';
  target: string;
  reason: string;
  project?: string;
  /** Space this frees, when known. */
  bytes?: number;
  /** For artifacts: the worktree they live in. */
  worktree?: string;
  projectId?: string;
  /** For branches: the exact commit that was checked, so deletion fails if the branch moved since. */
  sha?: string;
}

export interface CleanPlan {
  remove: CleanItem[];
  keep: CleanItem[];
}

const DAY = 86_400_000;

function underRoot(path: string, root: string): boolean {
  const r = resolve(root) + '/';
  return resolve(path).startsWith(r);
}

/**
 * Builds a cleanup plan. The rule is simple and absolute: anything with uncommitted changes, unmerged
 * commits, or that Yardmaster did not create is kept and reported, never deleted.
 */
export async function planCleanup(coord: Coordinator, projectId?: string): Promise<CleanPlan> {
  const plan: CleanPlan = { remove: [], keep: [] };
  const projects = projectId ? [coord.getProject(projectId)].filter((p): p is Project => !!p) : coord.listProjects();
  for (const project of projects) await planProject(coord, project, plan);

  const now = Date.now();
  for (const lock of coord.db.prepare('SELECT id, pattern, holder, lease_until FROM locks WHERE lease_until <= ?').all(now) as { id: string; pattern: string; holder: string }[]) {
    plan.remove.push({ kind: 'lock', target: lock.id, reason: `expired reservation of ${lock.pattern} by ${lock.holder}` });
  }
  for (const s of coord.db.prepare('SELECT id, last_seen FROM sessions WHERE last_seen < ?').all(now - 2 * 3600_000) as { id: string }[]) {
    plan.remove.push({ kind: 'session', target: s.id, reason: 'agent session inactive for 2+ hours' });
  }
  const retention = (projects[0] ? coord.configFor(projects[0].id) : null)?.cleanup.logRetentionDays ?? 14;
  const logCapMb = (projects[0] ? coord.configFor(projects[0].id) : null)?.disk.maxLogsMb ?? 500;
  const liveLogs = new Set((coord.db.prepare("SELECT id, log_path FROM runs WHERE status = 'running'").all() as { id: string; log_path: string | null }[]).flatMap((r) => [join(paths.logs(), `${r.id}.log`), r.log_path ?? '']));
  const logs = safeList(paths.logs())
    .map((f) => join(paths.logs(), f))
    .filter((full) => !liveLogs.has(full))
    .map((full) => ({ full, st: statSync(full) }))
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  let logBytes = logs.reduce((n, l) => n + l.st.size, 0);
  for (const { full, st } of logs) {
    if (now - st.mtimeMs > retention * DAY) {
      plan.remove.push({ kind: 'log', target: full, reason: `log older than ${retention} days`, bytes: st.size });
      logBytes -= st.size;
    } else if (logBytes > logCapMb * 1e6) {
      plan.remove.push({ kind: 'log', target: full, reason: `oldest log while logs exceed ${logCapMb} MB`, bytes: st.size });
      logBytes -= st.size;
    }
  }
  for (const f of safeList(paths.tmp())) {
    const full = join(paths.tmp(), f);
    if (now - statSync(full).mtimeMs > DAY) plan.remove.push({ kind: 'tmp', target: full, reason: 'temporary file older than a day' });
  }
  return plan;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build output in a worktree that is kept: safe to delete because git ignores it and it can be rebuilt. */
async function planArtifacts(coord: Coordinator, projectName: string, worktree: string, plan: CleanPlan): Promise<void> {
  const project = coord.listProjects().find((p) => p.name === projectName);
  const cfg = project ? coord.configFor(project.id).disk : null;
  if (!cfg?.trimArtifacts) return;
  for (const a of await findArtifacts(worktree, cfg.artifactDirs)) {
    if (a.bytes < 1e6) continue;
    plan.remove.push({ kind: 'artifacts', target: a.path, worktree, project: projectName, projectId: project?.id, bytes: a.bytes, reason: `build output (${a.rel}, ${gb(a.bytes)}) in a kept worktree; git ignores it and it can be rebuilt` });
  }
}

async function planProject(coord: Coordinator, project: Project, plan: CleanPlan): Promise<void> {
  if (!existsSync(project.root)) {
    plan.keep.push({ kind: 'worktree', target: project.root, reason: 'project folder not found on this machine; nothing touched', project: project.name });
    return;
  }
  const config = coord.configFor(project.id);
  const ourRoot = join(worktreeRootOf(config), `${project.name}-${project.id.slice(2, 8)}`);
  const integration = config.integration.branch;
  const tasks = new Map(coord.listTasks(project.id).map((t) => [t.id, t]));
  const worktrees = await listWorktrees(project.root);
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const intoTarget = async (ref: string) => (await isAncestor(project.root, ref, integration).catch(() => false)) || (await isAncestor(project.root, ref, project.base_branch).catch(() => false));

  for (const wt of worktrees) {
    if (!underRoot(wt.path, ourRoot)) continue; // user-owned worktrees are never candidates
    if (wt.path.endsWith('/_integration')) continue;
    const taskId = wt.path.split('/').pop()!;
    const task = tasks.get(taskId);
    const item = { kind: 'worktree' as const, target: wt.path, project: project.name, projectId: project.id };
    if (wt.prunable || !existsSync(wt.path)) continue;
    if (wt.locked) {
      plan.keep.push({ ...item, reason: 'worktree is locked (git worktree lock)' });
      continue;
    }
    if (!task) {
      plan.keep.push({ ...item, reason: 'not linked to any Yardmaster task; left alone' });
      continue;
    }
    if (!TERMINAL_STATUSES.includes(task.status)) {
      if (task.status === 'needs_human') {
        plan.keep.push({ ...item, reason: `task ${task.id} needs you; kept for inspection` });
        await planArtifacts(coord, project.name, wt.path, plan);
      }
      continue;
    }
    if (!isLinkedWorktreeOf(wt.path, project.root)) {
      plan.keep.push({ ...item, reason: 'does not look like a linked worktree of this repo' });
      continue;
    }
    if (!(await isClean(wt.path))) {
      plan.keep.push({ ...item, reason: `task ${task.id} (${task.status}) has uncommitted changes` });
      await planArtifacts(coord, project.name, wt.path, plan);
      continue;
    }
    // Check the worktree's HEAD too: a detached HEAD can hold commits no branch points to.
    const refs = [wt.branch, wt.head].filter((r): r is string => !!r);
    const unmerged: string[] = [];
    for (const r of refs) if (!(await intoTarget(r))) unmerged.push(r);
    if (unmerged.length) {
      const ahead = (await gitOut(project.root, ['rev-list', '--count', `${integration}..${unmerged[0]}`]).catch(() => '?'));
      if (ahead !== '0') {
        plan.keep.push({ ...item, reason: `task ${task.id} (${task.status}) has ${ahead} commit(s) that were never merged` });
        await planArtifacts(coord, project.name, wt.path, plan);
        continue;
      }
    }
    plan.remove.push({ ...item, reason: `task ${task.id} is ${task.status} and everything in it is merged or empty`, bytes: await dirBytes(wt.path) });
  }

  const prunable = worktrees.filter((w) => w.prunable || !existsSync(w.path));
  if (prunable.length && prunable.every((w) => underRoot(w.path, ourRoot))) {
    plan.remove.push({ kind: 'prune', target: project.root, reason: `forget ${prunable.length} worktree record(s) whose folders are already gone`, project: project.name, projectId: project.id });
  } else if (prunable.some((w) => !underRoot(w.path, ourRoot))) {
    plan.keep.push({ kind: 'prune', target: project.root, reason: 'some missing worktrees are not ours (maybe on an unmounted drive); not pruning', project: project.name });
  }

  const refs = (await gitOut(project.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/yardmaster/'])).split('\n').filter(Boolean);
  for (const branch of refs) {
    if (branch === integration) continue;
    const item = { kind: 'branch' as const, target: branch, project: project.name, projectId: project.id };
    const task = tasks.get(branch.replace('yardmaster/', ''));
    if (!task) {
      plan.keep.push({ ...item, reason: 'not linked to a known task' });
      continue;
    }
    if (!TERMINAL_STATUSES.includes(task.status)) continue;
    if (checkedOut.has(branch) && !plan.remove.some((r) => r.kind === 'worktree' && r.target.endsWith(`/${task.id}`))) continue;
    if (!(await intoTarget(branch))) {
      plan.keep.push({ ...item, reason: `task ${task.id} (${task.status}) has unmerged commits` });
      continue;
    }
    const sha = await gitOut(project.root, ['rev-parse', `refs/heads/${branch}`]);
    plan.remove.push({ ...item, sha, reason: `merged; task ${task.id} is ${task.status}` });
  }
}

export async function runCleanup(coord: Coordinator, plan: CleanPlan): Promise<{ removed: CleanItem[]; failed: { item: CleanItem; error: string }[] }> {
  const removed: CleanItem[] = [];
  const failed: { item: CleanItem; error: string }[] = [];
  const rootOf = (id?: string) => {
    const p = id ? coord.getProject(id) : null;
    if (!p) throw new Error('unknown project');
    return p.root;
  };
  // Worktrees before branches: a branch cannot be deleted while checked out.
  const order: CleanItem['kind'][] = ['artifacts', 'worktree', 'prune', 'branch', 'lock', 'session', 'log', 'tmp'];
  const items = [...plan.remove].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const item of items) {
    try {
      switch (item.kind) {
        case 'worktree': {
          const root = rootOf(item.projectId);
          // Re-check right before acting: work may have appeared since the plan was made.
          if (!(await isClean(item.target))) throw new Error('changed since the plan was made; kept');
          await removeWorktree(root, item.target);
          const id = item.target.split('/').pop()!;
          if (coord.getTask(id)) coord.updateTask(id, { worktree: null });
          break;
        }
        case 'prune':
          await git(item.target, ['worktree', 'prune']);
          break;
        case 'artifacts': {
          const wt = item.worktree!;
          const id = wt.split('/').pop()!;
          const t = coord.getTask(id);
          if (t && ['running', 'verifying', 'merging'].includes(t.status)) throw new Error('its task started running again; kept');
          const still = (await findArtifacts(wt, coord.configFor(t?.project_id ?? '').disk.artifactDirs)).find((a) => a.path === item.target);
          if (!still) throw new Error('no longer looks like ignored build output; kept');
          rmSync(item.target, { recursive: true, force: true });
          break;
        }
        case 'branch': {
          const root = rootOf(item.projectId);
          if (!item.sha) throw new Error('no recorded commit; kept');
          await git(root, ['update-ref', '-d', `refs/heads/${item.target}`, item.sha]);
          break;
        }
        case 'lock':
          coord.db.prepare('DELETE FROM locks WHERE id = ?').run(item.target);
          break;
        case 'session': {
          coord.db.prepare('DELETE FROM locks WHERE holder = ?').run(item.target);
          coord.db.prepare('DELETE FROM sessions WHERE id = ?').run(item.target);
          break;
        }
        case 'log':
        case 'tmp':
          rmSync(item.target, { recursive: true, force: true });
          break;
      }
      removed.push(item);
    } catch (err) {
      failed.push({ item, error: (err as Error).message });
    }
  }
  if (removed.length) coord.event(null, null, 'info', 'cleanup', `Cleaned up ${removed.length} item(s): ${summarize(removed)}`);
  return { removed, failed };
}

function summarize(items: CleanItem[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ');
}

/**
 * Self-healing pass, run every few seconds on the hub: requeues work from machines that vanished,
 * kills agent processes orphaned by a previous hub crash, and flags work that can never start.
 */
export async function recover(coord: Coordinator, machineId: string, activeTaskIds: Set<string>, opts: { startup?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (opts.startup) {
    // A merge in flight when the hub stopped: put it back in the queue; the integrator rolls the worktree back.
    for (const t of coord.listTasks(null, ['merging'])) coord.updateTask(t.id, { status: 'ready' });
  }
  for (const t of coord.listTasks(null, ['running', 'verifying'])) {
    if (t.assignee?.startsWith('session:')) {
      if (t.lease_until && t.lease_until < now) {
        coord.updateTask(t.id, { status: 'queued', assignee: null, lease_until: null, attempts: Math.max(0, t.attempts - 1) });
        coord.event(t.project_id, t.id, 'warn', 'task.lease_expired', `${t.assignee.slice(8)} went quiet while holding "${t.title}"; it is back in the queue.`);
      }
      continue;
    }
    if (t.machine_id === machineId) {
      if (activeTaskIds.has(t.id)) continue;
      const run = coord.latestRun(t.id);
      const orphanRun = run && run.status === 'running' && run.machine_id === machineId;
      // No live runner in this process owns it: either an earlier hub process died, or a claim never started.
      if (!orphanRun && !(t.lease_until && t.lease_until < now)) continue;
      if (orphanRun && run.pid && isAlive(run.pid)) {
        // Kill only when we can prove the pid is still our agent (pid + start time); recycled pids are left alone.
        const started = await processStartTime(run.pid);
        if (run.proc_started && started && Math.abs(started - run.proc_started) < 2000) killGroup(run.pid, 'SIGTERM');
      }
      if (orphanRun) coord.updateRun(run.id, { status: 'lost', ended_at: now, stop_reason: 'hub restarted' });
      coord.updateTask(t.id, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: Math.max(0, t.attempts - 1) });
      coord.event(t.project_id, t.id, 'warn', 'task.recovered', `Recovered "${t.title}" after a restart; it will continue from its saved worktree.`);
      continue;
    }
    if (t.lease_until && t.lease_until < now) {
      const run = coord.latestRun(t.id);
      if (run?.status === 'running') coord.updateRun(run.id, { status: 'lost', ended_at: now, stop_reason: 'machine stopped responding' });
      coord.updateTask(t.id, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: Math.max(0, t.attempts - 1) });
      const m = t.machine_id ? coord.getMachine(t.machine_id) : null;
      coord.event(t.project_id, t.id, 'warn', 'task.lease_expired', `${m?.name ?? 'A machine'} stopped responding while working on "${t.title}"; it is back in the queue.`);
    }
  }

  for (const t of coord.listTasks(null, ['queued'])) {
    const dead = coord.depsOf(t.id).find((d) => coord.depState(d) === 'dead');
    if (dead) {
      coord.updateTask(t.id, { status: 'needs_human', attention: `It depends on ${dead.id} "${clip(dead.title, 50)}", which ${dead.status === 'failed' ? 'failed' : 'was canceled'}. Retry that task, or cancel this one.` });
      coord.event(t.project_id, t.id, 'warn', 'task.blocked', `"${t.title}" can't start because ${dead.id} ${dead.status}.`);
    }
    if (t.wait_for) {
      const w = coord.getTask(t.wait_for);
      if (!w || TERMINAL_STATUSES.includes(w.status) || w.status === 'needs_human' || w.wait_for === t.id) {
        // Soft waits never deadlock: if the awaited task is gone, stuck, or waiting on us, release.
        coord.updateTask(t.id, { wait_for: null });
      }
    }
  }
}

export interface DiskReport {
  freeGb: number;
  worktreesBytes: number;
  logsBytes: number;
  quotaGb: number | null;
  minFreeGb: number;
  worktrees: { path: string; taskId: string; title: string | null; status: string; bytes: number; project: string }[];
  reclaimableBytes: number;
}

/** What Yardmaster is using on this machine's disk, and how much `ym clean` would give back. */
export async function diskReport(coord: Coordinator, projectId: string | null): Promise<DiskReport> {
  const projects = projectId ? [coord.getProject(projectId)].filter((p): p is Project => !!p) : coord.listProjects();
  const cfg = projects[0] ? coord.configFor(projects[0].id) : null;
  const root = worktreeRootOf(cfg ?? { worktreeRoot: '' });
  const worktrees: DiskReport['worktrees'] = [];
  for (const p of projects) {
    const dir = join(worktreeRootOf(coord.configFor(p.id)), `${p.name}-${p.id.slice(2, 8)}`);
    for (const name of safeList(dir)) {
      const path = join(dir, name);
      const task = coord.getTask(name);
      worktrees.push({ path, taskId: name, title: task?.title ?? (name === '_integration' ? 'integration branch' : null), status: task?.status ?? (name === '_integration' ? 'integration' : 'unknown'), bytes: await dirBytes(path), project: p.name });
    }
  }
  const plan = await planCleanup(coord, projectId ?? undefined);
  return {
    freeGb: freeGb(root),
    worktreesBytes: await dirBytes(root),
    logsBytes: dirOfLogs(paths.logs()),
    quotaGb: cfg?.disk.maxWorktreesGb ?? null,
    minFreeGb: cfg?.disk.minFreeGb ?? 5,
    worktrees: worktrees.sort((a, b) => b.bytes - a.bytes),
    reclaimableBytes: plan.remove.reduce((n, i) => n + (i.bytes ?? 0), 0),
  };
}
