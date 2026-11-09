import { worktreeRootOf } from './config.ts';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { removeFast } from './fastfs.ts';
import { LEASE_MS, type Coordinator } from './coordinator.ts';
import { paths } from './paths.ts';
import { git, gitOut, isAncestor, isClean, isLinkedWorktreeOf, listWorktrees, removeWorktree, revParse } from './git.ts';
import { isAlive, processStartTime, terminateRecordedProcess } from './proc.ts';
import { recoverUtilities, runUtilityKey, taskHasPendingUtilities, utilitiesStopped, PENDING_UTILITY_SQL } from './utility-records.ts';
import { tx } from './transaction.ts';
import type { Run } from './types.ts';
import type { TerminateResult } from './proc.ts';
import { TERMINAL_STATUSES, type Project, type Task } from './types.ts';
import { clip } from './text.ts';
import { controllerLastSeen } from './controller-activity.ts';
import { dirBytes, dirOfLogs, findArtifacts, freeGb, gb } from './disk.ts';

export interface CleanItem {
  kind: 'worktree' | 'branch' | 'lock' | 'session' | 'log' | 'tmp' | 'prune' | 'artifacts' | 'events';
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
  taskId?: string;
  generation?: number;
  branch?: string | null;
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
export async function planCleanup(coord: Coordinator, projectId?: string, opts: { sizes?: boolean } = {}): Promise<CleanPlan> {
  const plan: CleanPlan = { remove: [], keep: [] };
  const projects = projectId ? [coord.getProject(projectId)].filter((p): p is Project => !!p) : coord.listProjects();
  for (const project of projects) await planProject(coord, project, plan, opts.sizes !== false);

  // Bound each pass and retain events for unfinished/held tasks, regardless of their age.
  for (const project of projectId ? projects : [...projects, null]) {
    const days = coord.configFor(project?.id ?? '').cleanup.eventRetentionDays;
    if (days === null) continue;
    const cutoff = Date.now() - days * DAY;
    const rows = coord.db.prepare(`SELECT e.id FROM events e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.project_id IS ? AND e.ts < ? AND (e.task_id IS NULL OR t.status IN ('done','failed','canceled'))
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = e.task_id AND r.status IN ('running','lost','cleanup_failed'))
      ORDER BY e.id LIMIT 1000`).all(project?.id ?? null, cutoff);
    if (rows.length) plan.remove.push({ kind: 'events', target: String(cutoff), projectId: project?.id, project: project?.name,
      reason: `Up to ${rows.length} completed-work events older than ${days} days (unfinished and process-held work retained)` });
  }

  const now = Date.now();
  for (const lock of coord.db.prepare('SELECT id, pattern, holder, lease_until FROM locks WHERE lease_until <= ?').all(now) as { id: string; pattern: string; holder: string }[]) {
    plan.remove.push({ kind: 'lock', target: lock.id, reason: `expired reservation of ${lock.pattern} by ${lock.holder}` });
  }
  for (const s of coord.db.prepare('SELECT id, last_seen FROM sessions WHERE last_seen < ?').all(now - 2 * 3600_000) as { id: string }[]) {
    plan.remove.push({ kind: 'session', target: s.id, reason: 'agent session inactive for 2+ hours' });
  }
  const retention = (projects[0] ? coord.configFor(projects[0].id) : null)?.cleanup.logRetentionDays ?? 14;
  const logCapMb = (projects[0] ? coord.configFor(projects[0].id) : null)?.disk.maxLogsMb ?? 500;
  const liveLogs = new Set((coord.db.prepare("SELECT id, log_path FROM runs WHERE status IN ('running','lost','cleanup_failed')").all() as { id: string; log_path: string | null }[]).flatMap((r) => [join(paths.logs(), `${r.id}.log`), r.log_path ?? '']));
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

/** Historical native checkouts belong to their persisted run, even after the task points at a newer one. */
function nativeWorktreeTask(coord: Coordinator, projectId: string, name: string): Task | null {
  const match = /^(t-[a-z0-9]+)-native-([1-9][0-9]*)$/.exec(name);
  if (!match) return null;
  const task = coord.getTask(match[1]!);
  return task?.project_id === projectId && coord.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND generation = ? AND agent = 'native' AND role = 'implement'").get(task.id, Number(match[2])) ? task : null;
}

/** Build output in a worktree that is kept: safe to delete because git ignores it and it can be rebuilt. */
async function planArtifacts(coord: Coordinator, project: Project, worktree: string, plan: CleanPlan): Promise<void> {
  const cfg = coord.configFor(project.id).disk;
  if (!cfg?.trimArtifacts) return;
  for (const a of await findArtifacts(worktree, cfg.artifactDirs)) {
    if (a.bytes < 1e6) continue;
    const name = worktree.split('/').pop()!;
    const task = coord.getTask(name) ?? nativeWorktreeTask(coord, project.id, name);
    plan.remove.push({ kind: 'artifacts', target: a.path, worktree, taskId: task?.id, generation: task?.generation, project: project.name, projectId: project.id, bytes: a.bytes, reason: `build output (${a.rel}, ${gb(a.bytes)}) in a kept worktree; git ignores it and it can be rebuilt` });
  }
}

async function planProject(coord: Coordinator, project: Project, plan: CleanPlan, sizes = true): Promise<void> {
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
    const name = wt.path.split('/').pop()!;
    const nativeTask = nativeWorktreeTask(coord, project.id, name);
    const nativeGeneration = name.split('-native-')[1];
    const task = tasks.get(name) ?? (nativeTask && wt.branch === `yardmaster/native-${nativeTask.id}-${nativeGeneration}` ? nativeTask : null);
    const taskId = task?.id ?? name;
    const item = { kind: 'worktree' as const, target: wt.path, project: project.name, projectId: project.id, taskId, generation: task?.generation, sha: wt.head ?? undefined, branch: wt.branch };
    if (wt.prunable || !existsSync(wt.path)) continue;
    if (wt.locked) {
      plan.keep.push({ ...item, reason: 'worktree is locked (git worktree lock)' });
      continue;
    }
    if (!task) {
      plan.keep.push({ ...item, reason: 'not linked to any Yardmaster task; left alone' });
      continue;
    }
    if (coord.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status IN ('running','lost','cleanup_failed') LIMIT 1").get(task.id) || taskHasPendingUtilities(coord.db, task.id)) {
      plan.keep.push({ ...item, reason: 'An owned process has not been confirmed stopped; work and artifacts are held' });
      continue;
    }
    if (!TERMINAL_STATUSES.includes(task.status)) {
      if (task.status === 'needs_human') {
        plan.keep.push({ ...item, reason: `task ${task.id} needs you; kept for inspection` });
        await planArtifacts(coord, project, wt.path, plan);
      }
      continue;
    }
    if (!isLinkedWorktreeOf(wt.path, project.root)) {
      plan.keep.push({ ...item, reason: 'does not look like a linked worktree of this repo' });
      continue;
    }
    if (!(await isClean(wt.path))) {
      plan.keep.push({ ...item, reason: `task ${task.id} (${task.status}) has uncommitted changes` });
      await planArtifacts(coord, project, wt.path, plan);
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
        await planArtifacts(coord, project, wt.path, plan);
        continue;
      }
    }
    plan.remove.push({ ...item, reason: `task ${task.id} is ${task.status} and everything in it is merged or empty`, bytes: sizes ? await dirBytes(wt.path) : undefined });
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
    const nativeBranch = /^yardmaster\/native-(t-[a-z0-9]+)-([1-9][0-9]*)$/.exec(branch);
    const task = tasks.get(branch.replace('yardmaster/', '')) ?? (nativeBranch ? nativeWorktreeTask(coord, project.id, `${nativeBranch[1]}-native-${nativeBranch[2]}`) : null);
    if (!task) {
      plan.keep.push({ ...item, reason: 'not linked to a known task' });
      continue;
    }
    if (!TERMINAL_STATUSES.includes(task.status)) continue;
    if (checkedOut.has(branch) && !plan.remove.some((r) => r.kind === 'worktree' && r.branch === branch)) continue;
    if (!(await intoTarget(branch))) {
      plan.keep.push({ ...item, reason: `task ${task.id} (${task.status}) has unmerged commits` });
      continue;
    }
    const sha = await revParse(project.root, `refs/heads/${branch}`);
    if (!sha) continue; // Concurrent successful integration may already have tidied this listed ref.
    plan.remove.push({ ...item, taskId: task.id, generation: task.generation, sha, reason: `merged; task ${task.id} is ${task.status}` });
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
  const order: CleanItem['kind'][] = ['artifacts', 'worktree', 'prune', 'branch', 'lock', 'session', 'log', 'tmp', 'events'];
  const items = [...plan.remove].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const item of items) {
    try {
      switch (item.kind) {
        case 'worktree': {
          const root = rootOf(item.projectId);
          const t = item.taskId ? coord.getTask(item.taskId) : null;
          const current = (await listWorktrees(root)).find((w) => resolve(w.path) === resolve(item.target));
          const guard = () => {
            const fresh = item.taskId ? coord.getTask(item.taskId) : null;
            if (!fresh || fresh.project_id !== item.projectId || fresh.generation !== item.generation || !TERMINAL_STATUSES.includes(fresh.status)) throw new Error('Task ownership/status changed since planning; kept');
            if (coord.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status IN ('running','lost','cleanup_failed') LIMIT 1").get(fresh.id)) throw new Error('An owned process has not been confirmed stopped; kept');
            if (taskHasPendingUtilities(coord.db, fresh.id)) throw new Error('Owned utilities have not confirmed exit; kept');
          };
          guard();
          if (!t || !item.sha || !current || current.locked || current.head !== item.sha || current.branch !== item.branch ||
              !underRoot(item.target, worktreeRootOf(coord.configFor(t.project_id))) || !isLinkedWorktreeOf(item.target, root)) throw new Error('Worktree identity/commit/lock changed since planning; kept');
          const cfg = coord.configFor(t.project_id);
          if (!(await isAncestor(root, item.sha, cfg.integration.branch).catch(() => false)) && !(await isAncestor(root, item.sha, coord.getProject(t.project_id)!.base_branch).catch(() => false))) throw new Error('Worktree is no longer merged; kept');
          if (!(await isClean(item.target))) throw new Error('changed since the plan was made; kept');
          await removeWorktree(root, item.target, { expectedHead: item.sha, expectedBranch: item.branch, guard });
          guard();
          const latest = coord.getTask(t.id);
          if (latest?.worktree && resolve(latest.worktree) === resolve(item.target)) coord.updateTask(t.id, { worktree: null });
          break;
        }
        case 'prune':
          await git(item.target, ['worktree', 'prune']);
          break;
        case 'artifacts': {
          const wt = item.worktree!;
          const id = wt.split('/').pop()!;
          const guard = () => {
            const current = item.taskId ? coord.getTask(item.taskId) : coord.getTask(id);
            if (item.taskId && (!current || current.project_id !== item.projectId || current.generation !== item.generation)) throw new Error('Artifact owner changed; kept');
            if (current && ['running', 'verifying', 'merging'].includes(current.status)) throw new Error('its task started running again; kept');
            if (current && coord.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status IN ('running','lost','cleanup_failed') LIMIT 1").get(current.id)) throw new Error('Process exit is unconfirmed; artifacts kept');
            if (current && taskHasPendingUtilities(coord.db, current.id)) throw new Error('Utility exit is unconfirmed; artifacts kept');
            return current;
          };
          const t = guard();
          const still = (await findArtifacts(wt, coord.configFor(t?.project_id ?? '').disk.artifactDirs)).find((a) => a.path === item.target);
          if (!still) throw new Error('no longer looks like ignored build output; kept');
          guard(); // No await between this ownership check and the synchronous rename.
          removeFast(item.target, join(dirname(dirname(wt)), '.trash'));
          break;
        }
        case 'branch': {
          const root = rootOf(item.projectId);
          if (!item.sha) throw new Error('no recorded commit; kept');
          const task = item.taskId ? coord.getTask(item.taskId) : null;
          if (!task || task.generation !== item.generation || !TERMINAL_STATUSES.includes(task.status)) throw new Error('Task changed since planning; branch kept');
          if (coord.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status IN ('running','lost','cleanup_failed') LIMIT 1").get(task.id)) throw new Error('Process exit is unconfirmed; branch kept');
          if (taskHasPendingUtilities(coord.db, task.id)) throw new Error('Utility exit is unconfirmed; branch kept');
          if ((await listWorktrees(root)).some((w) => w.branch === item.target)) throw new Error('Branch is checked out; kept');
          await git(root, ['update-ref', '-d', `refs/heads/${item.target}`, item.sha]);
          break;
        }
        case 'events': {
          const project = item.projectId ? coord.getProject(item.projectId) : null;
          if (item.projectId && !project) throw new Error('Unknown event project');
          const days = coord.configFor(project?.id ?? '').cleanup.eventRetentionDays;
          const cutoff = Number(item.target);
          if (days === null || !Number.isFinite(cutoff) || cutoff > Date.now() - days * DAY) throw new Error('Event retention changed; kept');
          coord.db.prepare(`DELETE FROM events WHERE id IN (SELECT e.id FROM events e LEFT JOIN tasks t ON t.id = e.task_id
            WHERE e.project_id IS ? AND e.ts < ? AND (e.task_id IS NULL OR t.status IN ('done','failed','canceled'))
            AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = e.task_id AND r.status IN ('running','lost','cleanup_failed'))
            ORDER BY e.id LIMIT 1000)`).run(project?.id ?? null, cutoff);
          break;
        }
        case 'lock':
          coord.db.prepare('DELETE FROM locks WHERE id = ? AND lease_until <= ?').run(item.target, Date.now());
          break;
        case 'session': {
          if (coord.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND last_seen >= ?').get(item.target, Date.now() - 2 * 3600_000)) throw new Error('Session became active; kept');
          coord.db.prepare('DELETE FROM locks WHERE holder = ? AND lease_until <= ?').run(item.target, Date.now());
          coord.db.prepare('DELETE FROM sessions WHERE id = ? AND last_seen < ?').run(item.target, Date.now() - 2 * 3600_000);
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
async function recoverRunChildren(coord: Coordinator, run: Pick<Run, 'id' | 'pid' | 'proc_started' | 'phase'>): Promise<TerminateResult> {
  const main: TerminateResult = run.pid ? await terminateRecordedProcess({ pid: run.pid, startedAt: run.proc_started }) :
    run.phase && !run.phase.endsWith(':spawning') ? { status: 'exited' } : { status: 'unverified', reason: 'A child may have spawned without recorded identity.' };
  if (run.pid && ['exited', 'terminated'].includes(main.status)) coord.updateRun(run.id, { pid: null, proc_started: null });
  const utilityExit = await recoverUtilities(coord.db, runUtilityKey(run.id));
  return utilityExit ? main : { status: 'unverified', reason: 'An owned Git or copy utility has not been confirmed stopped.' };
}

function unresolvedClaimRuns(coord: Coordinator, task: Task): Run[] {
  const attached = new Set((coord.db.prepare("SELECT run_id FROM budget_reservations WHERE task_id = ? AND state = 'held' AND run_id IS NOT NULL")
    .all(task.id) as { run_id: string }[]).map(row => row.run_id));
  return coord.runsFor(task.id).filter(run => run.generation === task.generation && run.machine_id === task.machine_id &&
    (attached.has(run.id) || ['running', 'lost', 'cleanup_failed'].includes(run.status) || !utilitiesStopped(coord.db, runUtilityKey(run.id))));
}

function holdUnconfirmedExit(coord: Coordinator, run: Pick<Run, 'id'>, reason: string): boolean {
  return tx(coord.db, () => {
    const fresh = coord.getRun(run.id);
    if (!fresh || (!['running', 'lost', 'cleanup_failed'].includes(fresh.status) && utilitiesStopped(coord.db, runUtilityKey(run.id)) &&
        !coord.db.prepare("SELECT 1 FROM budget_reservations WHERE run_id = ? AND state = 'held'").get(run.id))) return false;
    // An exit acknowledgement can arrive while process/utility lookup is awaiting I/O. Never resurrect it.
    if (fresh.pid === null && fresh.phase === null && coord.getMeta(`recovery:${run.id}`) !== 'local_exit_unacknowledged') coord.setMeta(`recovery:${run.id}`, 'local_exit_unacknowledged');
    if (fresh.status !== 'cleanup_failed' || fresh.stop_reason !== reason) coord.updateRun(run.id, { status: 'cleanup_failed', stop_reason: reason });
    return true;
  });
}

export async function recover(coord: Coordinator, machineId: string, activeTaskIds: Set<string>, opts: { startup?: boolean } = {}): Promise<void> {
  const now = Date.now();
  // Plans have no task row: own their detached group using the invocation owner and its bounded lease.
  const plans = coord.db.prepare("SELECT id FROM runs WHERE role = 'plan' AND status IN ('running','lost','cleanup_failed')").all() as { id: string }[];
  for (const candidate of plans) {
    const run = coord.getRun(candidate.id)!;
    const invocation = coord.getPlanInvocation(run.id);
    // A remote PID has meaning only on its own machine; an expired invocation remains an explicit hold.
    if (run.machine_id !== machineId) {
      if (!invocation || invocation.leaseUntil <= Date.now()) coord.updateRun(run.id, { status: 'cleanup_failed', stop_reason: 'Remote planning invocation expired; its recorded process must be confirmed stopped on that machine.' });
      continue;
    }
    let ownerDead = false;
    if (invocation?.owner) {
      const owner = invocation.owner;
      ownerDead = !isAlive(owner.pid);
      if (!ownerDead) {
        const actual = await processStartTime(owner.pid);
        ownerDead = actual !== null && actual !== owner.startedAt;
      }
    }
    // Re-read after the OS lookup: a heartbeat may have renewed while recovery was awaiting ps.
    const fresh = coord.getRun(run.id);
    const current = coord.getPlanInvocation(run.id);
    if (!fresh || !['running', 'lost', 'cleanup_failed'].includes(fresh.status)) continue;
    if (!ownerDead && current && current.leaseUntil > Date.now()) continue;
    if (ownerDead && current) coord.setMeta(`plan_invocation:${fresh.id}`, JSON.stringify({ ...current, leaseUntil: Date.now() }));
    const result = fresh.pid !== null ? await terminateRecordedProcess({ pid: fresh.pid, startedAt: fresh.proc_started }) :
      fresh.phase && !fresh.phase.endsWith(':spawning') ? { status: 'exited' as const } : { status: 'unverified' as const, reason: 'Planning child may have spawned without a recorded identity.' };
    if (result.status === 'exited' || result.status === 'terminated') {
      if (current?.accountingPending && (fresh.pid !== null || fresh.phase?.endsWith(':spawning'))) {
        coord.updateRun(fresh.id, { status: 'cleanup_failed', stop_reason: 'Planning process exit is confirmed, but final usage is pending. Run ym recover on the planning machine to replay its receipt before releasing budget.' });
      } else {
        coord.confirmRecoveredRunExit(fresh.id, result);
        coord.setMeta(`plan_invocation:${fresh.id}`, null);
      }
    } else coord.updateRun(fresh.id, { status: 'cleanup_failed', stop_reason: result.reason ?? 'Planning process exit could not be verified.' });
  }
  // A prior cleanup failure is a hold, not a permanent dead end. Only identity-proven local recovery clears it.
  // A terminal result can precede run.exit. Attached allowance is unresolved until exit proof, in any task state.
  // Start from the indexed held rows instead of probing a reservation once per historical run.
  const held = coord.db.prepare(`SELECT id FROM runs WHERE machine_id = ? AND status = 'cleanup_failed' AND role <> 'plan'
    UNION SELECT r.id FROM budget_reservations b JOIN runs r ON r.id = b.run_id WHERE b.state = 'held' AND r.role <> 'plan'
    UNION SELECT substr(m.key, 13) FROM meta m WHERE m.key GLOB 'utility:run:*' AND ${PENDING_UTILITY_SQL}`)
    .all(machineId) as { id: string }[];
  for (const candidate of held) {
    const run = coord.getRun(candidate.id);
    if (!run || run.role === 'plan') continue;
    const task = coord.getTask(run.task_id);
    // Current claims must recover and requeue together below; clearing their hold here could hide the orphan.
    if (task?.generation === run.generation && task.machine_id === run.machine_id && ['running', 'verifying'].includes(task.status)) continue;
    const externalOnHub = run.machine_id === machineId && coord.getMeta(`http_run:${run.id}`) === '1';
    if (run.machine_id !== machineId || externalOnHub) {
      const machine = coord.getMachine(run.machine_id);
      // The embedded hub heartbeat says nothing about a separate controller on this same host.
      const controllerSeen = controllerLastSeen(coord.db, run.task_id, run.machine_id, run.generation);
      const lastActivity = Math.max(controllerSeen ?? (externalOnHub ? 0 : machine?.last_seen ?? 0), run.started_at, run.ended_at ?? 0);
      if (now - lastActivity <= LEASE_MS) continue;
      tx(coord.db, () => {
        const fresh = coord.getRun(run.id);
        if (!fresh || fresh.machine_id !== run.machine_id || fresh.generation !== run.generation) return;
        const allowanceHeld = coord.db.prepare("SELECT 1 FROM budget_reservations WHERE run_id = ? AND state = 'held'").get(run.id);
        if (!allowanceHeld && utilitiesStopped(coord.db, runUtilityKey(run.id))) return;
        if (fresh.status === 'cleanup_failed' && coord.getMeta(`recovery:${run.id}`) === 'remote_lease_expired') return;
        coord.setMeta(`recovery:${run.id}`, 'remote_lease_expired');
        coord.updateRun(run.id, { status: 'cleanup_failed', stop_reason: 'Remote exit acknowledgement is missing; the worker or owner must confirm process exit before releasing held resources.' });
      });
      continue; // A remote PID or idle phase never authorizes local signaling or release.
    }
    if (activeTaskIds.has(run.task_id)) continue;
    const result = await recoverRunChildren(coord, run);
    if (result.status === 'exited' || result.status === 'terminated') {
      coord.confirmRecoveredRunExit(run.id, { ...result, reason: 'process recovery confirmed group exit' } as import('./proc.ts').TerminateResult);
      const task = coord.getTask(run.task_id);
      if (run.status === 'cleanup_failed' && task?.status === 'needs_human' && task.generation === run.generation && task.machine_id === run.machine_id &&
          (!task.attention || task.attention.startsWith('Process recovery'))) coord.updateTask(task.id, { attention: 'Process exit is now confirmed. Your work is preserved; retry when ready.' });
    } else {
      holdUnconfirmedExit(coord, run, result.reason ?? 'Owned process exit is unconfirmed; allowance remains held.');
    }
  }
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
    const orphanRuns = unresolvedClaimRuns(coord, t);
    const externalOnHub = t.machine_id === machineId && orphanRuns.some(run => coord.getMeta(`http_run:${run.id}`) === '1');
    if (t.machine_id === machineId && !externalOnHub) {
      if (activeTaskIds.has(t.id)) continue;
      // No live runner in this process owns it: either an earlier hub process died, or a claim never started.
      if (!orphanRuns.length && !(t.lease_until && t.lease_until < now)) continue;
      let uncertain = '';
      for (const owned of orphanRuns) {
        const result = await recoverRunChildren(coord, owned);
        if (!['exited', 'terminated'].includes(result.status)) {
          const reason = result.reason ?? 'Could not prove that the old process stopped.';
          if (holdUnconfirmedExit(coord, owned, reason)) uncertain = reason;
        } else coord.confirmRecoveredRunExit(owned.id, result as import('./proc.ts').TerminateResult);
      }
      const fresh = coord.getTask(t.id);
      if (!fresh || fresh.generation !== t.generation || fresh.assignee !== t.assignee || !['running', 'verifying'].includes(fresh.status)) continue;
      if (uncertain) {
        coord.updateTask(t.id, { status: 'needs_human', attention: `Process recovery is unverified: ${uncertain} Work is preserved and held; inspect the recorded process before retrying.`, lease_until: null });
        continue;
      }
      coord.abandonUnlaunchedClaim(t.id, t.generation, t.machine_id);
      coord.updateTask(t.id, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: Math.max(0, t.attempts - 1) });
      coord.event(t.project_id, t.id, 'warn', 'task.recovered', `Recovered "${t.title}" after a restart; it will continue from its saved worktree.`);
      continue;
    }
    if (t.lease_until && t.lease_until < now) {
      tx(coord.db, () => {
        // Earlier process recovery yielded to I/O; this snapshot may already belong to another claim.
        const fresh = coord.getTask(t.id);
        if (!fresh || fresh.generation !== t.generation || fresh.assignee !== t.assignee || fresh.machine_id !== t.machine_id ||
            !['running', 'verifying'].includes(fresh.status) || !fresh.lease_until || fresh.lease_until >= Date.now()) return;
        const runs = unresolvedClaimRuns(coord, fresh);
        if (runs.length) {
          for (const run of runs) {
            coord.setMeta(`recovery:${run.id}`, 'remote_lease_expired');
            coord.updateRun(run.id, { status: 'cleanup_failed', stop_reason: 'Remote worker must confirm owned process-group exit before work can restart.' });
          }
          coord.updateTask(fresh.id, { status: 'needs_human', attention: 'Remote recovery is waiting for this worker to reconnect and confirm every owned process stopped. Work is preserved.', lease_until: null });
          return;
        }
        coord.abandonUnlaunchedClaim(fresh.id, fresh.generation, fresh.machine_id);
        coord.updateTask(fresh.id, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: Math.max(0, fresh.attempts - 1) });
        const m = fresh.machine_id ? coord.getMachine(fresh.machine_id) : null;
        coord.event(fresh.project_id, fresh.id, 'warn', 'task.lease_expired', `${m?.name ?? 'A machine'} stopped responding while working on "${fresh.title}"; it is back in the queue.`);
      });
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
      const task = coord.getTask(name) ?? nativeWorktreeTask(coord, p.id, name);
      worktrees.push({ path, taskId: task?.id ?? name, title: task?.title ?? (name === '_integration' ? 'integration branch' : null), status: task?.status ?? (name === '_integration' ? 'integration' : 'unknown'), bytes: await dirBytes(path), project: p.name });
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
