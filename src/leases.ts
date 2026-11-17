import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { openDb, tx, type Db } from './db.ts';
import { machineId } from './paths.ts';
import { readFileSync } from 'node:fs';
import { isAlive, processStartTime, run, terminateRecordedProcess } from './proc.ts';

const RETAIN_RETRY_MS = 3000;

/**
 * Machine-wide leases for scarce, heavy resources: build slots, simulators and physical devices. Rows live in the
 * machine's own Yardmaster database, so every hub, worker and CLI process sharing YARDMASTER_HOME (any project)
 * coordinates through them, and they survive restarts. A lease records the resources Yardmaster created for it;
 * cleanup only ever touches those. Simulators and devices Yardmaster did not create are never leased-and-reset.
 */
export const LEASE_POOLS = ['build', 'simulator', 'physical'] as const;
export type LeasePool = typeof LEASE_POOLS[number];
export type LeaseState = 'waiting' | 'held' | 'reaping' | 'cleanup_failed';

export const SimulatorResourceSchema = z.object({
  kind: z.literal('simulator'),
  /** Unique name chosen before creation, so a crash between create and record can still be found. */
  name: z.string().regex(/^ym-[a-z0-9-]{6,80}$/),
  udid: z.string().regex(/^[0-9A-F-]{36}$/i).nullable(),
});
/** A command run under the lease that could not be confirmed stopped: the slot stays held until it is. */
export const ProcessResourceSchema = z.object({
  kind: z.literal('process'),
  pid: z.number().int().positive(),
  startedAt: z.number().nullable(),
});
/**
 * A physical device in use under a lease, by its hashed key (never the raw UDID). Nothing is created on it, so there
 * is nothing to clean; the record keeps two leases in a pool with room for several phones off the same phone.
 */
export const DeviceResourceSchema = z.object({
  kind: z.literal('device'),
  key: z.string().regex(/^d-[a-f0-9]{20}$/),
});
export const OwnedResourceSchema = z.discriminatedUnion('kind', [SimulatorResourceSchema, ProcessResourceSchema, DeviceResourceSchema]);
export type OwnedResource = z.infer<typeof OwnedResourceSchema>;
export type SimulatorResource = z.infer<typeof SimulatorResourceSchema>;
export type ProcessResource = z.infer<typeof ProcessResourceSchema>;
export type DeviceResource = z.infer<typeof DeviceResourceSchema>;
export const describeOwned = (o: OwnedResource) => o.kind === 'simulator' ? `${o.name}${o.udid ? ` ${o.udid}` : ''}` : o.kind === 'device' ? `device ${o.key}` : `process ${o.pid}`;
const sameResource = (a: OwnedResource, b: OwnedResource) => a.kind === b.kind && (a.kind === 'simulator' ? a.name === (b as SimulatorResource).name
  : a.kind === 'device' ? a.key === (b as DeviceResource).key : a.pid === (b as ProcessResource).pid);

export interface Lease {
  id: string; pool: LeasePool; state: LeaseState; holder: string;
  projectId: string | null; taskId: string | null; requestId: string | null;
  host: string; pid: number; procStarted: number | null;
  queuedAt: number; acquiredAt: number | null; expiresAt: number;
  owned: OwnedResource[]; note: string | null;
  /** Boot the holder ran in; null on rows written before boot identity was recorded. */
  bootId: string | null;
}
interface Row {
  id: string; pool: string; state: string; holder: string; project_id: string | null; task_id: string | null; request_id: string | null;
  host: string; pid: number; proc_started: number | null; queued_at: number; acquired_at: number | null; expires_at: number; owned: string; note: string | null;
  boot_id: string | null;
}

const toLease = (r: Row): Lease => ({ id: r.id, pool: r.pool as LeasePool, state: r.state as LeaseState, holder: r.holder,
  projectId: r.project_id, taskId: r.task_id, requestId: r.request_id, host: r.host, pid: r.pid, procStarted: r.proc_started,
  queuedAt: r.queued_at, acquiredAt: r.acquired_at, expiresAt: r.expires_at, owned: z.array(OwnedResourceSchema).parse(JSON.parse(r.owned)), note: r.note, bootId: r.boot_id });

export function listLeases(db: Db, pool?: LeasePool): Lease[] {
  const rows = (pool ? db.prepare('SELECT * FROM resource_leases WHERE pool = ? ORDER BY queued_at, id').all(pool)
    : db.prepare('SELECT * FROM resource_leases ORDER BY pool, queued_at, id').all()) as unknown as Row[];
  return rows.map(toLease);
}

/** Opened per operation: leases are shared with other processes, never cached in memory. */
function withDb<T>(fn: (db: Db) => T): T {
  const db = openDb();
  try { return fn(db); } finally { db.close(); }
}

export interface ProcessId { pid: number; startedAt: number | null; bootId: string | null }

/** Identifies the current boot, so a PID recorded before a reboot can never match a process after it. */
async function readBootId(): Promise<string | null> {
  if (process.platform === 'linux') {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
  }
  if (process.platform === 'darwin') {
    const r = await run('sysctl', ['-n', 'kern.boottime'], { timeoutMs: 5000 }).catch(() => null);
    const sec = r?.code === 0 ? r.stdout.match(/sec\s*=\s*(\d+)/)?.[1] : undefined;
    return sec ? `darwin-boot-${sec}` : null;
  }
  return null;
}
let boot: Promise<string | null> | null = null;
export function bootId(): Promise<string | null> {
  boot ??= readBootId();
  return boot;
}

/**
 * Linux process start from /proc (no ps needed, so minimal containers work): field 22 of /proc/<pid>/stat is the
 * start in clock ticks after boot, and /proc/stat's btime is the boot in epoch seconds. The kernel reports /proc
 * times in USER_HZ, which is 100 on every Linux architecture.
 */
export function procStartMs(stat: string, bootSeconds: number): number | null {
  // The command name (field 2) is parenthesized and may itself contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) && Number.isFinite(bootSeconds) ? Math.round(bootSeconds * 1000 + ticks * 10) : null;
}

async function startTime(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const boot = Number(readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
      const fromProc = procStartMs(readFileSync(`/proc/${pid}/stat`, 'utf8'), boot);
      if (fromProc !== null) return fromProc;
    } catch { /* fall back to ps */ }
  }
  return processStartTime(pid).catch(() => null);
}

let self: ProcessId | null = null;
/**
 * This process's identity as a lease holder. A lease is never granted without a readable start time: a row with no
 * start identity could later be matched by any process that reuses the PID. Retried, since one ps can miss a deadline.
 */
export async function selfIdentity(): Promise<ProcessId> {
  if (self) return self;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = await startTime(process.pid);
    if (startedAt !== null) return self = { pid: process.pid, startedAt, bootId: await bootId() };
    await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw new Error('Cannot read this process\'s start time, so it cannot hold a device lease safely. Check that ps works, then retry.');
}

/** A holder is dead when it ran in another boot, its PID is gone, or the PID now belongs to a later process. */
export async function holderAlive(lease: Pick<Lease, 'pid' | 'procStarted' | 'bootId'>): Promise<boolean> {
  const currentBoot = await bootId();
  if (lease.bootId && currentBoot && lease.bootId !== currentBoot) return false;
  if (!isAlive(lease.pid)) return false;
  // This process is alive by definition; skip the start-time lookup (waiters poll this often).
  if (lease.pid === self?.pid && lease.procStarted === self.startedAt) return true;
  // Unverifiable (rows from before start identity was required): never presumed dead; see recoverStaleLease.
  if (lease.procStarted === null) return true;
  const now = await startTime(lease.pid);
  return now === null || Math.abs(now - lease.procStarted) <= 2000;
}

/** Cleans simulators; processes recorded on a lease are confirmed by cleanupOwned before it is called. */
export type ResourceCleanup = (owned: SimulatorResource[]) => Promise<{ ok: boolean; detail: string }>;

/**
 * Recorded processes first, by identity-checked termination (pid plus start time, so a reused PID is never
 * signaled). Simulators are cleaned only once every recorded process is confirmed gone, and the slot is freed
 * only when both succeed: an unconfirmed process may still be writing the same build output or using the device.
 */
async function cleanupOwned(owned: OwnedResource[], cleanup: ResourceCleanup): Promise<{ ok: boolean; detail: string }> {
  const problems: string[] = [];
  for (const proc of owned.filter((o): o is ProcessResource => o.kind === 'process')) {
    const r = await terminateRecordedProcess({ pid: proc.pid, startedAt: proc.startedAt });
    if (r.status !== 'exited' && r.status !== 'terminated') problems.push(`process ${proc.pid} not confirmed stopped (${r.status}${r.reason ? `: ${r.reason}` : ''})`);
  }
  if (problems.length) return { ok: false, detail: problems.join('; ') };
  const sims = owned.filter((o): o is SimulatorResource => o.kind === 'simulator');
  if (!sims.length) return { ok: true, detail: owned.some(o => o.kind === 'process') ? 'recorded processes confirmed stopped' : 'nothing to clean' };
  return cleanup(sims).catch((error: Error) => ({ ok: false, detail: error.message }));
}
export interface ReapResult { id: string; pool: LeasePool; holder: string; outcome: 'expired-waiter' | 'released' | 'cleanup_failed'; detail: string }

/**
 * Frees leases whose holder process is gone. Their recorded resources are cleaned first; a failed
 * cleanup keeps the slot occupied and visible (`cleanup_failed`) rather than letting new work double-book it.
 */
export async function reapLeases(cleanup: ResourceCleanup, now = Date.now()): Promise<ReapResult[]> {
  const candidates = withDb(db => listLeases(db)).filter(l => l.host === machineId());
  // Nothing to reap needs no identity: a machine that cannot read process start times can still run without leases.
  if (!candidates.length) return [];
  // The dead holder as inspected. Another reaper may claim the row meanwhile; then it is no longer this holder's.
  const crashed = new Map<string, string>();
  const identity = (l: Lease) => `${l.state}:${l.pid}:${l.procStarted}`;
  for (const lease of candidates) if (!(await holderAlive(lease))) crashed.set(lease.id, identity(lease));
  const results: ReapResult[] = [];
  const me = await selfIdentity();
  // Expiry alone never frees capacity a live process holds: a stalled holder may still be building or testing.
  // Only a dead holder's slot is reclaimed. A queued waiter holds nothing and may expire; a live holder's
  // failed cleanup is retried after its expiry because that holder already gave the slot up.
  const reapable = (l: Lease) => crashed.get(l.id) === identity(l) || (l.expiresAt < now && (l.state === 'waiting' || l.state === 'cleanup_failed'));
  // Recheck inside the transaction: a holder may have renewed, or another reaper claimed it, since it was read.
  const claimed = withDb(db => tx(db, () => listLeases(db).filter(l => l.host === machineId() && reapable(l)).flatMap(lease => {
    if (lease.state === 'waiting') {
      db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'waiting'").run(lease.id);
      results.push({ id: lease.id, pool: lease.pool, holder: lease.holder, outcome: 'expired-waiter', detail: 'queued request stopped waiting' });
      return [];
    }
    // Claim before cleaning so two reapers never clean the same resources; a crashed reaper is detected like any holder.
    db.prepare("UPDATE resource_leases SET state = 'reaping', pid = ?, proc_started = ?, boot_id = ?, expires_at = ? WHERE id = ?")
      .run(me.pid, me.startedAt, me.bootId, now + 5 * 60_000, lease.id);
    return [lease];
  })));
  for (const lease of claimed) {
    const done = await cleanupOwned(lease.owned, cleanup);
    withDb(db => {
      if (done.ok) db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'reaping' AND pid = ?").run(lease.id, me.pid);
      // A recorded process may stop any moment, and its slot should free as soon as it does; simulators retry slowly.
      else db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', note = ?, expires_at = ? WHERE id = ? AND state = 'reaping' AND pid = ?")
        .run(done.detail.slice(0, 500), Date.now() + (lease.owned.some(o => o.kind === 'process') ? RETAIN_RETRY_MS : 5 * 60_000), lease.id, me.pid);
    });
    results.push({ id: lease.id, pool: lease.pool, holder: lease.holder, outcome: done.ok ? 'released' : 'cleanup_failed', detail: done.detail });
  }
  return results;
}

/**
 * Owner-only recovery for a stale claim whose holder cannot be identified (no recorded start time or boot), so it
 * can never be proven dead. Refuses verifiable holders: a live one must be stopped, a dead one is reaped normally.
 * Cleans only the simulators the lease recorded, then frees the slot; a failed cleanup keeps it occupied.
 */
export async function recoverStaleLease(id: string, note: string, cleanup: ResourceCleanup, now = Date.now()): Promise<ReapResult> {
  if (note.trim().length < 12) throw new Error('Describe how you confirmed the holder is gone (at least 12 characters)');
  const me = await selfIdentity();
  const lease = withDb(db => listLeases(db)).find(l => l.id === id);
  if (!lease) throw new Error('No lease with that ID');
  if (lease.state !== 'held' && lease.state !== 'reaping') throw new Error(`Lease is ${lease.state}; recovery applies to held or reaping claims (use release for a failed cleanup)`);
  if (lease.expiresAt >= now) throw new Error('Lease is still being renewed; its holder is active');
  if (lease.procStarted !== null && lease.bootId !== null) {
    throw new Error(await holderAlive(lease) ? `Holder pid ${lease.pid} is alive with the recorded identity; stop it first` : 'Holder is provably gone; run "ym devices reap"');
  }
  const claimed = withDb(db => tx(db, () => db.prepare(`UPDATE resource_leases SET state = 'reaping', pid = ?, proc_started = ?, boot_id = ?, expires_at = ?
    WHERE id = ? AND state = ? AND pid = ? AND expires_at = ?`).run(me.pid, me.startedAt, me.bootId, now + 5 * 60_000, id, lease.state, lease.pid, lease.expiresAt).changes === 1));
  if (!claimed) throw new Error('The lease changed while it was being recovered; inspect it again');
  const done = await cleanupOwned(lease.owned, cleanup);
  withDb(db => tx(db, () => {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`lease-recovery:${id}`, JSON.stringify({ ...lease, recoveredAt: Date.now(), note, cleanup: done }));
    if (done.ok) db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'reaping' AND pid = ?").run(id, me.pid);
    else db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', note = ? WHERE id = ? AND state = 'reaping' AND pid = ?").run(done.detail.slice(0, 500), id, me.pid);
  }));
  return { id, pool: lease.pool, holder: lease.holder, outcome: done.ok ? 'released' : 'cleanup_failed', detail: done.detail };
}

/** Owner attestation for a slot whose cleanup failed. Records the note; never touches a device. */
export function resolveLease(id: string, note: string): Lease {
  if (note.trim().length < 12) throw new Error('Describe how you inspected and cleaned the resources (at least 12 characters)');
  return withDb(db => tx(db, () => {
    const lease = listLeases(db).find(l => l.id === id);
    if (!lease) throw new Error('No lease with that ID');
    if (lease.state !== 'cleanup_failed') throw new Error(`Lease is ${lease.state}; only a lease whose cleanup failed can be resolved by hand`);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`lease-resolution:${id}`, JSON.stringify({ ...lease, resolvedAt: Date.now(), note }));
    db.prepare('DELETE FROM resource_leases WHERE id = ?').run(id);
    return lease;
  }));
}

export interface LeaseRequest {
  pool: LeasePool; capacity: number; holder: string;
  projectId?: string | null; taskId?: string | null; requestId?: string | null;
  ttlMs: number; waitMs: number; pollMs?: number; signal?: AbortSignal;
  /** Checked by the request at the head of the queue before it takes a free slot; null admits. */
  admit?: () => Promise<string | null>;
  cleanup: ResourceCleanup;
  onWait?: (status: { position: number; reason: string }) => void;
}
export interface LeaseHandle {
  readonly id: string;
  readonly queuedAt: number;
  readonly acquiredAt: number;
  /** Aborts if this lease is reclaimed from this process (its identity was judged dead). Owned resources then belong to the reaper. */
  readonly lost: AbortSignal;
  holds(): boolean;
  /** Record a resource before creating it. */
  own(resource: OwnedResource): void;
  /** Record use of a physical device unless another lease already has it; returns that lease's holder, or null once claimed. */
  claimDevice(key: string): string | null;
  release(): void;
  cleanupFailed(detail: string): void;
  /**
   * Instead of releasing: keep the slot occupied because these commands were not confirmed stopped. The reaper
   * frees it once each recorded process is confirmed gone (and any recorded simulator is cleaned).
   */
  retain(processes: { pid: number; startedAt: number | null }[], detail: string): void;
}
export type LeaseOutcome = { lease: LeaseHandle; waitedMs: number } | { lease: null; reason: string; waitedMs: number; queuedAt: number };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** Waits in a FIFO queue shared by every process on this machine. Never takes a slot from a live holder. */
export async function acquireLease(req: LeaseRequest): Promise<LeaseOutcome> {
  const me = await selfIdentity();
  const id = `l-${randomUUID()}`;
  const queuedAt = Date.now();
  const deadline = queuedAt + req.waitMs;
  withDb(db => db.prepare(`INSERT INTO resource_leases (id, pool, state, holder, project_id, task_id, request_id, host, pid, proc_started, boot_id, queued_at, expires_at)
    VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.pool, req.holder, req.projectId ?? null, req.taskId ?? null, req.requestId ?? null,
    machineId(), me.pid, me.startedAt, me.bootId, queuedAt, queuedAt + req.ttlMs));
  const leave = (reason: string): LeaseOutcome => {
    withDb(db => db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'waiting'").run(id));
    return { lease: null, reason, waitedMs: Date.now() - queuedAt, queuedAt };
  };
  let reason = 'waiting for a free slot';
  for (let first = true; ; first = false) {
    if (req.signal?.aborted) return leave('canceled while waiting for a slot');
    if (!first) await reapLeases(req.cleanup);
    const turn = withDb(db => tx(db, () => {
      const rows = listLeases(db, req.pool);
      const occupied = rows.filter(r => r.state !== 'waiting').length;
      const position = rows.filter(r => r.state === 'waiting').findIndex(r => r.id === id);
      if (position < 0) return { kind: 'lost' as const };
      db.prepare("UPDATE resource_leases SET expires_at = ? WHERE id = ? AND state = 'waiting'").run(Date.now() + req.ttlMs, id);
      return position < req.capacity - occupied ? { kind: 'eligible' as const } : { kind: 'wait' as const, position: position + 1 };
    }));
    if (turn.kind === 'lost') return { lease: null, reason: 'queued request expired before a slot was free', waitedMs: Date.now() - queuedAt, queuedAt };
    if (turn.kind === 'eligible') {
      const hold = await req.admit?.() ?? null;
      if (!hold) {
        const granted = withDb(db => tx(db, () => {
          const rows = listLeases(db, req.pool);
          const position = rows.filter(r => r.state === 'waiting').findIndex(r => r.id === id);
          if (position < 0 || position >= req.capacity - rows.filter(r => r.state !== 'waiting').length) return false;
          const now = Date.now();
          db.prepare("UPDATE resource_leases SET state = 'held', acquired_at = ?, expires_at = ? WHERE id = ?").run(now, now + req.ttlMs, id);
          return true;
        }));
        if (granted) return { lease: handle(id, queuedAt, req.ttlMs, me), waitedMs: Date.now() - queuedAt };
        continue;
      }
      reason = `held: ${hold}`;
      req.onWait?.({ position: 1, reason });
    } else {
      reason = `waiting in queue position ${turn.position} for a ${req.pool} slot`;
      req.onWait?.({ position: turn.position, reason });
    }
    if (Date.now() >= deadline) return leave(`${reason} after ${Math.round((Date.now() - queuedAt) / 1000)} s`);
    await sleep(Math.min(req.pollMs ?? 1000, Math.max(1, deadline - Date.now())), req.signal);
  }
}

function handle(id: string, queuedAt: number, ttlMs: number, me: ProcessId): LeaseHandle {
  const acquiredAt = Date.now();
  const lost = new AbortController();
  const mine = (db: Db) => db.prepare("SELECT 1 FROM resource_leases WHERE id = ? AND state = 'held' AND pid = ?").get(id, me.pid) !== undefined;
  const renew = setInterval(() => {
    const ok = withDb(db => db.prepare("UPDATE resource_leases SET expires_at = ? WHERE id = ? AND state = 'held' AND pid = ?").run(Date.now() + ttlMs, id, me.pid).changes === 1);
    if (!ok) { clearInterval(renew); lost.abort('lease expired and was reclaimed'); }
  }, Math.max(50, Math.floor(ttlMs / 3)));
  renew.unref();
  return { id, queuedAt, acquiredAt, lost: lost.signal,
    holds: () => withDb(mine),
    own: resource => withDb(db => tx(db, () => {
      const row = db.prepare("SELECT owned FROM resource_leases WHERE id = ? AND state = 'held' AND pid = ?").get(id, me.pid) as { owned: string } | undefined;
      if (!row) throw new Error('This process no longer holds the lease; nothing may be created under it.');
      const owned = z.array(OwnedResourceSchema).parse(JSON.parse(row.owned)).filter(o => !sameResource(o, resource));
      db.prepare('UPDATE resource_leases SET owned = ? WHERE id = ?').run(JSON.stringify([...owned, OwnedResourceSchema.parse(resource)]), id);
    })),
    claimDevice: key => withDb(db => tx(db, () => {
      const resource = DeviceResourceSchema.parse({ kind: 'device', key });
      const rows = listLeases(db);
      const mine = rows.find(l => l.id === id && l.state === 'held' && l.pid === me.pid);
      if (!mine) throw new Error('This process no longer holds the lease; no device may be used under it.');
      // Any other non-waiting lease counts, including one whose cleanup failed: its run may still be using the device.
      const other = rows.find(l => l.id !== id && l.state !== 'waiting' && l.owned.some(o => sameResource(o, resource)));
      if (other) return other.holder;
      db.prepare('UPDATE resource_leases SET owned = ? WHERE id = ?').run(JSON.stringify([...mine.owned.filter(o => !sameResource(o, resource)), resource]), id);
      return null;
    })),
    release: () => { clearInterval(renew); withDb(db => db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'held' AND pid = ?").run(id, me.pid)); },
    cleanupFailed: detail => {
      clearInterval(renew);
      withDb(db => db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', note = ?, expires_at = ? WHERE id = ? AND state = 'held' AND pid = ?")
        .run(detail.slice(0, 500), Date.now() + ttlMs, id, me.pid));
    },
    retain: (processes, detail) => {
      clearInterval(renew);
      withDb(db => tx(db, () => {
        const row = db.prepare("SELECT owned FROM resource_leases WHERE id = ? AND state = 'held' AND pid = ?").get(id, me.pid) as { owned: string } | undefined;
        if (!row) return;
        const owned = [...z.array(OwnedResourceSchema).parse(JSON.parse(row.owned)), ...processes.map(p => ProcessResourceSchema.parse({ kind: 'process', ...p }))];
        // Retry soon: the slot is occupied only while those processes may still be running.
        db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', owned = ?, note = ?, expires_at = ? WHERE id = ?")
          .run(JSON.stringify(owned), detail.slice(0, 500), Date.now() + RETAIN_RETRY_MS, id);
      }));
    },
  };
}

/** Queue position for display: 1-based among waiters, null once held. */
export function queuePosition(leases: Lease[], lease: Lease): number | null {
  if (lease.state !== 'waiting') return null;
  return leases.filter(l => l.pool === lease.pool && l.state === 'waiting').findIndex(l => l.id === lease.id) + 1;
}
