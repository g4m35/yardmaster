import { cpus, freemem, hostname, loadavg, platform } from 'node:os';
import type { Client } from './api.ts';
import { agentSettings, deepMerge, resolveConfig, type Config, worktreeRootOf } from './config.ts';
import { runAttempt, Semaphore, type StopReason } from './runner.ts';
import { run } from './proc.ts';
import { git, isClean, isLinkedWorktreeOf, listWorktrees, revParse } from './git.ts';
import { dirBytes, freeGb, gb } from './disk.ts';
import { clonesAreFree } from './warmstart.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineInfo, Project, Task } from './types.ts';
import { VERSION } from './version.ts';

export interface BranchTransport {
  /** Make sure `sha` (the integration head on the hub) exists in the local clone. */
  fetchBase(project: Project, repoPath: string, sha: string): Promise<void>;
  /** Send the finished task branch to the hub so it can be merged there. */
  uploadBranch(task: Task, repoPath: string, branch: string, base: string): Promise<{ head: string }>;
}

interface Active {
  task: Task;
  agent: string;
  stop?: (reason: StopReason, message: string) => void;
}

let memCache = { at: 0, mb: Infinity };

/** Free memory that the OS would actually hand out. macOS reports cache as "used", so ask vm_stat there. */
async function availableMemMb(): Promise<number> {
  if (Date.now() - memCache.at < 10_000) return memCache.mb;
  let mb = freemem() / 1048576;
  if (platform() === 'darwin') {
    const r = await run('vm_stat', [], { timeoutMs: 3000 }).catch(() => null);
    const page = Number(r?.stdout.match(/page size of (\d+)/)?.[1] ?? 16384);
    const pages = (name: string) => Number(r?.stdout.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
    if (r) mb = ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page) / 1048576;
  }
  memCache = { at: Date.now(), mb };
  return mb;
}

/**
 * Pulls work for one machine and runs it. The hub runs one of these for its own machine; every other
 * machine runs `ym worker`, which is the same loop talking to the hub over HTTP.
 */
export class WorkerLoop {
  private readonly agentSlots = new Map<string, Semaphore>();
  readonly active = new Map<string, Active>();
  private readonly client: Client;
  readonly machineId: string;
  private readonly name: string;
  private readonly repos: () => Record<string, string>;
  private readonly agents: () => string[];
  private readonly local: () => Config;
  private readonly transport: BranchTransport | null;
  private readonly verifySlots: Semaphore;
  private claiming = false;
  private stopped = false;
  private lastResourceWarn = 0;
  private lastDiskWarn = 0;
  private readonly onDiskPressure: (() => Promise<void>) | null;

  constructor(opts: {
    client: Client;
    machineId: string;
    name?: string;
    repos: () => Record<string, string>;
    agents: () => string[];
    localConfig: () => Config;
    transport?: BranchTransport;
    verifySlots: Semaphore;
    /** Called when worktrees exceed their disk quota; the hub uses it to run cleanup. */
    onDiskPressure?: () => Promise<void>;
  }) {
    this.onDiskPressure = opts.onDiskPressure ?? null;
    this.client = opts.client;
    this.machineId = opts.machineId;
    this.name = opts.name ?? hostname();
    this.repos = opts.repos;
    this.agents = opts.agents;
    this.local = opts.localConfig;
    this.transport = opts.transport ?? null;
    this.verifySlots = opts.verifySlots;
  }

  async disk(): Promise<{ freeGb: number; worktreesGb: number }> {
    const cfg = this.local();
    const root = worktreeRootOf(cfg);
    // Copy-on-write clones of dependencies cost no real disk, so they don't count against the quota.
    const exclude = cfg.worktree.warmStart === 'clone' && existsSync(root) && (await clonesAreFree(root)) ? cfg.worktree.shareDirs : [];
    return { freeGb: freeGb(root), worktreesGb: (await dirBytes(root, 60_000, exclude)) / 1e9 };
  }

  async info(): Promise<MachineInfo> {
    const disk = await this.disk();
    return {
      diskFreeGb: Math.round(disk.freeGb * 10) / 10,
      worktreesGb: Math.round(disk.worktreesGb * 100) / 100,
      agents: this.agents(),
      repos: this.repos(),
      maxParallel: this.local().maxParallel,
      running: this.active.size,
      loadPerCpu: loadavg()[0]! / Math.max(1, cpus().length),
      freeMemMb: Math.round(await availableMemMb()),
      platform: platform(),
      version: VERSION,
    };
  }

  async heartbeat(): Promise<void> {
    await this.client['machine.heartbeat']({
      id: this.machineId,
      name: this.name,
      info: (await this.info()) as unknown as Record<string, unknown>,
      running: [...this.active.values()].map(({ task }) => ({ taskId: task.id, generation: task.generation })),
    });
  }

  private async hasCapacity(): Promise<boolean> {
    const cfg = this.local();
    if (this.active.size >= cfg.maxParallel) return false;
    if (!(await this.diskOk())) return false;
    const load = loadavg()[0]! / Math.max(1, cpus().length);
    const mem = await availableMemMb();
    if (this.active.size > 0 && (load > cfg.resources.maxLoadPerCpu || mem < cfg.resources.minFreeMemMb)) {
      if (Date.now() - this.lastResourceWarn > 5 * 60_000) {
        this.lastResourceWarn = Date.now();
        await this.client['task.event']({ projectId: null, taskId: null, level: 'info', kind: 'machine.busy', message: `${this.name} is busy (load ${load.toFixed(2)}/cpu, ${Math.round(mem)} MB free); holding new work until it frees up.` }).catch(() => undefined);
      }
      return false;
    }
    return true;
  }

  /** New worktrees need room: hold work when the disk is nearly full or Yardmaster's quota is used up. */
  private async diskOk(): Promise<boolean> {
    const cfg = this.local().disk;
    const d = await this.disk();
    let problem: string | null = null;
    if (d.freeGb < cfg.minFreeGb) problem = `only ${d.freeGb.toFixed(1)} GB free on the worktree disk (minimum ${cfg.minFreeGb} GB)`;
    else if (cfg.maxWorktreesGb !== null && d.worktreesGb > cfg.maxWorktreesGb) problem = `worktrees use ${gb(d.worktreesGb * 1e9)}, over the ${cfg.maxWorktreesGb} GB quota`;
    if (!problem) return true;
    // Cleaning can take a while; work is held either way, so don't make this check wait for it.
    if (this.onDiskPressure) void this.onDiskPressure().catch(() => undefined);
    if (Date.now() - this.lastDiskWarn > 10 * 60_000) {
      this.lastDiskWarn = Date.now();
      await this.client['task.event']({ projectId: null, taskId: null, level: 'warn', kind: 'machine.disk', message: `${this.name} is holding new work: ${problem}. Finished worktrees and build output are cleaned automatically; run "ym disk" to see what is using space.` }).catch(() => undefined);
    }
    return false;
  }

  /**
   * On machines other than the hub, worktrees of finished tasks are removed once the hub confirms the task is
   * done with the exact accepted commit. Unmerged, detached, locked, dirty or active worktrees are kept.
   */
  async tidyLocal(): Promise<void> {
    if (!this.transport) return;
    const cfg = this.local();
    const root = worktreeRootOf(cfg);
    if (!existsSync(root)) return;
    for (const [projectId, repo] of Object.entries(this.repos())) {
      for (const group of readdirSync(root)) {
        if (!group.endsWith(projectId.slice(2, 8))) continue;
        for (const taskId of readdirSync(join(root, group))) {
          if (!taskId.startsWith('t-') || this.active.has(taskId)) continue;
          const path = join(root, group, taskId);
          if (!isLinkedWorktreeOf(path, repo)) continue;
          const t = await this.client['task.peek']({ id: taskId }).catch(() => null);
          // Only the exact commit acknowledged by the hub can be discarded. Detached work, locks,
          // new commits and nonterminal tasks are preserved, including their build/setup artifacts.
          if (!t || t.status !== 'done' || !t.head_sha || t.branch !== `yardmaster/${taskId}`) continue;
          const entry = (await listWorktrees(repo)).find((w) => w.path === path);
          if (!entry || entry.locked || entry.prunable || entry.branch !== t.branch || entry.head !== t.head_sha) continue;
          if (!(await isClean(path))) continue;
          const current = await this.client['task.peek']({ id: taskId }).catch(() => null);
          if (!current || current.status !== 'done' || current.generation !== t.generation || current.head_sha !== t.head_sha ||
              current.branch !== t.branch || this.active.has(taskId)) continue;
          const latest = (await listWorktrees(repo)).find((w) => w.path === path);
          if (!latest || latest.locked || latest.prunable || latest.branch !== t.branch || latest.head !== t.head_sha ||
              !isLinkedWorktreeOf(path, repo) || !(await isClean(path)) || this.active.has(taskId)) continue;
          // Git's own worktree removal honors locks; bypassing it via the fast path would lose that guard.
          const removed = await git(repo, ['worktree', 'remove', path], { allowFail: true });
          if (removed.code !== 0) continue;
          // Compare-and-delete: a branch advanced during removal must survive.
          await git(repo, ['update-ref', '-d', `refs/heads/${t.branch}`, t.head_sha], { allowFail: true });
        }
      }
    }
  }

  async tick(): Promise<void> {
    if (this.claiming || this.stopped) return;
    this.claiming = true;
    try {
      while (!this.stopped && (await this.hasCapacity())) {
        const runningByAgent: Record<string, number> = {};
        for (const a of this.active.values()) runningByAgent[a.agent] = (runningByAgent[a.agent] ?? 0) + 1;
        const claim = await this.client['worker.claim']({ machineId: this.machineId, agents: this.agents(), repos: this.repos(), runningByAgent, activeTaskIds: [...this.active.keys()] });
        if (!claim) break;
        if (this.stopped) {
          // A shutdown may have happened while the hub was handing us this claim, before an active entry existed.
          await this.client['task.update']({ id: claim.task.id,
            owner: { generation: claim.task.generation, attempt: claim.task.attempts, assignee: claim.task.assignee ?? '', statuses: ['running'] },
            patch: { status: 'queued', attempts: Math.max(0, claim.task.attempts - 1), assignee: null, machine_id: null, lease_until: null },
          });
          break;
        }
        this.launch(claim);
      }
    } finally {
      this.claiming = false;
    }
  }

  private launch(claim: NonNullable<Awaited<ReturnType<Client['worker.claim']>>>): void {
    const { task, project, route } = claim;
    const entry: Active = { task, agent: route.agent };
    let pendingStop: { reason: StopReason; message: string } | null = null;
    entry.stop = (reason, message) => { pendingStop = { reason, message }; };
    this.active.set(task.id, entry);
    const local = this.local();
    const config = resolveConfig([claim.config, { agents: deepMerge(claim.config.agents, local.agents), worktreeRoot: local.worktreeRoot, effortRouting: local.effortRouting }]);
    const repoPath = this.repos()[project.id]!;
    void (async () => {
      try {
        if (!claim.startPoint) throw new Error('The hub could not provide a starting commit.');
        if (this.transport && !(await revParse(repoPath, claim.startPoint))) await this.transport.fetchBase(project, repoPath, claim.startPoint);
        const outcome = await runAttempt({
          api: this.client, machineId: this.machineId, task, project, repoPath, agent: route.agent, model: route.model, config,
          startPoint: claim.startPoint, verifySlots: this.verifySlots, onSpawn: (stop) => {
            entry.stop = stop;
            if (pendingStop) stop(pendingStop.reason, pendingStop.message);
          }, installed: this.agents(), reserveAgent: (agent, signal) => {
            let slots = this.agentSlots.get(agent);
            if (!slots) { slots = new Semaphore(agentSettings(config, agent).maxParallel); this.agentSlots.set(agent, slots); }
            return slots.acquire(signal);
          },
        });
        if (outcome.status === 'ready' && this.transport) {
          const fresh = (await this.client['task.get']({ id: task.id })).task;
          if (fresh.generation !== task.generation || fresh.assignee !== task.assignee || fresh.status !== 'ready') throw new Error('This attempt no longer owns the task before upload.');
          // Retain the original claim identity; never lend a stale worker the new owner's generation.
          const accepted = await this.transport.uploadBranch({ ...fresh, generation: task.generation }, repoPath, fresh.branch!, fresh.base_sha ?? claim.startPoint);
          if (accepted.head !== fresh.head_sha) throw new Error('Hub did not acknowledge the accepted commit.');
        }
      } catch (err) {
        // Fenced: if the task was taken over elsewhere meanwhile, this stale error must not overwrite it.
        await this.client['task.update']({ id: task.id, owner: { generation: task.generation, attempt: task.attempts, assignee: task.assignee ?? '', statuses: ['running', 'verifying', 'ready'] }, patch: { status: 'needs_human', attention: `This machine (${this.name}) hit an error: ${(err as Error).message}`, lease_until: null } }).catch(() => undefined);
        await this.client['task.event']({ projectId: task.project_id, taskId: task.id, level: 'error', kind: 'worker.error', message: `${this.name}: ${(err as Error).message}` }).catch(() => undefined);
      } finally {
        this.active.delete(task.id);
        void this.tick();
      }
    })();
  }

  stopAll(reason: StopReason, message: string): void {
    this.stopped = true;
    for (const a of this.active.values()) a.stop?.(reason, message);
  }

  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }
}
