import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Client } from './api.ts';
import { paths } from './paths.ts';
import { terminateRecordedProcess } from './proc.ts';
import { applyUtilityOperation, type UtilityRecord } from './utility-records.ts';
import { acquireHubLock, holdsHubLock } from './hublock.ts';
import { normalizeHubUrl } from './fleet-client.ts';

type Usage = Parameters<Client['run.usage']>[0];
type Exit = Parameters<Client['run.exit']>[0];
type Owner = NonNullable<Parameters<Client['run.start']>[0]['owner']>;
export interface JournalRun {
  runId: string; taskId: string; owner: Owner; worktree: string | null;
  pid: number | null; startedAt: number | null; phase?: string | null; recoveryError?: string; usage?: Usage; exit?: Exit;
  reapedProcess?: { pid: number; startedAt: number };
  idlePhase?: string;
  utilities?: UtilityRecord[];
}
export interface JournalArtifact {
  taskId: string; generation: number; assignee: string; repo: string; branch: string; base: string; head: string;
  uploaded: boolean; retired?: boolean; failures: number; retryAt: number; error?: string;
}
export interface JournalChannel { hub: string; projectIds: string[] }

/** One private, synchronous write-ahead record. Never reconstruct process ownership from task status. */
export class WorkerJournal {
  private readonly file: string;
  readonly runs: Record<string, JournalRun>;
  readonly artifacts: Record<string, JournalArtifact>;
  readonly machineId: string;
  private readonly channel: JournalChannel | null;
  private readonly key: string | null;
  private readonly legacy: string;
  private unlock: (() => void) | null = null;
  private acquiring: Promise<void> | null = null;
  constructor(machineId: string, channel?: JournalChannel) {
    this.machineId = machineId;
    this.channel = channel ? { hub: normalizeHubUrl(channel.hub, { privateNetwork: true }), projectIds: [...new Set(channel.projectIds)].sort() } : null;
    if (this.channel && !this.channel.projectIds.length) throw new Error('Worker recovery needs a non-empty project scope.');
    this.key = this.channel ? createHash('sha256').update(JSON.stringify([machineId, this.channel])).digest('hex') : null;
    this.legacy = join(paths.home(), `worker-${createHash('sha256').update(machineId).digest('hex').slice(0, 20)}.json`);
    this.file = this.key ? join(paths.home(), `worker-${this.key}.json`) : this.legacy;
    const value = this.read();
    this.runs = value.runs;
    this.artifacts = value.artifacts;
  }
  private read(): { runs: Record<string, JournalRun>; artifacts: Record<string, JournalArtifact> } {
    const value = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: this.channel ? 2 : 1, machineId: this.machineId, channel: this.channel, runs: {}, artifacts: {} };
    if (value.version !== (this.channel ? 2 : 1) || value.machineId !== this.machineId || !value.runs || !value.artifacts || (this.channel && JSON.stringify(value.channel) !== JSON.stringify(this.channel))) throw new Error(`Invalid worker recovery journal: ${this.file}`);
    return value;
  }
  assertScope(projectIds: string[]): void {
    if (!this.channel || JSON.stringify([...new Set(projectIds)].sort()) !== JSON.stringify(this.channel.projectIds)) throw new Error('Restart the worker to change its hub/project recovery scope.');
  }
  async acquire(client?: Client, opts: { adoptLegacy?: boolean } = {}): Promise<void> {
    if (!this.channel) throw new Error(`Legacy machine-wide journal is read-only: ${this.legacy}. Start a scoped worker to recover it.`);
    if (this.unlock) { this.assertWriter(); return; }
    if (this.acquiring) return this.acquiring;
    this.acquiring = (async () => {
      try { this.unlock = await acquireHubLock(`${this.file}.lock`); }
      catch (error) { throw new Error(`Worker channel already has a live writer or recovery owner: ${(error as Error).message}`); }
      try {
        // Load only after taking the lease: an object constructed earlier may contain stale maps.
        const value = this.read();
        for (const key of Object.keys(this.runs)) delete this.runs[key];
        for (const key of Object.keys(this.artifacts)) delete this.artifacts[key];
        Object.assign(this.runs, value.runs); Object.assign(this.artifacts, value.artifacts);
        if (existsSync(this.legacy)) {
          const legacy = JSON.parse(readFileSync(this.legacy, 'utf8'));
          if (Object.keys(legacy.runs ?? {}).length || Object.keys(legacy.artifacts ?? {}).length) {
            if (!opts.adoptLegacy || !client) throw new Error(`Legacy journal preserved at ${this.legacy}. Stop all older workers, then use an owner channel with --adopt-legacy-journal and every affected --repo. No process was signaled.`);
            const releaseLegacy = await acquireHubLock(`${this.legacy}.migration.lock`);
            try {
              const old = JSON.parse(readFileSync(this.legacy, 'utf8'));
              if (old.version !== 1 || old.machineId !== this.machineId || !old.runs || !old.artifacts) throw new Error('Invalid legacy journal; preserved for inspection.');
              const ids = new Set<string>([...Object.values(old.runs as Record<string, JournalRun>).map(r => r.taskId), ...Object.keys(old.artifacts)]);
              for (const id of ids) {
                const detail = await client['task.get']({ id });
                if (!this.channel!.projectIds.includes(detail.task.project_id)) throw new Error('Legacy journal includes another project; use an owner channel with all affected repos.');
                if (detail.task.lease_until && detail.task.lease_until > Date.now() && ['running', 'verifying'].includes(detail.task.status)) throw new Error('Legacy task lease is still active. Stop older workers and wait for lease expiry before adoption.');
                for (const run of Object.values(old.runs as Record<string, JournalRun>).filter(r => r.taskId === id)) {
                  if (!detail.runs.some(r => r.id === run.runId && r.generation === run.owner.generation && r.machine_id === this.machineId)) throw new Error('Legacy run identity was not confirmed by this hub; journal preserved.');
                }
              }
              const present = { runs: this.runs, artifacts: this.artifacts };
              const incoming = { runs: old.runs, artifacts: old.artifacts };
              if ((Object.keys(this.runs).length || Object.keys(this.artifacts).length) && JSON.stringify(present) !== JSON.stringify(incoming)) throw new Error('Scoped and legacy journals differ; both are preserved for explicit resolution.');
              Object.assign(this.runs, old.runs); Object.assign(this.artifacts, old.artifacts); this.save();
              // Preserve the original bytes as an adoption receipt; never discard legacy identities.
              renameSync(this.legacy, `${this.legacy}.adopted-${this.key}`);
            } finally { releaseLegacy(); }
          }
        }
        this.save();
      } catch (error) { this.release(); throw error; }
    })();
    try { await this.acquiring; } finally { this.acquiring = null; }
  }
  release(): void { this.unlock?.(); this.unlock = null; }
  private assertWriter(): void {
    if (!this.channel || !this.unlock || !holdsHubLock(`${this.file}.lock`)) throw new Error('Worker journal has no exclusive channel writer lease.');
  }
  save(): void {
    this.assertWriter();
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 2, machineId: this.machineId, channel: this.channel, runs: this.runs, artifacts: this.artifacts })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
    const dir = openSync(paths.home(), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  accepted(taskId: string, generation: number): JournalArtifact | undefined {
    const artifact = this.artifacts[taskId];
    return artifact?.generation === generation && artifact.assignee === `machine:${this.machineId}` ? artifact : undefined;
  }
  /** Record PID identity before the remote registration; retain usage/exit until acknowledgment. */
  wrap(client: Client, artifactContext?: { repo: string; branch: string; base: string }): Client {
    const tracked = new Proxy(client, { get: (target, key: keyof Client) => {
      if (key === 'run.start') return async (p: Parameters<Client['run.start']>[0]) => {
        const runId = await target[key](p);
        if (!p.owner) throw new Error('Worker journal needs the fenced run owner.');
        const phase = p.role === 'review' ? 'review_wait' : 'prepare';
        this.runs[runId] = { runId, taskId: p.taskId, owner: p.owner, worktree: null, pid: null, startedAt: null, phase, idlePhase: phase };
        this.save();
        return runId;
      };
      if (key === 'run.update') return async (p: Parameters<Client['run.update']>[0]) => {
        const record = this.runs[p.runId];
        if (record && ('pid' in p.patch || 'phase' in p.patch)) {
          if ('phase' in p.patch) record.phase = typeof p.patch.phase === 'string' ? p.patch.phase : null;
          if ('pid' in p.patch) {
            if (p.patch.pid === null && record.pid !== null && record.startedAt !== null) record.reapedProcess = { pid: record.pid, startedAt: record.startedAt };
            record.pid = typeof p.patch.pid === 'number' ? p.patch.pid : null;
            record.startedAt = typeof p.patch.proc_started === 'number' ? p.patch.proc_started : null;
          }
          if (record.pid === null && record.phase && !record.phase.endsWith(':spawning')) record.idlePhase = record.phase;
          this.save();
        }
        return target[key](p);
      };
      if (key === 'task.update') return async (p: Parameters<Client['task.update']>[0]) => {
        if (artifactContext) {
          if (typeof p.patch.branch === 'string') artifactContext.branch = p.patch.branch;
          if (typeof p.patch.base_sha === 'string') artifactContext.base = p.patch.base_sha;
          if (p.patch.status === 'ready' && typeof p.patch.head_sha === 'string' && p.owner?.generation && p.owner.assignee) {
            this.artifacts[p.id] = { taskId: p.id, generation: p.owner.generation, assignee: p.owner.assignee, ...artifactContext, head: p.patch.head_sha, uploaded: false, failures: 0, retryAt: 0 };
            this.save();
          }
        }
        if (typeof p.patch.worktree === 'string') {
          for (const record of Object.values(this.runs)) if (record.taskId === p.id && record.owner.generation === p.owner?.generation) record.worktree = p.patch.worktree;
          this.save();
        }
        return target[key](p);
      };
      if (key === 'run.usage') return async (p: Usage) => {
        const record = this.runs[p.runId];
        if (!record) throw new Error('Run missing from worker recovery journal.');
        if (!record.usage || p.sequence > record.usage.sequence) { record.usage = p; this.save(); }
        try {
          await target[key](p);
          if (record.usage?.sequence === p.sequence) { delete record.usage; this.save(); }
        } catch { /* Durable absolute snapshot is replayed, including after process exit. */ }
      };
      if (key === 'run.utility') return async (p: Parameters<Client['run.utility']>[0]) => {
        const record = this.runs[p.runId];
        if (!record) throw new Error('Utility has no durable worker run.');
        record.utilities = applyUtilityOperation(record.utilities ?? [], p.operation);
        this.save();
        return target[key](p);
      };
      if (key === 'run.exit') return async (p: Exit) => {
        const record = this.runs[p.runId];
        if (!record) return target[key](p);
        // Retain the identity until the hub acknowledges it. A dropped response or an expired
        // lease must not turn confirmed reaping into an unrecoverable proof-less exit.
        record.exit = p; this.save();
        await this.replayRun(target, record);
      };
      return target[key];
    } });
    return new Proxy(tracked, { get: (target, key: keyof Client) => {
      const fn = target[key];
      return typeof fn === 'function' ? async (params: unknown) => {
        await this.acquire(client);
        return (fn as (p: unknown) => Promise<unknown>)(params);
      } : fn;
    } });
  }
  private async replayRun(client: Client, record: JournalRun): Promise<void> {
    for (const utility of record.utilities ?? []) {
      if (utility.state !== 'exited') throw new Error('Worker utility still requires recovery.');
      await client['run.utility']({ runId: record.runId, taskId: record.taskId, owner: record.owner,
        operation: { action: 'exit', token: utility.token, pid: utility.pid, startedAt: utility.startedAt, reaped: true } });
    }
    if (record.usage) {
      const snapshot = record.usage;
      await client['run.usage'](snapshot);
      if (record.usage?.sequence === snapshot.sequence) { delete record.usage; this.save(); }
    }
    if (record.exit) {
      if (!record.exit.process && !record.exit.noLaunchPhase) {
        const detail = await client['task.get']({ id: record.taskId });
        const run = detail.runs.find(r => r.id === record.runId && r.generation === record.owner.generation && r.machine_id === this.machineId);
        const identity = record.pid !== null && record.startedAt !== null ? { pid: record.pid, startedAt: record.startedAt } : record.reapedProcess;
        if (identity && run?.pid === identity.pid && run.proc_started === identity.startedAt) record.exit = { ...record.exit, process: identity };
        else if (record.pid === null && record.idlePhase && run?.pid === null && run.phase === record.idlePhase) record.exit = { ...record.exit, noLaunchPhase: record.idlePhase };
        this.save();
      }
      await client['run.exit'](record.exit);
      // No await between checking and deleting: no newer snapshot can be discarded.
      if (!record.usage) { delete this.runs[record.runId]; this.save(); }
    }
  }
  /** Must finish before first claim. Unknown/recycled identities remain held and are never signaled. */
  async recover(client: Client, activeTaskIds = new Set<string>()): Promise<Set<string>> {
    await this.acquire(client);
    const held = new Set<string>();
    for (const record of Object.values(this.runs)) {
      if (activeTaskIds.has(record.taskId)) continue;
      const detail = await client['task.get']({ id: record.taskId }).catch(() => null);
      if (!detail || !this.channel!.projectIds.includes(detail.task.project_id) || !detail.runs.some(run => run.id === record.runId && run.generation === record.owner.generation && run.machine_id === this.machineId)) {
        held.add(record.taskId); continue; // Lost access is never permission to signal a process.
      }
      const attested = detail?.runs.find(run => run.id === record.runId && run.generation === record.owner.generation && run.machine_id === this.machineId && run.status === 'stopped' && run.pid === null && run.stop_reason?.startsWith('Owner ') && run.stop_reason.includes('attested stopped:'));
      let utilitiesHeld = false;
      for (const utility of record.utilities ?? []) {
        if (utility.state === 'exited') continue;
        if (utility.pid === null) {
          if (attested) { utility.state = 'exited'; this.save(); }
          else utilitiesHeld = true;
          continue;
        }
        const proof = await terminateRecordedProcess({ pid: utility.pid, startedAt: utility.startedAt });
        if (!['exited', 'terminated'].includes(proof.status)) { utilitiesHeld = true; continue; }
        utility.state = 'exited'; this.save();
      }
      if (record.pid === null && record.phase?.endsWith(':spawning') && !attested) { held.add(record.taskId); continue; }
      if (record.pid !== null) {
        const identity = { pid: record.pid, startedAt: record.startedAt };
        const result = await terminateRecordedProcess({ pid: record.pid, startedAt: record.startedAt });
        if (!['exited', 'terminated'].includes(result.status)) {
          held.add(record.taskId);
          record.recoveryError = result.reason ?? 'Process identity could not be verified'; this.save();
          await client['run.update']({ runId: record.runId, owner: record.owner, patch: { status: 'cleanup_failed', stop_reason: record.recoveryError } }).catch(() => undefined);
          continue;
        }
        record.exit = { runId: record.runId, taskId: record.taskId, owner: record.owner, reaped: true, ...(identity.startedAt !== null ? { process: { pid: identity.pid, startedAt: identity.startedAt } } : {}) };
        record.pid = null; record.startedAt = null; record.phase = null;
      }
      // An owner attestation clears the hub hold, never a local recorded identity.
      // Only after checking every identity above may the returning worker retire it.
      if (attested) {
        record.phase = null;
        record.exit = { runId: record.runId, taskId: record.taskId, owner: record.owner, reaped: true };
      }
      record.exit ??= { runId: record.runId, taskId: record.taskId, owner: record.owner, reaped: true,
        ...(record.phase && !record.phase.endsWith(':spawning') ? { noLaunchPhase: record.phase } : {}) };
      this.save();
      if (utilitiesHeld) { held.add(record.taskId); continue; }
      try { await this.replayRun(client, record); } catch { held.add(record.taskId); }
    }
    return held;
  }
}
