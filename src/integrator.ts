import { worktreeRootOf } from './config.ts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Coordinator } from './coordinator.ts';
import type { TaskPatch } from './coordinator.ts';
import { tx } from './db.ts';
import { addWorktree, branchExists, conflictedFiles, git, isAncestor, isClean, isLinkedWorktreeOf, removeWorktree, revParse } from './git.ts';
import { rememberChecked } from './ci/verified.ts';
import { Semaphore, verifyCommands } from './runner.ts';
import { verifyArtifact, hasVerification, serviceVerificationHooks } from './verification.ts';
import { runShell, terminateRecordedProcess, withProcessScope, UtilityProcessError, type OwnedRunOptions } from './proc.ts';
import { integrationUtilityKey, utilityHooks, recoverUtilities, forgetStoppedUtilities, taskHasPendingUtilities, utilitiesStopped } from './utility-records.ts';
import { lockHash, refreshDeps, siblingWorktrees } from './warmstart.ts';
import { clip, errorFingerprint, tail } from './text.ts';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Project, Task } from './types.ts';
import { beginService, finishService, serviceHold } from './service-holds.ts';

/** Serializes async work per key. */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next.catch(() => undefined));
    return next;
  }
}

async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
}

class IntegrationHeld extends Error {}
interface IntegrationProcess { phase: string; pid: number | null; startedAt: number | null }

/**
 * The merge queue. Finished work lands on an integration branch inside a worktree Yardmaster owns, so the
 * user's own checkout and branch are never touched. Every operation on that worktree goes through one lock
 * per project, merges use the exact commit that passed verification, and re-verification happens only when
 * the base moved underneath the task.
 */
export class Integrator {
  private readonly coord: Coordinator;
  private readonly verifySlots: Semaphore;
  private readonly transferSlots = new Semaphore(2);
  private readonly lock = new KeyedMutex();
  private readonly busy = new Set<string>();
  private readonly lastGood = new Map<string, string>();
  private readonly warned = new Map<string, string>();
  /** Tasks whose batch failed checks; they go through one at a time to find the culprit. */
  private readonly trainFailed = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();

  /** Stop admission, abort owned checks, and join all in-flight merge operations before releasing hub ownership. */
  async stop(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
  }

  private current(task: Task, statuses: Task['status'][]): boolean {
    const fresh = this.coord.getTask(task.id);
    return !this.lifetime.signal.aborted && !!fresh && fresh.generation === task.generation &&
      fresh.assignee === task.assignee && fresh.head_sha === task.head_sha && statuses.includes(fresh.status) && !fresh.control;
  }

  /** Compare and update synchronously under SQLite's write lock; no stale async snapshot can resurrect cancellation. */
  private transition(task: Task, statuses: Task['status'][], patch: TaskPatch): boolean {
    return tx(this.coord.db, () => {
      if (!this.current(task, statuses)) return false;
      this.coord.updateTask(task.id, patch);
      if (patch.status === 'done') {
        this.coord.setMeta(`integrating:${task.project_id}`, null);
        this.coord.setMeta(`integrating_result:${task.project_id}`, null);
      }
      return true;
    });
  }

  constructor(coord: Coordinator, verifySlots: Semaphore) {
    this.coord = coord;
    this.verifySlots = verifySlots;
  }

  integrationPath(project: Project, config: Config): string {
    return join(worktreeRootOf(config), `${project.name}-${project.id.slice(2, 8)}`, '_integration');
  }

  private warnOnce(project: Project, key: string, message: string) {
    if (this.warned.get(`${project.id}:${key}`) === message) return;
    this.warned.set(`${project.id}:${key}`, message);
    this.coord.event(project.id, null, 'warn', `integration.${key}`, message);
  }

  private serviceHooks(project: Project, config: Config, tasks: Task[] = []) {
    return serviceVerificationHooks(config.services, { projectId: project.id, ...(tasks.length === 1 ? { taskId: tasks[0]!.id } : {}) },
      (level, kind, message, data) => {
        if (tasks.length) for (const task of tasks) this.coord.event(project.id, task.id, level, kind, message, data);
        else this.coord.event(project.id, null, level, kind, message, data);
      }, {
        begin: intent => { beginService(this.coord.db, `integration:${project.id}`, intent, { projectId: project.id, taskIds: tasks.map(task => task.id) }); },
        finish: run => { finishService(this.coord.db, `integration:${project.id}`, run.requestId, run.result.status, run.execution.reaped); },
      });
  }

  private async owned<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const key = integrationUtilityKey(projectId);
    if (!(await recoverUtilities(this.coord.db, key))) throw new IntegrationHeld('Integration utility recovery is not confirmed.');
    const result = await withProcessScope({ ...utilityHooks(this.coord.db, key), signal: this.lifetime.signal }, fn);
    forgetStoppedUtilities(this.coord.db, key);
    return result;
  }

  /** Persist the spawn window too: a restart must never reset underneath an unregistered child. */
  private processGuard(project: Project, phase: string, markIntent = true): OwnedRunOptions['onSpawn'] {
    if (markIntent) this.coord.setMeta(`integration_process:${project.id}`, JSON.stringify({ phase: `${phase}:spawning`, pid: null, startedAt: null }));
    return (proc) => {
      this.coord.setMeta(`integration_process:${project.id}`, JSON.stringify({ phase, pid: proc.pid, startedAt: proc.startedAt }));
    };
  }

  private processFinished(project: Project, reaped: boolean): void {
    if (reaped) {
      this.coord.setMeta(`integration_process:${project.id}`, null);
      return;
    }
    const key = `integration_process:${project.id}`;
    this.coord.setMeta(key, JSON.stringify({ ...JSON.parse(this.coord.getMeta(key) ?? '{}'), held: true }));
    this.warnOnce(project, 'process_hold', 'Integration is held because an owned check process has not been confirmed stopped. Its worktree is preserved; no reset or further merge will run.');
    throw new IntegrationHeld('Integration worktree is held for process recovery.');
  }

  private async recoverProcess(project: Project): Promise<boolean> {
    const value = this.coord.getMeta(`integration_process:${project.id}`);
    if (!value) return true;
    let process: IntegrationProcess;
    try { process = JSON.parse(value) as IntegrationProcess; } catch { return false; }
    const result = process.pid ? await terminateRecordedProcess({ pid: process.pid, startedAt: process.startedAt }) : { status: 'unverified' };
    if (!['exited', 'terminated'].includes(result.status)) {
      this.coord.setMeta(`integration_process:${project.id}`, JSON.stringify({ ...process, held: true }));
      this.warnOnce(project, 'process_hold', 'Integration is waiting for proof that its previous check process stopped. The merge worktree is held and will not be reset.');
      return false;
    }
    this.coord.setMeta(`integration_process:${project.id}`, null);
    return true;
  }

  /** Must be called with the project lock held. Returns null when a person is working in the integration worktree. */
  private async ensureLocked(project: Project): Promise<{ path: string; head: string } | null> {
    const utilitiesReaped = await recoverUtilities(this.coord.db, integrationUtilityKey(project.id));
    const processReaped = await this.recoverProcess(project);
    if (!utilitiesReaped) {
      this.warnOnce(project, 'process_hold', 'An integration Git or copy process has not confirmed exit. Work is preserved and merging is held.');
      return null;
    }
    if (!processReaped) return null;
    const pendingService = serviceHold(this.coord.db, `integration:${project.id}`);
    if (pendingService) {
      this.warnOnce(project, 'service_hold', `Provider request ${pendingService.requestId} requires remote inspection with ym providers pending/resolve. Integration work is preserved.`);
      return null;
    }
    const config = this.coord.configFor(project.id);
    const branch = config.integration.branch;
    const path = this.integrationPath(project, config);
    if (!(await branchExists(project.root, branch))) {
      const base = await revParse(project.root, project.base_branch);
      if (!base) throw new Error(`Base branch "${project.base_branch}" not found in ${project.root}.`);
      await git(project.root, ['branch', branch, base]);
      this.coord.event(project.id, null, 'info', 'integration.created', `Created ${branch} from ${project.base_branch}. Finished work collects there; your branches are untouched.`);
    }
    const created = !existsSync(path);
    if (created) await addWorktree(project.root, path, branch, branch);
    if (!isLinkedWorktreeOf(path, project.root)) throw new Error(`${path} exists but is not a Yardmaster worktree of ${project.root}; refusing to use it.`);
    if (created) await this.prepareDeps(project, path, config, []);
    const marker = this.coord.getMeta(`integrating:${project.id}`);
    if (!(await isClean(path))) {
      if (!marker) {
        // Not ours: someone is resolving something by hand here. Never reset it; just wait.
        this.warnOnce(project, 'manual', `The integration worktree (${path}) has uncommitted changes that Yardmaster did not make. Merging is paused for ${project.name} until you commit or discard them there.`);
        return null;
      }
      // A person may have edited after the crash. Ownership of the folder is not proof
      // of ownership of every changed file; retain uncertain contents for inspection.
      this.warnOnce(project, 'manual', `An interrupted merge has changed files in ${path}. Work is preserved. Resolve and commit the inspected state, then use ym integration adopt ${project.id} --head <current SHA> --note "what you verified". Adoption checks and keeps that commit.`);
      return null;
    } else if (marker) {
      const currentHead = await revParse(path, 'HEAD');
      const recordedResult = this.coord.getMeta(`integrating_result:${project.id}`);
      if (currentHead !== marker && currentHead !== recordedResult) {
        this.warnOnce(project, 'manual', `The integration branch advanced beyond interrupted base ${marker}. Commits are preserved. Inspect ${path}, then use ym integration adopt ${project.id} --head ${currentHead} --note "what you verified" to check and keep the inspected commit.`);
        return null;
      }
      if (currentHead !== marker) await git(path, ['reset', '--hard', marker]);
      for (const task of this.coord.listTasks(project.id, ['merging'])) this.coord.updateTask(task.id, { status: 'ready' });
    }
    this.coord.setMeta(`integrating:${project.id}`, null);
    this.coord.setMeta(`integrating_result:${project.id}`, null);
    if (config.integration.syncBase) await this.syncBase(project, path);
    const head = (await revParse(path, 'HEAD'))!;
    this.lastGood.set(project.id, head);
    return { path, head };
  }

  /** Commit new work should start from: the last verified integration head. Never waits on a running merge. */
  async head(projectId: string): Promise<string | null> {
    const project = this.coord.getProject(projectId);
    if (!project) return null;
    const cfg = this.coord.configFor(projectId);
    if (cfg.integration.mode === 'none') return revParse(project.root, project.base_branch);
    if (this.busy.has(projectId) && this.lastGood.has(projectId)) return this.lastGood.get(projectId)!;
    const r = await this.lock.run(projectId, () => this.owned(projectId, () => this.ensureLocked(project)));
    return r?.head ?? this.lastGood.get(projectId) ?? this.coord.getMeta(`integrating:${projectId}`) ?? revParse(project.root, cfg.integration.branch);
  }

  /** Run something against the integration branch with the project lock held (used for base bundles). */
  withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.run(projectId, () => this.owned(projectId, fn));
  }

  /** Imports only touch unique quarantine refs, so they need no integration-worktree lock. */
  withTransfer<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const key = `utility:transfer:${projectId}:${randomUUID()}`;
    const operation = this.transferSlots.use(() => withProcessScope({ ...utilityHooks(this.coord.db, key), signal: this.lifetime.signal }, fn), this.lifetime.signal)
      .finally(() => { if (utilitiesStopped(this.coord.db, key)) forgetStoppedUtilities(this.coord.db, key); });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  /** Only called before serving requests, never against an active transfer. */
  async recoverTransfers(): Promise<void> {
    const rows = this.coord.db.prepare("SELECT key FROM meta WHERE key GLOB 'utility:transfer:*'").all() as { key: string }[];
    for (const { key } of rows) {
      if (await recoverUtilities(this.coord.db, key)) forgetStoppedUtilities(this.coord.db, key);
      else this.coord.event(null, null, 'warn', 'transfer.process_hold', 'A previous bundle-import process has unverified ownership. Its private quarantine is preserved.', { key });
    }
  }

  /** Explicit owner recovery preserves the inspected commit as the base, then re-verifies queued artifacts. */
  async adopt(projectId: string, expectedHead: string, by: string, note: string): Promise<void> {
    if (note.trim().length < 12) throw new Error('Describe the inspected integration state (at least 12 characters).');
    await this.lock.run(projectId, () => this.owned(projectId, async () => {
      const project = this.coord.getProject(projectId);
      if (!project || !this.coord.getMeta(`integrating:${projectId}`)) throw new Error('No interrupted integration marker exists.');
      if (this.coord.getMeta(`integration_process:${projectId}`) || !utilitiesStopped(this.coord.db, integrationUtilityKey(projectId))) throw new Error('Confirm owned process exit before adopting integration work.');
      const path = this.integrationPath(project, this.coord.configFor(projectId));
      if (!isLinkedWorktreeOf(path, project.root) || !(await isClean(path)) || await revParse(path, 'HEAD') !== expectedHead) throw new Error('Commit/resolve the inspected integration state and pass its exact current HEAD. Nothing was changed.');
      const config = this.coord.configFor(projectId);
      if (serviceHold(this.coord.db, `integration:${projectId}`)) throw new Error('Resolve the pending provider request after inspecting its remote state before adopting integration.');
      const checked = await this.verifySlots.use(() => verifyArtifact(path, config.verify, config.verifyTimeoutMinutes, this.lifetime.signal, this.processGuard(project, 'verify', false), {
        ...this.serviceHooks(project, config, this.coord.listTasks(projectId, ['merging'])),
        beforeSpawn: () => { this.processGuard(project, 'verify'); }, onExit: reaped => this.processFinished(project, reaped),
      }), this.lifetime.signal);
      this.processFinished(project, checked.reaped);
      if (!checked.reaped) throw new IntegrationHeld('Verification process cleanup is unconfirmed. Integration work is preserved.');
      if (!checked.ok || checked.sha !== expectedHead) throw new Error(`Inspected integration commit did not pass checks: ${clip(checked.output, 1000)}`);
      tx(this.coord.db, () => {
        this.coord.setMeta(`integrating:${projectId}`, null);
        this.coord.setMeta(`integrating_result:${projectId}`, null);
        for (const task of this.coord.listTasks(projectId, ['merging'])) this.coord.updateTask(task.id, { status: 'ready' });
        this.coord.event(projectId, null, 'warn', 'integration.owner_adopted', `${by} adopted inspected integration commit ${expectedHead}: ${clip(note, 1000)}`);
      });
      this.lastGood.set(projectId, expectedHead);
    }));
  }

  /**
   * The merge worktree needs installed dependencies like any task worktree, or combined checks fail with "command
   * not found" and good work gets sent back. Refreshed whenever its lockfiles change (a merged dependency update),
   * preferring the worktrees of the tasks being merged, which already installed the new dependencies.
   */
  private async prepareDeps(project: Project, path: string, config: Config, prefer: string[]): Promise<void> {
    const key = `deps:${project.id}`;
    try {
      const r = await refreshDeps(project.root, path, config, this.coord.getMeta(key), [...prefer, ...siblingWorktrees(path)]);
      if (!r) return;
      this.coord.setMeta(key, lockHash(path));
      for (const command of config.worktree.setup) {
        const s = await runShell(command, { cwd: path, timeoutMs: config.verifyTimeoutMinutes * 60_000, signal: this.lifetime.signal, onSpawn: this.processGuard(project, 'setup') });
        this.processFinished(project, s.reaped);
        if (s.code !== 0) this.coord.event(project.id, null, 'warn', 'integration.setup_failed', `Setup \`${command}\` failed in the merge worktree: ${clip(s.stdout.trim().split('\n').slice(-3).join(' '), 200)}`);
      }
      if (r.cloned.length) this.coord.event(project.id, null, 'info', 'integration.deps', `Merge worktree has ${r.cloned.map((c) => c.rel).join(', ')} (${(r.ms / 1000).toFixed(1)}s, no reinstall)`);
    } catch (err) {
      if (err instanceof IntegrationHeld || this.coord.getMeta(`integration_process:${project.id}`)) throw err;
      this.coord.event(project.id, null, 'warn', 'integration.deps_failed', `Couldn't prepare dependencies for the merge worktree: ${clip((err as Error).message, 200)}`);
    }
  }

  /** Pulls new commits from the base branch (the user's own work) into the integration branch. */
  private async syncBase(project: Project, path: string): Promise<void> {
    const base = await revParse(project.root, project.base_branch);
    if (!base || (await isAncestor(path, base, 'HEAD'))) return;
    const r = await git(path, ['merge', '--no-edit', '-m', `yardmaster: sync ${project.base_branch}`, base], { allowFail: true });
    if (r.code !== 0) {
      await git(path, ['merge', '--abort'], { allowFail: true });
      this.warnOnce(project, 'base_conflict', `New commits on ${project.base_branch} conflict with finished agent work. Run "ym land" to see what's waiting, then merge ${project.base_branch} into ${this.coord.configFor(project.id).integration.branch} in ${path} and commit.`);
    }
  }

  step(projectId: string): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.resolve(false);
    const operation = this.stepOnce(projectId);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async stepOnce(projectId: string): Promise<boolean> {
    if (this.busy.has(projectId)) return false;
    const project = this.coord.getProject(projectId);
    if (project && this.coord.getMeta(`integration_process:${project.id}`)) {
      const recovered = await this.lock.run(project.id, () => this.owned(project.id, () => this.ensureLocked(project)));
      if (!recovered) return false;
    }
    if (!project) return false;
    const config = this.coord.configFor(projectId);
    const ready = this.coord
      .listTasks(projectId, ['ready'])
      .filter((t) => {
        if (!hasVerification(verifyCommands(t, config), config.services)) {
          this.transition(t, ['ready'], { status: 'needs_human', attention: 'No verification commands are configured. Work is preserved; add verify commands and retry.' });
          return false;
        }
        return !(config.integration.requireApproval || t.needs_approval) || t.approved;
      })
      .sort((a, b) => b.priority - a.priority || (a.ready_at ?? 0) - (b.ready_at ?? 0));
    let task: Task | undefined;
    for (const t of ready) {
      if (t.head_sha && (await commitExists(project.root, t.head_sha))) {
        task = t;
        break;
      }
      // Work from another machine may still be uploading; only complain if it never arrives.
      if (Date.now() - (t.ready_at ?? 0) > 11 * 60_000) {
        this.transition(t, ['ready'], { status: 'needs_human', attention: `Its verified commit never arrived on the hub machine. Check that the worker on ${t.machine_id ?? 'the other machine'} is online, then retry.` });
      }
    }
    if (!task) return false;
    if (config.integration.trainSize > 1 && !task.race_group) {
      const train: Task[] = [];
      for (const t of ready) {
        if (train.length >= config.integration.trainSize) break;
        if (t.race_group || t.verify || this.trainFailed.has(t.id) || !t.head_sha || !(await commitExists(project.root, t.head_sha))) continue;
        train.push(t);
      }
      if (train.length >= 2) {
        this.busy.add(projectId);
        try {
          const ok = await this.lock.run(projectId, () => this.owned(projectId, () => this.integrateTrain(project, train, config)));
          if (ok) return true;
        } catch (err) {
          if (err instanceof UtilityProcessError) { this.coord.event(projectId, null, 'warn', 'integration.process_error', `Batch integration stopped: ${clip(err.message, 300)}. Work is preserved; the next pass recovers recorded processes before inspecting the checkout.`); return false; }
          if (err instanceof IntegrationHeld) return false;
          this.coord.event(projectId, null, 'warn', 'integration.train_error', `Batch merge failed (${clip((err as Error).message, 200)}); merging one at a time.`);
          for (const t of train) this.trainFailed.add(t.id);
        } finally {
          this.busy.delete(projectId);
        }
      }
    }
    this.coord.cancelRaceRivals(task);
    this.busy.add(projectId);
    try {
      await this.lock.run(projectId, () => this.owned(projectId, () => this.integrate(project, task!, config)));
    } catch (err) {
      if (err instanceof UtilityProcessError) { this.coord.event(projectId, task.id, 'warn', 'integration.process_error', `Integration stopped: ${clip(err.message, 300)}. Work is preserved; the next pass recovers recorded processes before inspecting the checkout.`); return false; }
      if (err instanceof IntegrationHeld) return false;
      this.transition(task, ['ready', 'merging'], { status: 'needs_human', attention: `Merging failed unexpectedly: ${clip((err as Error).message, 400)}` });
      this.coord.event(projectId, task.id, 'error', 'integration.error', `Could not merge "${task.title}": ${(err as Error).message}`);
    } finally {
      this.busy.delete(projectId);
    }
    return true;
  }

  private async preserveChangedVerification(project: Project, path: string, checkedHead: string | null, tasks: Task[]): Promise<void> {
    if (checkedHead && await revParse(path, 'HEAD') === checkedHead && await isClean(path)) return;
    const note = `Verification changed the integration checkout at ${path}. Changes and commits are preserved. Inspect and commit the intended state, then use ym integration adopt ${project.id} --head <current SHA> --note "what you verified". Integration stays held until inspection.`;
    for (const task of tasks) this.transition(task, ['merging'], { attention: note });
    this.warnOnce(project, 'verification_changed', note);
    throw new IntegrationHeld(note);
  }

  private async integrate(project: Project, task: Task, config: Config): Promise<void> {
    const sha = task.head_sha!;
    if (config.integration.mode === 'none') {
      if (!this.transition(task, ['ready'], { status: 'done', finished_at: Date.now() })) return;
      this.coord.event(project.id, task.id, 'success', 'task.done', `"${task.title}" is done on branch ${task.branch}`);
      return;
    }
    const ensured = await this.ensureLocked(project);
    if (!ensured) return;
    const { path, head: before } = ensured;
    // Re-read under the lock: it may have been canceled while waiting.
    if (!this.transition(task, ['ready'], { status: 'merging' })) return;
    this.coord.setMeta(`integrating:${project.id}`, before);
    const merge = await git(path, ['merge', '--no-ff', '--no-edit', '-m', `yardmaster: ${task.title} (${task.id})`, sha], { allowFail: true });
    if (merge.code !== 0) {
      const files = await conflictedFiles(path);
      await git(path, ['merge', '--abort'], { allowFail: true });
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      if (!files.length) {
        // Not a content conflict (hook rejection, lock file, untracked file in the way): don't burn conflict rounds.
        if (!this.transition(task, ['merging'], { status: 'needs_human', attention: `Git refused the merge: ${clip(merge.stderr || merge.stdout, 400)}` })) return;
        this.coord.event(project.id, task.id, 'error', 'integration.error', `Could not merge "${task.title}": ${clip(merge.stderr || merge.stdout, 200)}`);
        return;
      }
      return this.onConflict(project, task, config, files);
    }
    // Quick per-task checks mean the full suite hasn't run on this change yet, so run it now.
    const baseMoved = !task.base_sha || task.base_sha !== before || config.verifyQuick.length > 0 || config.services.verify.length > 0;
    this.coord.setMeta(`integrating_result:${project.id}`, await revParse(path, 'HEAD'));
    const commands = verifyCommands(task, config);
    if (baseMoved && hasVerification(commands, config.services)) {
      this.coord.event(project.id, task.id, 'info', 'integration.reverify', `Re-checking "${task.title}" combined with work merged since it started`);
      await this.prepareDeps(project, path, config, task.worktree ? [task.worktree] : []);
      const result = await this.verifySlots.use(() => verifyArtifact(path, commands, config.verifyTimeoutMinutes, this.lifetime.signal, this.processGuard(project, 'verify', false), {
        ...this.serviceHooks(project, config, [task]),
        beforeSpawn: () => { this.processGuard(project, 'verify'); },
        onExit: reaped => this.processFinished(project, reaped),
      }), this.lifetime.signal);
      this.processFinished(project, result.reaped);
      if (!result.reaped) throw new IntegrationHeld('Verification process cleanup is unconfirmed. Integration work is preserved.');
      await this.preserveChangedVerification(project, path, result.sha, [task]);
      if (!result.ok) {
        await git(path, ['reset', '--hard', before]);
        this.coord.setMeta(`integrating:${project.id}`, null);
        // "merge:" marks failures that only appear when combined, so passing alone doesn't reset the count.
        const fp = `merge:${errorFingerprint(result.output)}`;
        const same = task.error_fp === fp ? task.same_error_count + 1 : 1;
        const giveUp = result.serviceStatus === 'unknown' || same >= config.retry.sameFailureLimit || task.attempts >= task.max_attempts;
        const note = `After combining with the latest merged work, checks failed (\`${result.command}\`):\n${tail(result.output, 40, 2500)}`;
        if (!this.transition(task, ['merging'], giveUp
          ? { status: 'needs_human', attention: `It works alone but breaks when combined with other merged work. ${clip(note, 500)}`, error_fp: fp, same_error_count: same }
          : { status: 'queued', pending_rebase: true, retry_note: note, error_fp: fp, same_error_count: same, assignee: null, machine_id: null })) return;
        this.coord.event(project.id, task.id, 'warn', 'integration.reverify_failed', `"${task.title}" broke checks when combined with newer work; ${giveUp ? 'needs you' : 'sent back to fix'}.`);
        return;
      }
    }
    const after = await revParse(path, 'HEAD');
    if (after && baseMoved && commands.length && !config.services.verify.length) await rememberChecked(path, after, commands);
    // A cancel that arrived during re-verification wins: undo the merge.
    if (!this.current(task, ['merging'])) {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      return;
    }
    // The accepted commit and terminal state are the commit point. Cleanup is post-completion housekeeping,
    // never part of the cancelable merge transaction and never permitted to rewrite task status.
    if (!this.transition(task, ['merging'], { status: 'done', finished_at: Date.now(), head_sha: after, attention: null })) {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      return;
    }
    this.coord.setMeta(`integrating:${project.id}`, null);
    this.lastGood.set(project.id, after!);
    this.coord.event(project.id, task.id, 'success', 'task.done', `Merged "${task.title}" into ${config.integration.branch}`);
    await this.tidy(project, task, config, sha).catch(() => undefined);
  }

  /**
   * Merge train: merge several verified tasks into the integration branch and run the checks once. When the
   * base hasn't moved for a task there is nothing to re-check, so trains only pay off when several tasks were
   * verified against an older base, exactly the pile-up that makes merge queues slow with many agents.
   */
  private async integrateTrain(project: Project, train: Task[], config: Config): Promise<boolean> {
    const ensured = await this.ensureLocked(project);
    if (!ensured) return true;
    const { path, head: before } = ensured;
    const fresh = train.filter((t) => this.current(t, ['ready']));
    const needsCheck = fresh.filter((t) => t.base_sha !== before || config.verifyQuick.length > 0 || config.services.verify.length > 0);
    if (fresh.length < 2 || needsCheck.length < 2 || !hasVerification(config.verify, config.services)) return false;
    this.coord.setMeta(`integrating:${project.id}`, before);
    for (const t of fresh) if (!this.transition(t, ['ready'], { status: 'merging' })) return false;
    const merged: Task[] = [];
    for (const t of fresh) {
      const m = await git(path, ['merge', '--no-ff', '--no-edit', '-m', `yardmaster: ${t.title} (${t.id})`, t.head_sha!], { allowFail: true });
      if (m.code !== 0) {
        // Any conflict: undo the whole batch and let the one-at-a-time path deal with each task properly.
        await git(path, ['merge', '--abort'], { allowFail: true });
        await git(path, ['reset', '--hard', before]);
        this.coord.setMeta(`integrating:${project.id}`, null);
        for (const x of fresh) this.transition(x, ['merging'], { status: 'ready' });
        for (const x of fresh) this.trainFailed.add(x.id);
        return false;
      }
      merged.push(t);
      this.coord.setMeta(`integrating_result:${project.id}`, await revParse(path, 'HEAD'));
    }
    this.coord.event(project.id, null, 'info', 'integration.train', `Checking ${merged.length} finished tasks together in one run: ${merged.map((t) => `"${clip(t.title, 40)}"`).join(', ')}`);
    await this.prepareDeps(project, path, config, merged.flatMap((t) => (t.worktree ? [t.worktree] : [])));
    const result = await this.verifySlots.use(() => verifyArtifact(path, config.verify, config.verifyTimeoutMinutes, this.lifetime.signal, this.processGuard(project, 'verify', false), {
      ...this.serviceHooks(project, config, merged),
      beforeSpawn: () => { this.processGuard(project, 'verify'); },
      onExit: reaped => this.processFinished(project, reaped),
    }), this.lifetime.signal);
    this.processFinished(project, result.reaped);
    if (!result.reaped) throw new IntegrationHeld('Verification process cleanup is unconfirmed. Integration work is preserved.');
    await this.preserveChangedVerification(project, path, result.sha, merged);
    const stillMerging = merged.every((t) => this.current(t, ['merging']));
    if (!result.ok || !stillMerging) {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      for (const t of merged) this.transition(t, ['merging'], result.serviceStatus === 'unknown'
        ? { status: 'needs_human', attention: `Combined provider verification is unknown. Inspect service receipts before retrying. ${clip(result.output, 1000)}` }
        : { status: 'ready' });
      for (const t of merged) this.trainFailed.add(t.id);
      if (!result.ok) this.coord.event(project.id, null, 'warn', 'integration.train_failed', result.serviceStatus === 'unknown'
        ? 'Combined provider verification needs inspection; no individual provider replay was started.'
        : `The combined checks failed; merging those ${merged.length} tasks one at a time to find which one breaks.`);
      return result.serviceStatus === 'unknown';
    }
    const after = (await revParse(path, 'HEAD'))!;
    if (!config.services.verify.length) await rememberChecked(path, after, config.verify);
    const committed = tx(this.coord.db, () => {
      if (!merged.every((t) => this.current(t, ['merging']))) return false;
      for (const t of merged) this.coord.updateTask(t.id, { status: 'done', finished_at: Date.now(), attention: null });
      this.coord.setMeta(`integrating:${project.id}`, null);
      this.coord.setMeta(`integrating_result:${project.id}`, null);
      return true;
    });
    if (!committed) {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      for (const t of merged) this.transition(t, ['merging'], { status: 'ready' });
      return false;
    }
    this.coord.setMeta(`integrating:${project.id}`, null);
    this.lastGood.set(project.id, after);
    for (const t of merged) {
      this.coord.event(project.id, t.id, 'success', 'task.done', `Merged "${t.title}" into ${config.integration.branch} (batch of ${merged.length})`);
    }
    this.coord.event(project.id, null, 'success', 'integration.train_merged', `Merged ${merged.length} tasks with one check run instead of ${merged.length}.`);
    for (const t of merged) await this.tidy(project, t, config, t.head_sha!).catch(() => undefined);
    return true;
  }

  private async onConflict(project: Project, task: Task, config: Config, files: string[]): Promise<void> {
    const rounds = task.conflict_rounds + 1;
    if (rounds > config.integration.maxConflictRounds) {
      if (!this.transition(task, ['merging'], { status: 'needs_human', conflict_rounds: rounds, attention: `Its changes clash with already-merged work in ${files.join(', ')}, and automatic resolution did not work. Open ${task.worktree ?? task.branch} to resolve by hand, then retry.` })) return;
      this.coord.event(project.id, task.id, 'error', 'integration.conflict', `"${task.title}" has merge conflicts that need you (${files.join(', ')})`);
      return;
    }
    if (!this.transition(task, ['merging'], {
      status: 'queued', pending_rebase: true, conflict_rounds: rounds, assignee: null, machine_id: null,
      retry_note: `Your branch conflicted with work merged since you started (${files.join(', ')}). The latest work has been merged into your worktree; resolve the conflicts and make sure checks pass.`,
    })) return;
    this.coord.event(project.id, task.id, 'warn', 'integration.conflict', `"${task.title}" conflicts with newer work in ${files.join(', ')}; sending it back to its agent to reconcile (round ${rounds}).`);
  }

  /** After a successful merge, remove the task's worktree and branch, but only if they hold nothing that isn't merged. */
  private async tidy(project: Project, task: Task, config: Config, mergedSha: string): Promise<void> {
    if (!config.cleanup.auto) return;
    const integration = config.integration.branch;
    const ourRoot = resolve(worktreeRootOf(config)) + '/';
    const wt = task.worktree;
    const guard = () => {
      const current = this.coord.getTask(task.id);
      if (!current || current.generation !== task.generation || current.status !== 'done') throw new Error('Task changed before cleanup; kept');
      if (taskHasPendingUtilities(this.coord.db, task.id)) throw new Error('Owned utilities still hold this task worktree; kept');
    };
    let removed = false;
    if (wt && existsSync(wt) && resolve(wt).startsWith(ourRoot) && isLinkedWorktreeOf(wt, project.root) && (await isClean(wt))) {
      const head = await revParse(wt, 'HEAD');
      if (head && (head === mergedSha || (await isAncestor(project.root, head, integration)))) {
        await removeWorktree(project.root, wt, { expectedHead: head, guard });
        guard();
        this.coord.updateTask(task.id, { worktree: null });
        removed = true;
      }
    }
    if (config.cleanup.deleteMergedBranches && task.branch?.startsWith('yardmaster/') && (removed || !wt || !existsSync(wt))) {
      const tip = await revParse(project.root, `refs/heads/${task.branch}`);
      // update-ref with the expected old value: deletes only the exact commit we checked.
      if (tip && (await isAncestor(project.root, tip, integration))) await git(project.root, ['update-ref', '-d', `refs/heads/${task.branch}`, tip], { allowFail: true });
    }
    await git(project.root, ['update-ref', '-d', `refs/yardmaster/incoming/${task.id}`], { allowFail: true });
    const acceptedRef = `refs/yardmaster/accepted/${task.id}/${task.generation}`;
    const accepted = await revParse(project.root, acceptedRef);
    if (accepted && await isAncestor(project.root, accepted, integration)) {
      guard();
      const removedRef = await git(project.root, ['update-ref', '-d', acceptedRef, accepted], { allowFail: true });
      if (removedRef.code === 0) this.coord.setMeta(`bundle:${task.id}:${task.generation}`, null);
    }
  }
}
