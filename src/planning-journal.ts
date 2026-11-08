import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import type { Client } from './api.ts';
import { normalizeHubUrl } from './fleet-client.ts';
import { paths } from './paths.ts';
import { isAlive, processStartTime } from './proc.ts';

const Identity = z.object({ pid: z.number().int().positive(), startedAt: z.number().finite().positive() });
const Usage = z.object({ costUsd: z.number().finite().nonnegative(), tokensIn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tokensOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  provenance: z.enum(['actual', 'estimated', 'mixed', 'unknown']), cacheReadTokens: z.number().int().nonnegative().nullable(), cacheWriteTokens: z.number().int().nonnegative().nullable() });
const Receipt = z.object({
  version: z.literal(1), hub: z.string(), machineId: z.string().min(1), projectId: z.string().min(1), runId: z.string().min(1), owner: Identity,
  phase: z.enum(['plan', 'plan:spawning']), process: Identity.nullable(),
  snapshot: z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), usage: Usage, final: z.boolean() }).optional(),
  outcome: z.object({ reaped: z.boolean(), succeeded: z.boolean(), reason: z.string(), process: Identity.optional(), noLaunchPhase: z.string().optional(),
    spawnFailure: z.object({ status: z.literal('spawn_failed'), pid: z.null() }).optional() }).optional(),
});
type ReceiptValue = z.infer<typeof Receipt>;
type Finish = Omit<Parameters<Client['plan.finish']>[0], 'runId'>;

/** Local RPC and direct DB access share the same logical hub even when a listener's port changes. */
export function normalizePlanningHub(input: string): string {
  if (typeof input === 'string' && input.startsWith('local:')) {
    const file = input.slice(6);
    if (!isAbsolute(file) || file.includes('\0')) throw new Error('Local planning hub identity requires an absolute database path.');
    return `local:${resolve(file)}`;
  }
  return normalizeHubUrl(input, { privateNetwork: true });
}

function checkPrivate(path: string, directory: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`Unsafe planning receipt path: ${path}`);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(): string {
  const home = paths.home();
  checkPrivate(home, true);
  const dir = join(home, 'planning-receipts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkPrivate(dir, true);
  syncDirectory(home);
  return dir;
}
function name(value: Pick<ReceiptValue, 'hub' | 'machineId' | 'projectId' | 'runId'>): string {
  return `${createHash('sha256').update(JSON.stringify([value.hub, value.machineId, value.projectId, value.runId])).digest('hex')}.json`;
}

/** One private write-ahead receipt per planning invocation. No prompts, output, or credentials. */
export class PlanningJournal {
  private readonly file: string;
  private readonly dir: string;
  readonly value: ReceiptValue;
  constructor(value: Omit<ReceiptValue, 'version' | 'phase' | 'process'>, existing?: { dir: string; file: string; value: ReceiptValue }) {
    this.dir = existing?.dir ?? directory();
    this.value = existing?.value ?? { ...value, hub: normalizePlanningHub(value.hub), version: 1, phase: 'plan', process: null };
    this.file = existing?.file ?? join(this.dir, name(this.value));
    if (!existing) this.save();
  }
  private save(): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(Receipt.parse(this.value))); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      syncDirectory(this.dir);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  spawning(): void { this.value.phase = 'plan:spawning'; this.save(); }
  spawned(process: z.infer<typeof Identity>): void { this.value.process = process; this.save(); }
  snapshot(usage: Parameters<Client['plan.usage']>[0]['usage']): void {
    this.value.snapshot = { sequence: (this.value.snapshot?.sequence ?? 0) + 1, usage, final: false };
    this.save();
  }
  complete(usage: Parameters<Client['plan.usage']>[0]['usage'], outcome: Finish): void {
    this.value.snapshot = { sequence: (this.value.snapshot?.sequence ?? 0) + 1, usage, final: true };
    this.value.outcome = { ...outcome, reason: outcome.reason ?? '' };
    this.save();
  }
  outcome(outcome: Finish): void { this.value.outcome = { ...outcome, reason: outcome.reason ?? '' }; this.save(); }
  async sendUsage(client: Client): Promise<void> {
    const snapshot = this.value.snapshot;
    if (snapshot) await client['plan.usage']({ runId: this.value.runId, ...snapshot });
  }
  /** Never discard the final snapshot until finish is acknowledged; either acknowledgment can be lost. */
  async replay(client: Client): Promise<boolean> {
    await this.sendUsage(client);
    if (!this.value.outcome || (!this.value.snapshot?.final && !this.value.outcome.noLaunchPhase && !this.value.outcome.spawnFailure)) return false;
    await client['plan.finish']({ runId: this.value.runId, ...this.value.outcome });
    if (!this.value.outcome.reaped) return false;
    try { unlinkSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    syncDirectory(this.dir);
    return true;
  }
  static read(dir: string, file: string): PlanningJournal {
    checkPrivate(file, false);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: ReceiptValue;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || st.size > 1024 * 1024) throw new Error('Unsafe planning receipt.');
      value = Receipt.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } finally { closeSync(fd); }
    if (normalizePlanningHub(value.hub) !== value.hub || file !== join(dir, name(value))) throw new Error('Planning receipt scope does not match its file.');
    return new PlanningJournal(value, { dir, file, value });
  }
}

/** Run before process recovery. No process is signaled, and live or unverifiable CLI owners are skipped. */
export async function recoverPlanningReceipts(client: Client, opts: { hub: string; machineId: string }): Promise<{ replayed: string[]; pending: { runId: string; reason: string }[]; skippedLive: string[] }> {
  const hub = normalizePlanningHub(opts.hub);
  const dir = directory();
  const result: { replayed: string[]; pending: { runId: string; reason: string }[]; skippedLive: string[] } = { replayed: [], pending: [], skippedLive: [] };
  for (const entry of readdirSync(dir).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
    let journal: PlanningJournal;
    try { journal = PlanningJournal.read(dir, join(dir, entry)); }
    catch (error) { result.pending.push({ runId: entry, reason: `Receipt preserved: ${(error as Error).message}` }); continue; }
    const receipt = journal.value;
    if (receipt.hub !== hub || receipt.machineId !== opts.machineId) continue;
    if (isAlive(receipt.owner.pid)) {
      const actual = await processStartTime(receipt.owner.pid);
      if (actual === null || actual === receipt.owner.startedAt) { result.skippedLive.push(receipt.runId); continue; }
    }
    try {
      // Spawn intent is durable before launch. An untouched initial receipt proves no inference ran.
      if (!receipt.outcome && receipt.phase === 'plan' && receipt.process === null && !receipt.snapshot) {
        journal.outcome({ reaped: true, succeeded: false, reason: 'Planning invocation exited before launch.', noLaunchPhase: 'plan' });
      }
      if (await journal.replay(client)) result.replayed.push(receipt.runId);
      else result.pending.push({ runId: receipt.runId, reason: receipt.snapshot?.final ? 'Final accounting replayed; process exit remains unconfirmed.' : 'No final accounting receipt; latest measured usage replayed, allowance remains held.' });
    } catch (error) { result.pending.push({ runId: receipt.runId, reason: `Receipt preserved: ${(error as Error).message}` }); }
  }
  return result;
}
