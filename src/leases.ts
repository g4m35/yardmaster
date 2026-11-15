import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { openDb, tx, type Db } from './db.ts';
import { machineId } from './paths.ts';
import { isAlive, processStartTime } from './proc.ts';

/**
 * Machine-wide leases for scarce, heavy resources: build slots, simulators and physical devices. Rows live in the
 * machine's own Yardmaster database, so every hub, worker and CLI process sharing YARDMASTER_HOME (any project)
 * coordinates through them, and they survive restarts. A lease records the resources Yardmaster created for it;
 * cleanup only ever touches those. Simulators and devices Yardmaster did not create are never leased-and-reset.
 */
export const LEASE_POOLS = ['build', 'simulator', 'physical'] as const;
export type LeasePool = typeof LEASE_POOLS[number];
export type LeaseState = 'waiting' | 'held' | 'reaping' | 'cleanup_failed';

export const OwnedResourceSchema = z.object({
  kind: z.literal('simulator'),
  /** Unique name chosen before creation, so a crash between create and record can still be found. */
  name: z.string().regex(/^ym-[a-z0-9-]{6,80}$/),
  udid: z.string().regex(/^[0-9A-F-]{36}$/i).nullable(),
});
export type OwnedResource = z.infer<typeof OwnedResourceSchema>;

export interface Lease {
  id: string; pool: LeasePool; state: LeaseState; holder: string;
  projectId: string | null; taskId: string | null; requestId: string | null;
  host: string; pid: number; procStarted: number | null;
  queuedAt: number; acquiredAt: number | null; expiresAt: number;
  owned: OwnedResource[]; note: string | null;
}
interface Row {
  id: string; pool: string; state: string; holder: string; project_id: string | null; task_id: string | null; request_id: string | null;
  host: string; pid: number; proc_started: number | null; queued_at: number; acquired_at: number | null; expires_at: number; owned: string; note: string | null;
}

const toLease = (r: Row): Lease => ({ id: r.id, pool: r.pool as LeasePool, state: r.state as LeaseState, holder: r.holder,
  projectId: r.project_id, taskId: r.task_id, requestId: r.request_id, host: r.host, pid: r.pid, procStarted: r.proc_started,
  queuedAt: r.queued_at, acquiredAt: r.acquired_at, expiresAt: r.expires_at, owned: z.array(OwnedResourceSchema).parse(JSON.parse(r.owned)), note: r.note });

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

export interface ProcessId { pid: number; startedAt: number | null }
let self: Promise<ProcessId> | null = null;
export function selfIdentity(): Promise<ProcessId> {
  self ??= processStartTime(process.pid).then(startedAt => ({ pid: process.pid, startedAt }));
  return self;
}

/** A holder whose PID is gone, or reused by a process with a different start time, has crashed. */
export async function holderAlive(pid: number, startedAt: number | null): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (startedAt === null) return true;
  const now = await processStartTime(pid).catch(() => null);
  return now === null || Math.abs(now - startedAt) <= 2000;
}

export type ResourceCleanup = (owned: OwnedResource[]) => Promise<{ ok: boolean; detail: string }>;
export interface ReapResult { id: string; pool: LeasePool; holder: string; outcome: 'expired-waiter' | 'released' | 'cleanup_failed'; detail: string }

/**
 * Frees leases whose holder process is gone. Their recorded resources are cleaned first; a failed
 * cleanup keeps the slot occupied and visible (`cleanup_failed`) rather than letting new work double-book it.
 */
export async function reapLeases(cleanup: ResourceCleanup, now = Date.now()): Promise<ReapResult[]> {
  const me = await selfIdentity();
  const candidates = withDb(db => listLeases(db)).filter(l => l.host === machineId());
  // The dead holder as inspected. Another reaper may claim the row meanwhile; then it is no longer this holder's.
  const crashed = new Map<string, string>();
  const identity = (l: Lease) => `${l.state}:${l.pid}:${l.procStarted}`;
  for (const lease of candidates) if (!(await holderAlive(lease.pid, lease.procStarted))) crashed.set(lease.id, identity(lease));
  const results: ReapResult[] = [];
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
    db.prepare("UPDATE resource_leases SET state = 'reaping', pid = ?, proc_started = ?, expires_at = ? WHERE id = ?")
      .run(me.pid, me.startedAt, now + 5 * 60_000, lease.id);
    return [lease];
  })));
  for (const lease of claimed) {
    const done = lease.owned.length ? await cleanup(lease.owned).catch((error: Error) => ({ ok: false, detail: error.message })) : { ok: true, detail: 'nothing to clean' };
    withDb(db => {
      if (done.ok) db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'reaping' AND pid = ?").run(lease.id, me.pid);
      else db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', note = ?, expires_at = ? WHERE id = ? AND state = 'reaping' AND pid = ?")
        .run(done.detail.slice(0, 500), Date.now() + 5 * 60_000, lease.id, me.pid);
    });
    results.push({ id: lease.id, pool: lease.pool, holder: lease.holder, outcome: done.ok ? 'released' : 'cleanup_failed', detail: done.detail });
  }
  return results;
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
  release(): void;
  cleanupFailed(detail: string): void;
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
  withDb(db => db.prepare(`INSERT INTO resource_leases (id, pool, state, holder, project_id, task_id, request_id, host, pid, proc_started, queued_at, expires_at)
    VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.pool, req.holder, req.projectId ?? null, req.taskId ?? null, req.requestId ?? null,
    machineId(), me.pid, me.startedAt, queuedAt, queuedAt + req.ttlMs));
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
      const owned = z.array(OwnedResourceSchema).parse(JSON.parse(row.owned)).filter(o => o.name !== resource.name);
      db.prepare('UPDATE resource_leases SET owned = ? WHERE id = ?').run(JSON.stringify([...owned, OwnedResourceSchema.parse(resource)]), id);
    })),
    release: () => { clearInterval(renew); withDb(db => db.prepare("DELETE FROM resource_leases WHERE id = ? AND state = 'held' AND pid = ?").run(id, me.pid)); },
    cleanupFailed: detail => {
      clearInterval(renew);
      withDb(db => db.prepare("UPDATE resource_leases SET state = 'cleanup_failed', note = ?, expires_at = ? WHERE id = ? AND state = 'held' AND pid = ?")
        .run(detail.slice(0, 500), Date.now() + ttlMs, id, me.pid));
    },
  };
}

/** Queue position for display: 1-based among waiters, null once held. */
export function queuePosition(leases: Lease[], lease: Lease): number | null {
  if (lease.state !== 'waiting') return null;
  return leases.filter(l => l.pool === lease.pool && l.state === 'waiting').findIndex(l => l.id === lease.id) + 1;
}
