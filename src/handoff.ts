import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, worktreeRootOf } from './config.ts';
import type { Coordinator } from './coordinator.ts';
import type { Task } from './types.ts';
import { git, isClean, isLinkedWorktreeOf, revParse } from './git.ts';
import { currentProcessScopeSignal, withProcessScope } from './proc.ts';
import { recordUtility, runUtilityKey } from './utility-records.ts';

/** Stored on the task: one immutable artifact, not an additional job/usage ledger. */
export interface NativeHandoff {
  sessionId: string;
  sessionGeneration: number;
  machineId: string;
  agent: string;
  cwd: string;
  branch: string;
  sha: string | null;
}
export function parseHandoff(raw: string | null | undefined): NativeHandoff | null {
  if (!raw) return null;
  const data = JSON.parse(raw) as NativeHandoff;
  if (!data.sessionId?.startsWith('session:') || !Number.isSafeInteger(data.sessionGeneration) || data.sessionGeneration < 1 ||
      !data.cwd || !data.machineId || !data.branch || (data.sha !== null && !/^[a-f0-9]{40,64}$/.test(data.sha))) throw new Error('Invalid durable native handoff; manual recovery required.');
  return data;
}

/** Never check out, commit, reset, remove or update a ref in the native source. */
export async function assertNativeSource(repo: string, data: NativeHandoff): Promise<string> {
  if (!(existsSync(data.cwd) && (realpathSync(data.cwd) === realpathSync(repo) || isLinkedWorktreeOf(data.cwd, repo)))) throw new Error('Unsupported remote native handoff: source must be an existing checkout of the hub repository. Native binary export is not implemented.');
  if ((await git(repo, ['check-ref-format', '--branch', data.branch], { allowFail: true })).code !== 0 || data.branch.startsWith('-')) throw new Error('Submit a local branch name.');
  // Existing cleanup owns this namespace/root. Do not accept a native source another task could reap.
  if (data.branch.startsWith('yardmaster/')) throw new Error('Native source must use a user-owned branch outside the reserved yardmaster/ namespace. Source preserved.');
  const source = realpathSync(data.cwd);
  for (const config of [loadConfig(), loadConfig(repo)]) {
    const configured = worktreeRootOf(config);
    const root = existsSync(configured) ? realpathSync(configured) : resolve(configured);
    if (source === root || source.startsWith(root + '/')) throw new Error('Native source must be outside Yardmaster-owned worktree roots so ordinary cleanup cannot delete it. Source preserved.');
  }
  const ref = `refs/heads/${data.branch}`;
  const sha = await revParse(repo, ref);
  const attached = (await git(data.cwd, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
  if (!sha || attached !== ref || await revParse(data.cwd, 'HEAD') !== sha || !(await isClean(data.cwd))) throw new Error('Native source is dirty, detached, or no longer on the submitted branch. Commit the intended work and submit again; source work is preserved.');
  if (data.sha && sha !== data.sha) throw new Error('Native source branch moved after capture; no artifact accepted. Source work is preserved.');
  return sha;
}

/** Bounded capture only; long checks/review run in the existing WorkerLoop after this returns. */
export async function submitSessionHandoff(coord: Coordinator, machineId: string, p: { sessionId: string; taskId: string; generation?: number; branch: string; summary: string; outcome: 'done' | 'failed' }): Promise<Task> {
  if (p.outcome !== 'done') throw new Error('A branch can only be submitted with outcome done. Use plain completion to report failure.');
  const { task, run } = coord.beginSessionHandoff(p.sessionId, p.taskId, p.generation, p.branch, machineId, p.summary);
  if (!run) return task; // Replay of this captured session generation, including lost RPC responses.
  const owner = { generation: task.generation, assignee: task.assignee! };
  const key = runUtilityKey(run.id);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort('Native capture deadline (5 seconds) exceeded.'), 5000);
  const poll = setInterval(() => {
    try {
      const current = coord.assertTaskOwner(task.id, owner);
      if (current.control) abort.abort('Native handoff canceled by task control.');
    } catch { abort.abort('Native handoff claim expired or superseded.'); }
  }, 100);
  try {
    const data = parseHandoff(task.native_handoff)!;
    const captured = await withProcessScope({ signal: abort.signal, timeoutMs: 5000,
      beforeSpawn: child => { const t = coord.assertTaskOwner(task.id, owner); if (t.control) throw new Error('Task control pending.'); recordUtility(coord.db, key, { action: 'intent', token: child.token, command: child.command }); },
      onSpawn: (token, child) => recordUtility(coord.db, key, { action: 'spawn', token, pid: child.pid, startedAt: child.startedAt }),
      onExit: (token, result) => recordUtility(coord.db, key, { action: 'exit', token, pid: result.pid, startedAt: result.startedAt, reaped: result.reaped }),
    }, async () => {
      const sha = await assertNativeSource(coord.getProject(task.project_id)!.root, data);
      if (currentProcessScopeSignal()?.aborted) throw new Error('Native capture canceled.');
      return { ...data, sha };
    });
    coord.assertTaskOwner(task.id, owner);
    if (abort.signal.aborted || coord.getTask(task.id)!.control) throw new Error('Native capture canceled.');
    coord.updateRun(run.id, { status: 'succeeded', phase: null, ended_at: Date.now() });
    coord.confirmRunExit(run.id, task.id, owner);
    return coord.queueSessionHandoff(task, captured);
  } catch (error) {
    // Exit acknowledgment itself refuses release when a utility is still alive/unknown.
    try { coord.confirmRunExit(run.id, task.id, owner); }
    catch { coord.updateRun(run.id, { status: 'cleanup_failed', stop_reason: 'Native capture utilities require recovery.' }); }
    try { coord.updateTaskIfOwner(task.id, owner, { status: 'needs_human', attention: (error as Error).message, lease_until: null }); } catch { /* stale/canceled state wins */ }
    throw error;
  } finally { clearTimeout(deadline); clearInterval(poll); }
}

/** Only Yardmaster's new verification checkout/ref is created; the user's branch is read-only. */
export async function materializeNativeArtifact(repo: string, task: Task, path: string, branch: string): Promise<NativeHandoff> {
  const data = parseHandoff(task.native_handoff)!;
  if (!data.sha || task.machine_id !== data.machineId) throw new Error('Native handoff has no complete local capture.');
  await assertNativeSource(repo, data);
  if (existsSync(path)) throw new Error('Native verification checkout already exists; preserve it and resolve recovery before resubmitting.');
  mkdirSync(dirname(path), { recursive: true });
  // Atomic create: never overwrite a user-created or previous Yardmaster ref.
  await git(repo, ['update-ref', `refs/heads/${branch}`, data.sha, '0'.repeat(data.sha.length)]);
  await git(repo, ['worktree', 'add', path, branch]);
  if (await revParse(path, 'HEAD') !== data.sha || !(await isClean(path))) throw new Error('Native artifact materialization changed the captured SHA.');
  return data;
}
