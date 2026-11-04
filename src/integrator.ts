import { worktreeRootOf } from './config.ts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Coordinator } from './coordinator.ts';
import { addWorktree, branchExists, conflictedFiles, git, isAncestor, isClean, isLinkedWorktreeOf, removeWorktree, revParse } from './git.ts';
import { rememberChecked } from './ci/verified.ts';
import { runVerify, Semaphore } from './runner.ts';
import { runShell } from './proc.ts';
import { lockHash, refreshDeps, siblingWorktrees } from './warmstart.ts';
import { clip, errorFingerprint, tail } from './text.ts';
import type { Config } from './config.ts';
import type { Project, Task } from './types.ts';

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

/**
 * The merge queue. Finished work lands on an integration branch inside a worktree Yardmaster owns, so the
 * user's own checkout and branch are never touched. Every operation on that worktree goes through one lock
 * per project, merges use the exact commit that passed verification, and re-verification happens only when
 * the base moved underneath the task.
 */
export class Integrator {
  private readonly coord: Coordinator;
  private readonly verifySlots: Semaphore;
  private readonly lock = new KeyedMutex();
  private readonly busy = new Set<string>();
  private readonly lastGood = new Map<string, string>();
  private readonly warned = new Map<string, string>();
  /** Tasks whose batch failed checks; they go through one at a time to find the culprit. */
  private readonly trainFailed = new Set<string>();

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

  /** Must be called with the project lock held. Returns null when a person is working in the integration worktree. */
  private async ensureLocked(project: Project): Promise<{ path: string; head: string } | null> {
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
      // Our own merge was interrupted (crash or restart): roll back to exactly where it started.
      await git(path, ['merge', '--abort'], { allowFail: true });
      await git(path, ['reset', '--hard', marker]);
    } else if (marker && (await revParse(path, 'HEAD')) !== marker && !(await this.coord.anyMerging(project.id))) {
      // A merge commit was created but its re-verification never finished: undo it.
      await git(path, ['reset', '--hard', marker]);
    }
    this.coord.setMeta(`integrating:${project.id}`, null);
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
    const r = await this.lock.run(projectId, () => this.ensureLocked(project));
    return r?.head ?? this.lastGood.get(projectId) ?? revParse(project.root, cfg.integration.branch);
  }

  /** Run something against the integration branch with the project lock held (used for base bundles). */
  withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.run(projectId, fn);
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
        const s = await runShell(command, { cwd: path, timeoutMs: config.verifyTimeoutMinutes * 60_000 });
        if (s.code !== 0) this.coord.event(project.id, null, 'warn', 'integration.setup_failed', `Setup \`${command}\` failed in the merge worktree: ${clip(s.stdout.trim().split('\n').slice(-3).join(' '), 200)}`);
      }
      if (r.cloned.length) this.coord.event(project.id, null, 'info', 'integration.deps', `Merge worktree has ${r.cloned.map((c) => c.rel).join(', ')} (${(r.ms / 1000).toFixed(1)}s, no reinstall)`);
    } catch (err) {
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

  async step(projectId: string): Promise<boolean> {
    if (this.busy.has(projectId)) return false;
    const project = this.coord.getProject(projectId);
    if (!project) return false;
    const config = this.coord.configFor(projectId);
    const ready = this.coord
      .listTasks(projectId, ['ready'])
      .filter((t) => !(config.integration.requireApproval || t.needs_approval) || t.approved)
      .sort((a, b) => b.priority - a.priority || (a.ready_at ?? 0) - (b.ready_at ?? 0));
    let task: Task | undefined;
    for (const t of ready) {
      if (t.head_sha && (await commitExists(project.root, t.head_sha))) {
        task = t;
        break;
      }
      // Work from another machine may still be uploading; only complain if it never arrives.
      if (Date.now() - (t.ready_at ?? 0) > 120_000) {
        this.coord.updateTask(t.id, { status: 'needs_human', attention: `Its verified commit never arrived on the hub machine. Check that the worker on ${t.machine_id ?? 'the other machine'} is online, then retry.` });
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
          const ok = await this.lock.run(projectId, () => this.integrateTrain(project, train, config));
          if (ok) return true;
        } catch (err) {
          this.coord.event(projectId, null, 'warn', 'integration.train_error', `Batch merge failed (${clip((err as Error).message, 200)}); merging one at a time.`);
          for (const t of train) this.trainFailed.add(t.id);
        } finally {
          this.busy.delete(projectId);
        }
      }
    }
    if (task.race_group) {
      // Best-of-N: the first verified attempt wins; stop the others so they don't spend more.
      for (const rival of this.coord.listTasks(projectId).filter((t) => t.race_group === task!.race_group && t.id !== task!.id && !['done', 'failed', 'canceled'].includes(t.status))) {
        this.coord.control(rival.id, 'cancel', 'the race');
        this.coord.event(projectId, rival.id, 'info', 'race.lost', `"${task.title}" finished first; stopped "${rival.title}".`);
      }
    }
    this.busy.add(projectId);
    try {
      await this.lock.run(projectId, () => this.integrate(project, task!, config));
    } catch (err) {
      this.coord.updateTask(task.id, { status: 'needs_human', attention: `Merging failed unexpectedly: ${clip((err as Error).message, 400)}` });
      this.coord.event(projectId, task.id, 'error', 'integration.error', `Could not merge "${task.title}": ${(err as Error).message}`);
    } finally {
      this.busy.delete(projectId);
    }
    return true;
  }

  private async integrate(project: Project, task: Task, config: Config): Promise<void> {
    const sha = task.head_sha!;
    if (config.integration.mode === 'none') {
      this.coord.updateTask(task.id, { status: 'done', finished_at: Date.now() });
      this.coord.event(project.id, task.id, 'success', 'task.done', `"${task.title}" is done on branch ${task.branch}`);
      return;
    }
    const ensured = await this.ensureLocked(project);
    if (!ensured) return;
    const { path, head: before } = ensured;
    // Re-read under the lock: it may have been canceled while waiting.
    const fresh = this.coord.getTask(task.id);
    if (!fresh || fresh.status !== 'ready' || fresh.head_sha !== sha) return;
    this.coord.updateTask(task.id, { status: 'merging' });
    this.coord.setMeta(`integrating:${project.id}`, before);
    const merge = await git(path, ['merge', '--no-ff', '--no-edit', '-m', `yardmaster: ${task.title} (${task.id})`, sha], { allowFail: true });
    if (merge.code !== 0) {
      const files = await conflictedFiles(path);
      await git(path, ['merge', '--abort'], { allowFail: true });
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      if (!files.length) {
        // Not a content conflict (hook rejection, lock file, untracked file in the way): don't burn conflict rounds.
        this.coord.updateTask(task.id, { status: 'needs_human', attention: `Git refused the merge: ${clip(merge.stderr || merge.stdout, 400)}` });
        this.coord.event(project.id, task.id, 'error', 'integration.error', `Could not merge "${task.title}": ${clip(merge.stderr || merge.stdout, 200)}`);
        return;
      }
      return this.onConflict(project, task, config, files);
    }
    // Quick per-task checks mean the full suite hasn't run on this change yet, so run it now.
    const baseMoved = !task.base_sha || task.base_sha !== before || (!task.verify && config.verifyQuick.length > 0);
    const commands = task.verify ?? config.verify;
    if (baseMoved && commands.length) {
      this.coord.event(project.id, task.id, 'info', 'integration.reverify', `Re-checking "${task.title}" combined with work merged since it started`);
      await this.prepareDeps(project, path, config, task.worktree ? [task.worktree] : []);
      const result = await this.verifySlots.use(() => runVerify(path, commands, config.verifyTimeoutMinutes));
      if (!result.ok) {
        await git(path, ['reset', '--hard', before]);
        this.coord.setMeta(`integrating:${project.id}`, null);
        // "merge:" marks failures that only appear when combined, so passing alone doesn't reset the count.
        const fp = `merge:${errorFingerprint(result.output)}`;
        const same = task.error_fp === fp ? task.same_error_count + 1 : 1;
        const giveUp = same >= config.retry.sameFailureLimit || task.attempts >= task.max_attempts;
        const note = `After combining with the latest merged work, checks failed (\`${result.command}\`):\n${tail(result.output, 40, 2500)}`;
        this.coord.updateTask(task.id, giveUp
          ? { status: 'needs_human', attention: `It works alone but breaks when combined with other merged work. ${clip(note, 500)}`, error_fp: fp, same_error_count: same }
          : { status: 'queued', pending_rebase: true, retry_note: note, error_fp: fp, same_error_count: same, assignee: null, machine_id: null });
        this.coord.event(project.id, task.id, 'warn', 'integration.reverify_failed', `"${task.title}" broke checks when combined with newer work; ${giveUp ? 'needs you' : 'sent back to fix'}.`);
        return;
      }
    }
    const after = await revParse(path, 'HEAD');
    if (after && baseMoved && commands.length) await rememberChecked(path, after, commands);
    // A cancel that arrived during re-verification wins: undo the merge.
    if (this.coord.getTask(task.id)?.status !== 'merging') {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      return;
    }
    this.coord.setMeta(`integrating:${project.id}`, null);
    this.lastGood.set(project.id, after!);
    await this.tidy(project, task, config, sha).catch(() => undefined);
    this.coord.updateTask(task.id, { status: 'done', finished_at: Date.now(), head_sha: after, attention: null });
    this.coord.event(project.id, task.id, 'success', 'task.done', `Merged "${task.title}" into ${config.integration.branch}`);
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
    const fresh = train.map((t) => this.coord.getTask(t.id)).filter((t): t is Task => !!t && t.status === 'ready' && !!t.head_sha);
    const needsCheck = fresh.filter((t) => t.base_sha !== before || config.verifyQuick.length > 0);
    if (fresh.length < 2 || needsCheck.length < 2 || !config.verify.length) return false;
    this.coord.setMeta(`integrating:${project.id}`, before);
    for (const t of fresh) this.coord.updateTask(t.id, { status: 'merging' });
    const merged: Task[] = [];
    for (const t of fresh) {
      const m = await git(path, ['merge', '--no-ff', '--no-edit', '-m', `yardmaster: ${t.title} (${t.id})`, t.head_sha!], { allowFail: true });
      if (m.code !== 0) {
        // Any conflict: undo the whole batch and let the one-at-a-time path deal with each task properly.
        await git(path, ['merge', '--abort'], { allowFail: true });
        await git(path, ['reset', '--hard', before]);
        this.coord.setMeta(`integrating:${project.id}`, null);
        for (const x of fresh) this.coord.updateTask(x.id, { status: 'ready' });
        for (const x of fresh) this.trainFailed.add(x.id);
        return false;
      }
      merged.push(t);
    }
    this.coord.event(project.id, null, 'info', 'integration.train', `Checking ${merged.length} finished tasks together in one run: ${merged.map((t) => `"${clip(t.title, 40)}"`).join(', ')}`);
    await this.prepareDeps(project, path, config, merged.flatMap((t) => (t.worktree ? [t.worktree] : [])));
    const result = await this.verifySlots.use(() => runVerify(path, config.verify, config.verifyTimeoutMinutes));
    const stillMerging = merged.every((t) => this.coord.getTask(t.id)?.status === 'merging');
    if (!result.ok || !stillMerging) {
      await git(path, ['reset', '--hard', before]);
      this.coord.setMeta(`integrating:${project.id}`, null);
      for (const t of merged) if (this.coord.getTask(t.id)?.status === 'merging') this.coord.updateTask(t.id, { status: 'ready' });
      for (const t of merged) this.trainFailed.add(t.id);
      if (!result.ok) this.coord.event(project.id, null, 'warn', 'integration.train_failed', `The combined checks failed; merging those ${merged.length} tasks one at a time to find which one breaks.`);
      return false;
    }
    const after = (await revParse(path, 'HEAD'))!;
    await rememberChecked(path, after, config.verify);
    this.coord.setMeta(`integrating:${project.id}`, null);
    this.lastGood.set(project.id, after);
    for (const t of merged) await this.tidy(project, t, config, t.head_sha!).catch(() => undefined);
    for (const t of merged) {
      this.coord.updateTask(t.id, { status: 'done', finished_at: Date.now(), attention: null });
      this.coord.event(project.id, t.id, 'success', 'task.done', `Merged "${t.title}" into ${config.integration.branch} (batch of ${merged.length})`);
    }
    this.coord.event(project.id, null, 'success', 'integration.train_merged', `Merged ${merged.length} tasks with one check run instead of ${merged.length}.`);
    return true;
  }

  private async onConflict(project: Project, task: Task, config: Config, files: string[]): Promise<void> {
    const rounds = task.conflict_rounds + 1;
    if (rounds > config.integration.maxConflictRounds) {
      this.coord.updateTask(task.id, { status: 'needs_human', conflict_rounds: rounds, attention: `Its changes clash with already-merged work in ${files.join(', ')}, and automatic resolution did not work. Open ${task.worktree ?? task.branch} to resolve by hand, then retry.` });
      this.coord.event(project.id, task.id, 'error', 'integration.conflict', `"${task.title}" has merge conflicts that need you (${files.join(', ')})`);
      return;
    }
    this.coord.updateTask(task.id, {
      status: 'queued', pending_rebase: true, conflict_rounds: rounds, assignee: null, machine_id: null,
      retry_note: `Your branch conflicted with work merged since you started (${files.join(', ')}). The latest work has been merged into your worktree; resolve the conflicts and make sure checks pass.`,
    });
    this.coord.event(project.id, task.id, 'warn', 'integration.conflict', `"${task.title}" conflicts with newer work in ${files.join(', ')}; sending it back to its agent to reconcile (round ${rounds}).`);
  }

  /** After a successful merge, remove the task's worktree and branch, but only if they hold nothing that isn't merged. */
  private async tidy(project: Project, task: Task, config: Config, mergedSha: string): Promise<void> {
    if (!config.cleanup.auto) return;
    const integration = config.integration.branch;
    const ourRoot = resolve(worktreeRootOf(config)) + '/';
    const wt = task.worktree;
    let removed = false;
    if (wt && existsSync(wt) && resolve(wt).startsWith(ourRoot) && isLinkedWorktreeOf(wt, project.root) && (await isClean(wt))) {
      const head = await revParse(wt, 'HEAD');
      if (head && (head === mergedSha || (await isAncestor(project.root, head, integration)))) {
        await removeWorktree(project.root, wt);
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
  }
}
