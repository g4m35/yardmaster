import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { tx } from './transaction.ts';
import { TERMINAL_STATUSES, type TaskStatus } from './types.ts';

/**
 * Budget reservations and the observed-spend ledger. See docs/BUDGETS.md for the parent call sequence.
 *
 * Money is stored as integer micro-dollars so concurrent reservations add up exactly; a float rounding error must
 * never let two admissions share the same cent. Every write runs in `tx()` (BEGIN IMMEDIATE, or the caller's open
 * transaction), so admission decisions are serialized across connections and processes.
 */

/**
 * Append as one entry to db.ts MIGRATIONS, after the schema-9 usage columns it reads. The backfill copies each run's
 * current absolute totals as a single ledger row at its current `usage_seq` (so the next accepted snapshot is
 * `usage_seq + 1`, as today), dated by the local day the run started (the old `spentToday` rule). Runs still live
 * at upgrade get a `legacy` hold until their exit is confirmed: the task's remaining budget plus what that run has
 * already spent (a hold's own run consumes it), or no finite amount for an uncapped task. Nothing is deleted or rewritten.
 */
export const budgetMigrationDDL = `
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY, phase TEXT NOT NULL, project_id TEXT, task_id TEXT, run_id TEXT UNIQUE,
  amount_micros INTEGER CHECK (amount_micros IS NULL OR amount_micros >= 0),
  basis TEXT NOT NULL, enforcement TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'released')), release_reason TEXT,
  created_at INTEGER NOT NULL, attached_at INTEGER, released_at INTEGER
);
CREATE INDEX budget_reservations_state ON budget_reservations(state, task_id);
CREATE TABLE usage_ledger (
  run_id TEXT NOT NULL, sequence INTEGER NOT NULL, task_id TEXT, project_id TEXT, day TEXT NOT NULL,
  cost_delta_micros INTEGER NOT NULL, day_cost_micros INTEGER NOT NULL,
  tokens_in_delta INTEGER NOT NULL, tokens_out_delta INTEGER NOT NULL,
  provenance TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE INDEX usage_ledger_day ON usage_ledger(day);
CREATE INDEX usage_ledger_task ON usage_ledger(task_id);
INSERT INTO usage_ledger (run_id, sequence, task_id, project_id, day, cost_delta_micros, day_cost_micros,
  tokens_in_delta, tokens_out_delta, provenance, recorded_at)
SELECT r.id, r.usage_seq,
  CASE WHEN r.role IN ('implement', 'review') THEN r.task_id END,
  CASE WHEN r.role IN ('implement', 'review') THEN t.project_id
       WHEN substr(r.task_id, length(r.role) + 2) IN ('', 'none') THEN NULL
       ELSE substr(r.task_id, length(r.role) + 2) END,
  date(r.started_at / 1000, 'unixepoch', 'localtime'),
  CAST(ROUND(r.cost_usd * 1000000) AS INTEGER), MAX(0, CAST(ROUND(r.cost_usd * 1000000) AS INTEGER)),
  r.tokens_in, r.tokens_out, r.usage_provenance, COALESCE(r.ended_at, r.started_at)
FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
WHERE r.usage_seq > 0 OR r.cost_usd <> 0 OR r.tokens_in <> 0 OR r.tokens_out <> 0;
INSERT INTO budget_reservations (id, phase, project_id, task_id, run_id, amount_micros, basis, enforcement, state, created_at, attached_at)
SELECT 'legacy-' || r.id, r.role, t.project_id, r.task_id, r.id,
  CASE WHEN t.budget_usd IS NULL THEN NULL ELSE MAX(0, CAST(ROUND((t.budget_usd - t.cost_usd + r.cost_usd) * 1000000) AS INTEGER)) END,
  'legacy', 'admission_only', 'held', r.started_at, r.started_at
FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
WHERE r.status IN ('running', 'lost', 'cleanup_failed');
`;

export type BudgetPhase = 'implement' | 'review' | 'plan';
/**
 * What, besides admission, limits a phase's spend:
 * - native_cap: the amount is also passed to the CLI as its own dollar cap (enforced by the CLI, not verified here).
 * - reactive: Yardmaster stops the run after a usage report crosses the amount; spend between reports can overshoot.
 * - admission_only: the CLI reports no usage, so nothing can see or stop its spend once it starts.
 */
export type Enforcement = 'native_cap' | 'reactive' | 'admission_only';
/** Which limit set the reserved amount. `legacy` holds come from the migration for runs live at upgrade. */
export type ReservationBasis = 'phase' | 'task' | 'daily' | 'unlimited' | 'legacy';
export type UsageProvenance = 'actual' | 'estimated' | 'mixed' | 'unknown';

export interface Reservation {
  id: string;
  phase: BudgetPhase;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  /** Null: nothing finite was promised (no applicable cap), so there is nothing to hold back. */
  amountUsd: number | null;
  basis: ReservationBasis;
  enforcement: Enforcement;
  state: 'held' | 'released';
  releaseReason: 'exited' | 'no_launch' | null;
  createdAt: number;
  releasedAt: number | null;
}

export interface AllowanceQuery {
  taskId: string | null;
  /** The task's total cap (tasks.budget_usd), not what is left of it. Null: no task cap. */
  taskCapUsd: number | null;
  /** budget.dailyUsd for the project. Daily spend is fleet-wide, as with the existing spentToday. Null: no cap. */
  dailyCapUsd: number | null;
  /** Per-phase ceiling such as review.budgetUsd. Null/omitted: none. */
  phaseCapUsd?: number | null;
  now?: number;
}

export interface Allowance {
  day: string;
  dailyCapUsd: number | null;
  observedTodayUsd: number;
  /** Reserved but not yet observed as spend, across every held reservation (any day). */
  heldUnspentUsd: number;
  dailyRemainingUsd: number | null;
  taskCapUsd: number | null;
  taskSpentUsd: number;
  taskHeldUnspentUsd: number;
  taskRemainingUsd: number | null;
  phaseCapUsd: number | null;
  /** min of the finite limits above; null only when no limit applies. */
  availableUsd: number | null;
  basis: ReservationBasis;
  /** Held reservations with no finite amount (admitted while uncapped). While any exist, a finite cap has nothing left to promise. */
  unboundedHeld: number;
  /** Held reservations whose run has not reported measured usage yet: their spend is unknown, not zero. */
  awaitingUsage: number;
  /** Provenance of today's observed spend. */
  provenance: UsageProvenance;
}

export interface ReserveRequest extends AllowanceQuery {
  phase: BudgetPhase;
  projectId: string | null;
  enforcement: Enforcement;
  /** Hold instead of reserving less than this. Pass the full cap to require it; default one cent. */
  minUsd?: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation; allowance: Allowance }
  | { ok: false; reason: string; allowance: Allowance };

export type ReleaseProof = { kind: 'exited'; runId: string } | { kind: 'no_launch' };

export interface UsageObservation {
  runId: string;
  /** Strictly increasing per run, from 1. 0 is the migration backfill. */
  sequence: number;
  taskId: string | null;
  projectId: string | null;
  /** Absolute run totals from a validated snapshot. */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  provenance: UsageProvenance;
  at?: number;
}

export interface UsageDelta {
  /** False for a duplicate or reordered (older) sequence: nothing was written. */
  applied: boolean;
  costDeltaUsd: number;
  tokensInDelta: number;
  tokensOutDelta: number;
  /** Run totals after this observation (the values to store as runs.accounted_*). */
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export class BudgetError extends Error {
  override name = 'BudgetError';
}


const MAX_USD = 1_000_000;
const MAX_ID = 200;
const MICROS = 1_000_000;
const DEFAULT_MIN_MICROS = 10_000;
const LIVE_RUN_STATUSES = ['running', 'lost', 'cleanup_failed'];

export const JEV_JUDGE_COST_NOTE = 'JEV effort-judge calls are not included: its protocol reports no cost, so that spend is unknown and outside these budgets.';

const toMicros = (usd: number): number => Math.round(usd * MICROS);
const toUsd = (micros: number): number => micros / MICROS;
const formatUsd = (micros: number): string => `$${(micros / MICROS).toFixed(2)}`;

function usd(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_USD) throw new BudgetError(`${name} must be a finite dollar amount from 0 to ${MAX_USD}.`);
  return toMicros(v);
}

function cap(name: string, v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : usd(name, v);
}

function id(name: string, v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > MAX_ID) throw new BudgetError(`${name} must be a non-empty id of at most ${MAX_ID} characters.`);
  return v;
}

function optId(name: string, v: unknown): string | null {
  return v === null ? null : id(name, v);
}

function count(name: string, v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new BudgetError(`${name} must be a non-negative safe integer.`);
  return v;
}

function clock(v: number | undefined): number {
  const now = v ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new BudgetError('now must be a millisecond timestamp.');
  return now;
}

function oneOf<T extends string>(name: string, v: T, allowed: readonly T[]): T {
  if (!allowed.includes(v)) throw new BudgetError(`${name} must be one of ${allowed.join(', ')}.`);
  return v;
}

/** The local calendar day, matching SQLite's date(..., 'localtime') used by the backfill. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface ReservationRow {
  id: string; phase: string; project_id: string | null; task_id: string | null; run_id: string | null;
  amount_micros: number | null; basis: string; enforcement: string; state: string; release_reason: string | null;
  created_at: number; released_at: number | null;
}

function toReservation(r: ReservationRow): Reservation {
  return {
    id: r.id, phase: r.phase as BudgetPhase, projectId: r.project_id, taskId: r.task_id, runId: r.run_id,
    amountUsd: r.amount_micros === null ? null : toUsd(Number(r.amount_micros)), basis: r.basis as ReservationBasis,
    enforcement: r.enforcement as Enforcement, state: r.state as Reservation['state'],
    releaseReason: r.release_reason as Reservation['releaseReason'], createdAt: Number(r.created_at),
    releasedAt: r.released_at === null ? null : Number(r.released_at),
  };
}

function getRow(db: Db, reservationId: string): ReservationRow {
  const row = db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(reservationId) as ReservationRow | undefined;
  if (!row) throw new BudgetError(`Unknown budget reservation ${reservationId}.`);
  return row;
}

interface Computed { allowance: Allowance; availableMicros: number | null }

function compute(db: Db, q: AllowanceQuery): Computed {
  const now = clock(q.now);
  const taskId = optId('taskId', q.taskId);
  const daily = cap('dailyCapUsd', q.dailyCapUsd);
  const taskCap = cap('taskCapUsd', q.taskCapUsd);
  const phaseCap = cap('phaseCapUsd', q.phaseCapUsd);
  if (taskId === null && taskCap !== null) throw new BudgetError('A task cap needs a taskId.');
  const day = dayKey(now);

  const today = db.prepare(`SELECT COALESCE(SUM(day_cost_micros), 0) AS spent,
      COALESCE(SUM(provenance = 'actual'), 0) AS actual, COALESCE(SUM(provenance = 'estimated'), 0) AS estimated,
      COALESCE(SUM(provenance = 'mixed'), 0) AS mixed
    FROM usage_ledger WHERE day = ?`).get(day) as { spent: number; actual: number; estimated: number; mixed: number };
  const held = db.prepare(`SELECT r.task_id, r.amount_micros,
      COALESCE((SELECT SUM(u.cost_delta_micros) FROM usage_ledger u WHERE u.run_id = r.run_id), 0) AS consumed,
      EXISTS (SELECT 1 FROM usage_ledger u WHERE u.run_id = r.run_id AND u.provenance <> 'unknown') AS measured
    FROM budget_reservations r WHERE r.state = 'held'`).all() as { task_id: string | null; amount_micros: number | null; consumed: number; measured: number }[];

  let heldUnspent = 0, taskHeld = 0, unbounded = 0, taskUnbounded = 0, awaiting = 0;
  for (const h of held) {
    if (!h.measured) awaiting++;
    const mine = taskId !== null && h.task_id === taskId;
    if (h.amount_micros === null) {
      unbounded++;
      if (mine) taskUnbounded++;
      continue;
    }
    const unspent = Math.max(0, Number(h.amount_micros) - Number(h.consumed));
    heldUnspent += unspent;
    if (mine) taskHeld += unspent;
  }
  const observed = Number(today.spent);
  const taskSpent = taskId === null ? 0 : Math.max(0, Number((db.prepare('SELECT COALESCE(SUM(cost_delta_micros), 0) AS s FROM usage_ledger WHERE task_id = ?').get(taskId) as { s: number }).s));

  // A held reservation with no finite amount may still spend anything, so a finite cap cannot promise more until it exits.
  const dailyRemaining = daily === null ? null : unbounded > 0 ? 0 : Math.max(0, daily - observed - heldUnspent);
  const taskRemaining = taskCap === null ? null : taskUnbounded > 0 ? 0 : Math.max(0, taskCap - taskSpent - taskHeld);

  let available: number | null = null;
  let basis: ReservationBasis = 'unlimited';
  for (const [b, v] of [['phase', phaseCap], ['task', taskRemaining], ['daily', dailyRemaining]] as const) {
    if (v !== null && (available === null || v < available)) { available = v; basis = b; }
  }

  const actual = Number(today.actual) > 0, estimated = Number(today.estimated) > 0;
  const provenance: UsageProvenance = Number(today.mixed) > 0 || (actual && estimated) ? 'mixed' : actual ? 'actual' : estimated ? 'estimated' : 'unknown';
  return {
    availableMicros: available,
    allowance: {
      day, dailyCapUsd: daily === null ? null : toUsd(daily), observedTodayUsd: toUsd(observed), heldUnspentUsd: toUsd(heldUnspent),
      dailyRemainingUsd: dailyRemaining === null ? null : toUsd(dailyRemaining),
      taskCapUsd: taskCap === null ? null : toUsd(taskCap), taskSpentUsd: toUsd(taskSpent), taskHeldUnspentUsd: toUsd(taskHeld),
      taskRemainingUsd: taskRemaining === null ? null : toUsd(taskRemaining), phaseCapUsd: phaseCap === null ? null : toUsd(phaseCap),
      availableUsd: available === null ? null : toUsd(available), basis, unboundedHeld: unbounded, awaitingUsage: awaiting, provenance,
    },
  };
}

/** Read-only view of what a phase could reserve right now. Reserve, not this, is the admission decision. */
export function readAllowance(db: Db, q: AllowanceQuery): Allowance {
  return compute(db, q).allowance;
}

function holdReason(a: Allowance, minMicros: number): string {
  const need = formatUsd(minMicros);
  if (a.unboundedHeld > 0) return `${a.unboundedHeld} running phase(s) were admitted without a finite limit; new work waits until they exit.`;
  switch (a.basis) {
    case 'task': return `This task has ${formatUsd(toMicros(a.taskRemainingUsd ?? 0))} of its ${formatUsd(toMicros(a.taskCapUsd ?? 0))} budget left after spend and running holds (needs ${need}).`;
    case 'daily': return `Today's budget of ${formatUsd(toMicros(a.dailyCapUsd ?? 0))} has ${formatUsd(toMicros(a.dailyRemainingUsd ?? 0))} left after ${formatUsd(toMicros(a.observedTodayUsd))} spent and ${formatUsd(toMicros(a.heldUnspentUsd))} held for running work (needs ${need}).`;
    default: return `The phase allowance of ${formatUsd(toMicros(a.phaseCapUsd ?? 0))} is below the ${need} minimum.`;
  }
}

/**
 * Atomically admits one phase. The reserved amount is min(phase cap, task remaining, daily remaining), where
 * "remaining" already subtracts every other held reservation's unspent amount, so no allowance is promised twice.
 * When only the daily cap is finite, the whole remaining daily allowance is held: an uncapped task may spend it all.
 */
export function reserve(db: Db, req: ReserveRequest): ReserveResult {
  const phase = oneOf('phase', req.phase, ['implement', 'review', 'plan'] as const);
  const enforcement = oneOf('enforcement', req.enforcement, ['native_cap', 'reactive', 'admission_only'] as const);
  const projectId = optId('projectId', req.projectId);
  const taskId = optId('taskId', req.taskId);
  if ((phase === 'plan') !== (taskId === null)) throw new BudgetError('Planning reserves without a task; implement and review reserve for one.');
  const minMicros = req.minUsd === undefined ? DEFAULT_MIN_MICROS : usd('minUsd', req.minUsd);
  if (minMicros <= 0) throw new BudgetError('minUsd must be positive.');
  const now = clock(req.now);
  return tx(db, () => {
    if (taskId !== null) {
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: TaskStatus } | undefined;
      if (!task) throw new BudgetError(`Unknown task ${taskId}.`);
      if (TERMINAL_STATUSES.includes(task.status)) throw new BudgetError(`Task ${taskId} is ${task.status}; budget is not reserved for finished work.`);
    }
    const { allowance, availableMicros } = compute(db, { ...req, now });
    if (availableMicros !== null && availableMicros < minMicros) return { ok: false, reason: holdReason(allowance, minMicros), allowance };
    const rid = `br-${randomUUID()}`;
    db.prepare(`INSERT INTO budget_reservations (id, phase, project_id, task_id, amount_micros, basis, enforcement, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`).run(rid, phase, projectId, taskId, availableMicros, allowance.basis, enforcement, now);
    return { ok: true, reservation: toReservation(getRow(db, rid)), allowance };
  });
}

/** Binds a held reservation to the live run row created for it. One reservation per run, and the run must match. */
export function attachRun(db: Db, reservationId: string, runId: string, now?: number): Reservation {
  id('reservationId', reservationId);
  id('runId', runId);
  const at = clock(now);
  return tx(db, () => {
    const row = getRow(db, reservationId);
    if (row.run_id === runId && row.state === 'held') return toReservation(row);
    if (row.state !== 'held') throw new BudgetError(`Reservation ${reservationId} was released; reserve again.`);
    if (row.run_id !== null) throw new BudgetError(`Reservation ${reservationId} already belongs to run ${row.run_id}.`);
    const run = db.prepare('SELECT task_id, role, status FROM runs WHERE id = ?').get(runId) as { task_id: string; role: string; status: string } | undefined;
    if (!run) throw new BudgetError(`Unknown run ${runId}.`);
    if (run.role !== row.phase || (row.task_id !== null && run.task_id !== row.task_id)) throw new BudgetError(`Run ${runId} is not the ${row.phase} run this reservation admitted.`);
    if (!LIVE_RUN_STATUSES.includes(run.status)) throw new BudgetError(`Run ${runId} is already ${run.status}.`);
    if (db.prepare("SELECT 1 FROM budget_reservations WHERE run_id = ?").get(runId)) throw new BudgetError(`Run ${runId} already has a reservation.`);
    db.prepare('UPDATE budget_reservations SET run_id = ?, attached_at = ? WHERE id = ?').run(runId, at, reservationId);
    return toReservation(getRow(db, reservationId));
  });
}

/** Fail-closed launch gate: the held reservation for this run, or an error. Its amountUsd is the run's budget. */
export function requireHeld(db: Db, runId: string): Reservation {
  id('runId', runId);
  const row = db.prepare("SELECT * FROM budget_reservations WHERE run_id = ? AND state = 'held'").get(runId) as ReservationRow | undefined;
  if (!row) throw new BudgetError(`Run ${runId} has no held budget reservation; refusing to launch.`);
  return toReservation(row);
}

/**
 * Returns a reservation's unspent amount to the pool. Only two proofs qualify: the attached run's process group was
 * confirmed gone (its row is no longer running/lost/cleanup_failed), or nothing was ever attached or launched.
 * Lease expiry, a new claim generation and raising a budget are not proofs. Releasing twice is a no-op.
 */
export function release(db: Db, reservationId: string, proof: ReleaseProof, now?: number): Reservation {
  id('reservationId', reservationId);
  const at = clock(now);
  return tx(db, () => {
    const row = getRow(db, reservationId);
    if (row.state === 'released') return toReservation(row);
    if (proof.kind === 'no_launch') {
      if (row.run_id !== null) throw new BudgetError(`Reservation ${reservationId} has run ${row.run_id}; release it with that run's exit.`);
    } else if (proof.kind === 'exited') {
      if (row.run_id === null || row.run_id !== proof.runId) throw new BudgetError(`Reservation ${reservationId} does not belong to run ${String(proof.runId)}.`);
      const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(row.run_id) as { status: string } | undefined;
      if (!run) throw new BudgetError(`Run ${row.run_id} is missing; its exit cannot be confirmed.`);
      if (LIVE_RUN_STATUSES.includes(run.status)) throw new BudgetError(`Run ${row.run_id} is ${run.status}; release waits for a confirmed exit.`);
    } else {
      throw new BudgetError('Unknown release proof.');
    }
    db.prepare("UPDATE budget_reservations SET state = 'released', release_reason = ?, released_at = ? WHERE id = ?").run(proof.kind, at, reservationId);
    return toReservation(getRow(db, reservationId));
  });
}

/** Held reservations, oldest first: running work and orphans awaiting exit proof. */
export function listHeld(db: Db): Reservation[] {
  return (db.prepare("SELECT * FROM budget_reservations WHERE state = 'held' ORDER BY created_at, id").all() as unknown as ReservationRow[]).map(toReservation);
}

/**
 * Converts one validated absolute usage snapshot into a ledger delta. Call it inside recordRunUsage's transaction
 * and use the returned deltas/totals for tasks and runs, so the ledger and task totals never disagree.
 * - A sequence at or below the run's highest recorded one is a duplicate or reordered snapshot: nothing is written.
 * - Deltas are signed, so a provider total replacing an earlier estimate corrects it instead of adding to it.
 * - An `unknown` snapshot measured nothing and changes no totals (it still advances the sequence).
 * - Each delta is dated by the day it was observed, so a run started yesterday counts today's growth today. For
 *   daily admission a downward correction only offsets the same run's spend already counted that day, so an old
 *   estimate corrected after midnight never inflates the new day's allowance.
 */
export function recordUsageDelta(db: Db, obs: UsageObservation): UsageDelta {
  const runId = id('runId', obs.runId);
  if (!Number.isSafeInteger(obs.sequence) || obs.sequence < 1) throw new BudgetError('sequence must be a positive safe integer.');
  const taskId = optId('taskId', obs.taskId);
  const projectId = optId('projectId', obs.projectId);
  const cost = usd('costUsd', obs.costUsd);
  const tokensIn = count('tokensIn', obs.tokensIn);
  const tokensOut = count('tokensOut', obs.tokensOut);
  const provenance = oneOf('provenance', obs.provenance, ['actual', 'estimated', 'mixed', 'unknown'] as const);
  const at = clock(obs.at);
  return tx(db, () => {
    const prior = db.prepare(`SELECT MAX(sequence) AS seq, COALESCE(SUM(cost_delta_micros), 0) AS cost,
        COALESCE(SUM(tokens_in_delta), 0) AS tin, COALESCE(SUM(tokens_out_delta), 0) AS tout,
        MIN(COALESCE(task_id, '')) AS t1, MAX(COALESCE(task_id, '')) AS t2
      FROM usage_ledger WHERE run_id = ?`).get(runId) as { seq: number | null; cost: number; tin: number; tout: number; t1: string | null; t2: string | null };
    const totals = { cost: Number(prior.cost), tin: Number(prior.tin), tout: Number(prior.tout) };
    if (prior.seq !== null && (prior.t1 !== (taskId ?? '') || prior.t2 !== (taskId ?? ''))) throw new BudgetError(`Usage for run ${runId} names a different task than its earlier usage.`);
    const unchanged = (applied: boolean): UsageDelta => ({ applied, costDeltaUsd: 0, tokensInDelta: 0, tokensOutDelta: 0,
      totalCostUsd: toUsd(totals.cost), totalTokensIn: totals.tin, totalTokensOut: totals.tout });
    if (prior.seq !== null && obs.sequence <= Number(prior.seq)) return unchanged(false);

    const day = dayKey(at);
    const measured = provenance !== 'unknown';
    const dCost = measured ? cost - totals.cost : 0;
    const dIn = measured ? tokensIn - totals.tin : 0;
    const dOut = measured ? tokensOut - totals.tout : 0;
    const countedToday = Number((db.prepare('SELECT COALESCE(SUM(day_cost_micros), 0) AS s FROM usage_ledger WHERE run_id = ? AND day = ?').get(runId, day) as { s: number }).s);
    const dayCost = Math.max(-countedToday, dCost);
    db.prepare(`INSERT INTO usage_ledger (run_id, sequence, task_id, project_id, day, cost_delta_micros, day_cost_micros,
        tokens_in_delta, tokens_out_delta, provenance, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, obs.sequence, taskId, projectId, day, dCost, dayCost, dIn, dOut, provenance, at);
    if (!measured) return unchanged(true);
    return { applied: true, costDeltaUsd: toUsd(dCost), tokensInDelta: dIn, tokensOutDelta: dOut,
      totalCostUsd: toUsd(cost), totalTokensIn: tokensIn, totalTokensOut: tokensOut };
  });
}

/** Today's observed spend for daily admission (replaces runs.started_at sums once the ledger is the source). */
export function observedSpendUsd(db: Db, now?: number): number {
  const s = (db.prepare('SELECT COALESCE(SUM(day_cost_micros), 0) AS s FROM usage_ledger WHERE day = ?').get(dayKey(clock(now))) as { s: number }).s;
  return toUsd(Number(s));
}

const BASIS_TEXT: Record<ReservationBasis, string> = {
  phase: 'the phase allowance',
  task: "the task's remaining budget",
  daily: "today's remaining budget (the task has no cap, so all of it is held)",
  unlimited: 'no applicable cap',
  legacy: "the task's remaining budget at upgrade, for work already running then",
};

/** One plain sentence for the dashboard/CLI about what limits this reservation's spend, without overstating it. */
export function describeReservation(r: Reservation): string {
  if (r.amountUsd === null) {
    return r.basis === 'legacy'
      ? 'Work already running at upgrade with no task cap. Nothing limits its spend; finite budgets admit no new work until it exits.'
      : 'No dollar limit applies (no task, phase or daily cap). Spend is recorded as reported; nothing is reserved or stopped.';
  }
  const amount = formatUsd(toMicros(r.amountUsd));
  const head = `${amount} reserved from ${BASIS_TEXT[r.basis]}.`;
  switch (r.enforcement) {
    case 'native_cap': return `${head} The same amount is passed to the CLI as its own spending cap; Yardmaster has not verified that the provider enforces it.`;
    case 'reactive': return `${head} Yardmaster stops the run after a usage report shows it over; spend between reports, and spend reported late, can exceed it.`;
    case 'admission_only': return `${head} This CLI reports no usage, so its spend is unknown and cannot be stopped; the reservation only limits how much other work starts.`;
  }
}

/** Status lines for an allowance read: limits, provenance and what is not counted. */
export function describeAllowance(a: Allowance): string[] {
  const lines: string[] = [];
  const spent = `${formatUsd(toMicros(a.observedTodayUsd))} observed today (${a.provenance === 'unknown' ? 'no measured usage' : a.provenance})`;
  lines.push(a.dailyCapUsd === null
    ? `No daily cap. ${spent}.`
    : `Daily cap ${formatUsd(toMicros(a.dailyCapUsd))}: ${spent}, ${formatUsd(toMicros(a.heldUnspentUsd))} held for running work, ${formatUsd(toMicros(a.dailyRemainingUsd ?? 0))} left.`);
  if (a.taskCapUsd !== null) lines.push(`Task cap ${formatUsd(toMicros(a.taskCapUsd))}: ${formatUsd(toMicros(a.taskSpentUsd))} spent, ${formatUsd(toMicros(a.taskHeldUnspentUsd))} held, ${formatUsd(toMicros(a.taskRemainingUsd ?? 0))} left.`);
  if (a.unboundedHeld) lines.push(`${a.unboundedHeld} running phase(s) have no finite limit; finite budgets admit nothing new until they exit.`);
  if (a.awaitingUsage) lines.push(`${a.awaitingUsage} running phase(s) have not reported measured usage; their spend so far is unknown, not zero.`);
  lines.push('Budgets are admission limits plus reactive stops, not provider-enforced caps, except where a CLI is given its own cap.');
  lines.push(JEV_JUDGE_COST_NOTE);
  return lines;
}
