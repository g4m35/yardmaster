import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDb, tx, type Db } from '../src/db.ts';
import {
  attachRun, budgetMigrationDDL, BudgetError, dayKey, describeAllowance, describeReservation, JEV_JUDGE_COST_NOTE,
  listHeld, observedSpendUsd, readAllowance, recordUsageDelta, release, requireHeld, reserve,
  type ReserveRequest,
} from '../src/budgets.ts';
import { tempDir } from './helpers.ts';

const NOON = new Date(2026, 10, 7, 12, 0).getTime();

function hasBudgetTables(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_reservations'").get();
}

/** A current-schema fixture with the budget migration applied once (by the parent's list, or here). */
function fixture(file = ':memory:') {
  const db = openDb(file);
  if (!hasBudgetTables(db)) tx(db, () => db.exec(budgetMigrationDDL));
  db.prepare('INSERT OR IGNORE INTO projects (id, name, root, base_branch, created_at) VALUES (?, ?, ?, ?, ?)').run('p1', 'p1', '/fixture/p1', 'main', NOON);
  return { db, ...helpers(db) };
}

function helpers(db: Db) {
  const task = (id: string, opts: { budget?: number | null; status?: string; cost?: number } = {}) => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, fingerprint, status, tier, max_attempts, created_by, created_at, updated_at,
      budget_usd, cost_usd, generation) VALUES (?, 'p1', ?, 'p', ?, ?, 'standard', 3, 'fixture', ?, ?, ?, ?, 1)`)
      .run(id, id, id, opts.status ?? 'running', NOON, NOON, opts.budget === undefined ? 3 : opts.budget, opts.cost ?? 0);
  };
  const run = (id: string, taskId: string, opts: { role?: string; status?: string; started?: number; cost?: number; seq?: number; provenance?: string } = {}) => {
    db.prepare(`INSERT INTO runs (id, task_id, attempt, machine_id, agent, status, started_at, role, generation, cost_usd, usage_seq, usage_provenance)
      VALUES (?, ?, 1, 'm1', 'codex', ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, taskId, opts.status ?? 'running', opts.started ?? NOON, opts.role ?? 'implement', opts.cost ?? 0, opts.seq ?? 0, opts.provenance ?? 'unknown');
  };
  const setRun = (id: string, status: string) => db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  return { task, run, setRun };
}

const implement = (taskId: string, extra: Partial<ReserveRequest> = {}): ReserveRequest => ({
  phase: 'implement', projectId: 'p1', taskId, taskCapUsd: 3, dailyCapUsd: 5, enforcement: 'reactive', now: NOON, ...extra,
});

function admitted(r: ReturnType<typeof reserve>) {
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r.reservation;
}

test('aggregate admission never promises the same daily allowance twice', () => {
  const f = fixture();
  for (const t of ['t1', 't2', 't3']) f.task(t);
  const first = admitted(reserve(f.db, implement('t1')));
  assert.equal(first.amountUsd, 3);
  assert.equal(first.basis, 'task');

  const full = reserve(f.db, implement('t2', { minUsd: 3 }));
  assert.equal(full.ok, false, 'a policy that needs the full task cap holds');
  if (!full.ok) assert.match(full.reason, /\$2\.00 left after \$0\.00 spent and \$3\.00 held/);

  const partial = admitted(reserve(f.db, implement('t2')));
  assert.equal(partial.amountUsd, 2);
  assert.equal(partial.basis, 'daily');
  assert.equal(reserve(f.db, implement('t3')).ok, false);
  const a = readAllowance(f.db, { taskId: 't3', taskCapUsd: 3, dailyCapUsd: 5, now: NOON });
  assert.equal(a.heldUnspentUsd, 5);
  assert.equal(a.dailyRemainingUsd, 0);
  assert.equal(a.awaitingUsage, 2, 'held runs with no measured usage are reported as unknown spend');
});

test('simultaneous connections in separate threads cannot overcommit the daily budget', async () => {
  const dir = tempDir('ym-budget-');
  const file = join(dir, 'db.sqlite');
  const f = fixture(file);
  const n = 8;
  for (let i = 0; i < n; i++) f.task(`c${i}`);
  f.db.close();

  const gate = new Int32Array(new SharedArrayBuffer(4));
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { openDb } = await import(workerData.db);
      const { reserve } = await import(workerData.budgets);
      const db = openDb(workerData.file);
      Atomics.add(workerData.gate, 0, 1);
      while (Atomics.load(workerData.gate, 0) < workerData.n) Atomics.wait(workerData.gate, 0, Atomics.load(workerData.gate, 0), 5);
      const r = reserve(db, { phase: 'implement', projectId: 'p1', taskId: workerData.taskId, taskCapUsd: 3, dailyCapUsd: 5, enforcement: 'reactive', now: workerData.now });
      db.close();
      parentPort.postMessage(r.ok ? r.reservation.amountUsd : null);
    })().catch((err) => parentPort.postMessage({ error: String(err && err.stack || err) }));
  `;
  const src = (name: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', name)).href;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<unknown>((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { file, gate, n, taskId: `c${i}`, now: NOON, db: src('db.ts'), budgets: src('budgets.ts') } });
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  })));
  for (const r of results) assert.ok(r === null || typeof r === 'number', JSON.stringify(r));
  const granted = results.filter((r): r is number => typeof r === 'number');
  assert.equal(granted.reduce((a, b) => a + b, 0), 5, `granted ${JSON.stringify(results)}`);
  assert.deepEqual(granted.sort(), [2, 3]);

  const again = openDb(file);
  assert.equal(listHeld(again).length, 2, 'holds survive the connections that made them');
  assert.equal(readAllowance(again, { taskId: null, taskCapUsd: null, dailyCapUsd: 5, now: NOON }).dailyRemainingUsd, 0);
  again.close();
});

test('holds survive restart and are released only with exit or no-launch proof', () => {
  const dir = tempDir('ym-budget-');
  const file = join(dir, 'db.sqlite');
  const f = fixture(file);
  f.task('t1');
  f.task('t2');
  const r1 = admitted(reserve(f.db, implement('t1')));
  f.run('r1', 't1');
  attachRun(f.db, r1.id, 'r1', NOON);
  const r2 = admitted(reserve(f.db, implement('t2')));
  f.db.close();

  const db = openDb(file);
  const h = helpers(db);
  assert.deepEqual(listHeld(db).map((r) => r.id).sort(), [r1.id, r2.id].sort());
  assert.equal(requireHeld(db, 'r1').amountUsd, 3);
  assert.throws(() => release(db, r1.id, { kind: 'no_launch' }), /release it with that run's exit/);
  assert.throws(() => release(db, r1.id, { kind: 'exited', runId: 'r1' }), /running; release waits/);
  assert.throws(() => release(db, r2.id, { kind: 'exited', runId: 'r1' }), /does not belong/);

  const freed = release(db, r2.id, { kind: 'no_launch' }, NOON);
  assert.equal(freed.state, 'released');
  assert.equal(freed.releaseReason, 'no_launch');
  assert.equal(release(db, r2.id, { kind: 'no_launch' }).releasedAt, freed.releasedAt, 'repeat release is a no-op');
  assert.equal(readAllowance(db, { taskId: null, taskCapUsd: null, dailyCapUsd: 5, now: NOON }).dailyRemainingUsd, 2);

  h.setRun('r1', 'stopped');
  release(db, r1.id, { kind: 'exited', runId: 'r1' }, NOON);
  assert.throws(() => requireHeld(db, 'r1'), BudgetError);
  db.close();
});

test('orphaned, disconnected and unreaped runs keep their hold across lease expiry and new generations', () => {
  const f = fixture();
  f.task('t1');
  f.task('t2');
  const held = admitted(reserve(f.db, implement('t1')));
  f.run('r1', 't1');
  attachRun(f.db, held.id, 'r1');
  recordUsageDelta(f.db, { runId: 'r1', sequence: 1, taskId: 't1', projectId: 'p1', costUsd: 1, tokensIn: 10, tokensOut: 5, provenance: 'estimated', at: NOON });

  for (const status of ['lost', 'cleanup_failed']) {
    f.setRun('r1', status);
    // The claim was reassigned: lease gone, generation advanced, task queued again.
    f.db.prepare("UPDATE tasks SET status = 'queued', assignee = NULL, lease_until = ?, generation = generation + 1 WHERE id = 't1'").run(NOON - 1);
    assert.throws(() => release(f.db, held.id, { kind: 'exited', runId: 'r1' }), new RegExp(`${status}; release waits`));
    const a = readAllowance(f.db, { taskId: 't1', taskCapUsd: 3, dailyCapUsd: 5, now: NOON + 3_600_000 });
    assert.equal(a.observedTodayUsd, 1);
    assert.equal(a.heldUnspentUsd, 2, 'unspent hold stays in force');
    assert.equal(a.taskRemainingUsd, 0, 'a reclaim of the same task cannot reuse the orphan allowance');
    assert.equal(a.dailyRemainingUsd, 2);
  }
  const retry = reserve(f.db, implement('t1', { now: NOON + 3_600_000 }));
  assert.equal(retry.ok, false);

  f.setRun('r1', 'stopped');
  release(f.db, held.id, { kind: 'exited', runId: 'r1' });
  const after = readAllowance(f.db, { taskId: 't1', taskCapUsd: 3, dailyCapUsd: 5, now: NOON });
  assert.equal(after.taskRemainingUsd, 2, 'only observed spend remains charged after confirmed exit');
  assert.equal(after.dailyRemainingUsd, 4);
});

test('the launch gate fails closed and funding never resurrects a reservation or finished task', () => {
  const f = fixture();
  f.task('t1');
  f.task('done', { status: 'canceled' });
  f.run('r0', 't1');
  assert.throws(() => requireHeld(f.db, 'r0'), /no held budget reservation; refusing to launch/);
  assert.throws(() => reserve(f.db, implement('done')), /canceled; budget is not reserved/);
  assert.throws(() => reserve(f.db, implement('missing')), /Unknown task/);

  const r = admitted(reserve(f.db, implement('t1')));
  release(f.db, r.id, { kind: 'no_launch' });
  assert.throws(() => attachRun(f.db, r.id, 'r0'), /was released; reserve again/);
  assert.throws(() => requireHeld(f.db, 'r0'), BudgetError);
  const status = (f.db.prepare("SELECT status, generation FROM tasks WHERE id = 't1'").get() as { status: string; generation: number });
  assert.deepEqual({ ...status }, { status: 'running', generation: 1 }, 'budget calls never change claims');

  const next = admitted(reserve(f.db, implement('t1', { taskCapUsd: 100, dailyCapUsd: 100 })));
  assert.equal(next.amountUsd, 100);
  attachRun(f.db, next.id, 'r0');
  assert.equal(attachRun(f.db, next.id, 'r0').id, next.id, 'attach is idempotent for the same run');
  const other = admitted(reserve(f.db, implement('t1', { taskCapUsd: 200, dailyCapUsd: 300 })));
  assert.throws(() => attachRun(f.db, other.id, 'r0'), /already has a reservation/);
  f.run('rv', 't1', { role: 'review' });
  assert.throws(() => attachRun(f.db, other.id, 'rv'), /not the implement run/);
});

test('usage deltas are idempotent, ignore reordered snapshots and let provider totals correct estimates', () => {
  const f = fixture();
  f.task('t1');
  f.run('r1', 't1');
  const obs = (sequence: number, costUsd: number, provenance: 'actual' | 'estimated' | 'unknown' = 'estimated', tokensIn = 100) =>
    recordUsageDelta(f.db, { runId: 'r1', sequence, taskId: 't1', projectId: 'p1', costUsd, tokensIn, tokensOut: 10, provenance, at: NOON });

  assert.deepEqual(obs(1, 0.5), { applied: true, costDeltaUsd: 0.5, tokensInDelta: 100, tokensOutDelta: 10, totalCostUsd: 0.5, totalTokensIn: 100, totalTokensOut: 10 });
  assert.equal(obs(1, 0.5).applied, false, 'duplicate');
  assert.equal(obs(3, 0.9, 'estimated', 300).costDeltaUsd, 0.4);
  const stale = obs(2, 0.7);
  assert.equal(stale.applied, false, 'an older snapshot arriving late is ignored');
  assert.equal(stale.totalCostUsd, 0.9);
  const corrected = obs(4, 0.75, 'actual', 280);
  assert.equal(corrected.costDeltaUsd, -0.15);
  assert.equal(corrected.tokensInDelta, -20);
  assert.equal(corrected.totalCostUsd, 0.75);
  const unknown = obs(5, 0, 'unknown', 0);
  assert.equal(unknown.applied, true);
  assert.equal(unknown.costDeltaUsd, 0, 'an unmeasured snapshot does not erase measured spend');
  assert.equal(unknown.totalCostUsd, 0.75);
  assert.equal(obs(6, 0.8, 'actual', 290).costDeltaUsd, 0.05);
  assert.equal(observedSpendUsd(f.db, NOON), 0.8);
  assert.equal(readAllowance(f.db, { taskId: 't1', taskCapUsd: 3, dailyCapUsd: null, now: NOON }).taskSpentUsd, 0.8);

  assert.throws(() => recordUsageDelta(f.db, { runId: 'r1', sequence: 7, taskId: 't2', projectId: 'p1', costUsd: 1, tokensIn: 1, tokensOut: 1, provenance: 'actual' }), /different task/);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE run_id = 'r1'").get() as { n: number }).n, 5);
});

test('spend after midnight counts on the new day; corrections never inflate it', () => {
  const f = fixture();
  f.task('t1', { budget: null });
  const late = new Date(2026, 10, 7, 23, 50).getTime();
  const next = new Date(2026, 10, 8, 0, 10).getTime();
  f.run('r1', 't1', { started: late });
  f.run('r2', 't1', { started: late });
  const at = (runId: string, sequence: number, costUsd: number, when: number) =>
    recordUsageDelta(f.db, { runId, sequence, taskId: 't1', projectId: 'p1', costUsd, tokensIn: 1, tokensOut: 1, provenance: 'estimated', at: when });

  at('r1', 1, 1, late);
  at('r1', 2, 1.5, next);
  assert.equal(observedSpendUsd(f.db, late), 1);
  assert.equal(observedSpendUsd(f.db, next), 0.5, 'growth reported after midnight belongs to the new day');

  at('r2', 1, 1, late);
  at('r2', 2, 0.8, next);
  assert.equal(observedSpendUsd(f.db, next), 0.5, "yesterday's estimate corrected today does not return allowance today");
  at('r2', 3, 1.3, next + 1);
  assert.equal(observedSpendUsd(f.db, next), 1);
  at('r2', 4, 1.2, next + 2);
  assert.equal(observedSpendUsd(f.db, next), 0.9, "a same-day correction offsets that day's own spend");
  assert.equal(readAllowance(f.db, { taskId: 't1', taskCapUsd: null, dailyCapUsd: null, now: next }).taskSpentUsd, 2.7);
  assert.equal(dayKey(next), '2026-11-08');
});

test('review allowance comes from what the claim has left, inside one transaction', () => {
  const f = fixture();
  f.task('t1');
  f.task('t2', { budget: null });
  const impl = admitted(reserve(f.db, implement('t1')));
  f.run('r1', 't1');
  attachRun(f.db, impl.id, 'r1');
  recordUsageDelta(f.db, { runId: 'r1', sequence: 1, taskId: 't1', projectId: 'p1', costUsd: 2.6, tokensIn: 1, tokensOut: 1, provenance: 'actual', at: NOON });

  const review = { phase: 'review', projectId: 'p1', taskId: 't1', taskCapUsd: 3, dailyCapUsd: 5, phaseCapUsd: 1, enforcement: 'native_cap', now: NOON } as const;
  const whileRunning = readAllowance(f.db, review);
  assert.equal(whileRunning.taskRemainingUsd, 0, 'review cannot start on allowance the implementation still holds');
  f.setRun('r1', 'stopped');
  const granted = tx(f.db, () => {
    release(f.db, impl.id, { kind: 'exited', runId: 'r1' });
    return reserve(f.db, review);
  });
  const rv = admitted(granted);
  assert.ok(Math.abs((rv.amountUsd ?? 0) - 0.4) < 1e-9);
  assert.equal(rv.basis, 'task');
  assert.match(describeReservation(rv), /^\$0\.40 reserved from the task's remaining budget\. .*not verified that the provider enforces it/);

  const daily = admitted(reserve(f.db, { ...review, taskId: 't2', taskCapUsd: null }));
  assert.equal(daily.amountUsd, 1, 'an uncapped task still gets no more than the review cap');
  const tight = reserve(f.db, { ...review, taskId: 't2', taskCapUsd: null, phaseCapUsd: 5 });
  assert.equal(admitted(tight).amountUsd, 1, 'or than what is left of the day');
  assert.equal(admitted(tight).basis, 'daily');
});

test('planning reserves before the live run row and is released even when the plan was unusable', () => {
  const f = fixture();
  const plan = admitted(reserve(f.db, { phase: 'plan', projectId: 'p1', taskId: null, taskCapUsd: null, dailyCapUsd: 5, phaseCapUsd: 0.5, enforcement: 'native_cap', now: NOON }));
  assert.equal(plan.amountUsd, 0.5);
  f.run('rp', 'plan:p1', { role: 'plan' });
  attachRun(f.db, plan.id, 'rp');
  assert.equal(requireHeld(f.db, 'rp').id, plan.id);
  recordUsageDelta(f.db, { runId: 'rp', sequence: 1, taskId: null, projectId: 'p1', costUsd: 0.2, tokensIn: 1, tokensOut: 1, provenance: 'actual', at: NOON });
  f.setRun('rp', 'failed');
  release(f.db, plan.id, { kind: 'exited', runId: 'rp' });
  assert.equal(readAllowance(f.db, { taskId: null, taskCapUsd: null, dailyCapUsd: 5, now: NOON }).dailyRemainingUsd, 4.8);
  assert.throws(() => reserve(f.db, { phase: 'plan', projectId: 'p1', taskId: 't1', taskCapUsd: null, dailyCapUsd: 5, enforcement: 'reactive' }), /Planning reserves without a task/);
});

test('unlimited and partially unlimited settings', () => {
  const f = fixture();
  for (const t of ['a', 'b', 'c']) f.task(t, { budget: null });
  const free = admitted(reserve(f.db, implement('a', { taskCapUsd: null, dailyCapUsd: null })));
  assert.equal(free.amountUsd, null);
  assert.equal(free.basis, 'unlimited');
  assert.match(describeReservation(free), /No dollar limit applies/);
  assert.equal(admitted(reserve(f.db, implement('b', { taskCapUsd: null, dailyCapUsd: null }))).amountUsd, null);

  const blocked = reserve(f.db, implement('c', { taskCapUsd: null, dailyCapUsd: 5 }));
  assert.equal(blocked.ok, false, 'uncapped phases already running leave a finite day nothing to promise');
  if (!blocked.ok) assert.match(blocked.reason, /2 running phase\(s\) were admitted without a finite limit/);
  for (const r of listHeld(f.db)) release(f.db, r.id, { kind: 'no_launch' });

  const whole = admitted(reserve(f.db, implement('a', { taskCapUsd: null, dailyCapUsd: 5 })));
  assert.equal(whole.amountUsd, 5, 'daily-only: the conservative hold is the whole remaining day');
  assert.equal(whole.basis, 'daily');
  assert.equal(reserve(f.db, implement('b', { taskCapUsd: null, dailyCapUsd: 5 })).ok, false);
  f.task('capped');
  assert.equal(admitted(reserve(f.db, implement('capped', { dailyCapUsd: null }))).amountUsd, 3, 'task-only cap ignores the day');

  f.task('unmetered');
  const admission = admitted(reserve(f.db, implement('unmetered', { dailyCapUsd: null, enforcement: 'admission_only' })));
  assert.match(describeReservation(admission), /reports no usage, so its spend is unknown and cannot be stopped/);
  const lines = describeAllowance(readAllowance(f.db, { taskId: 'capped', taskCapUsd: 3, dailyCapUsd: 5, now: NOON }));
  assert.ok(lines.some((l) => /not provider-enforced caps/.test(l)));
  assert.ok(lines.includes(JEV_JUDGE_COST_NOTE));
  assert.ok(lines.some((l) => /spend so far is unknown, not zero/.test(l)));
  assert.ok(!lines.some((l) => /hard cap/i.test(l)));
});

test('inputs are bounded', () => {
  const f = fixture();
  f.task('t1');
  for (const bad of [Number.NaN, Infinity, -1, 2_000_000]) assert.throws(() => reserve(f.db, implement('t1', { dailyCapUsd: bad })), BudgetError);
  assert.throws(() => reserve(f.db, implement('t1', { minUsd: 0 })), /positive/);
  assert.throws(() => reserve(f.db, implement('x'.repeat(201))), /at most 200/);
  assert.throws(() => reserve(f.db, { ...implement('t1'), phase: 'other' as 'plan' }), /phase must be one of/);
  const base = { runId: 'r1', taskId: 't1', projectId: 'p1', costUsd: 1, tokensIn: 1, tokensOut: 1, provenance: 'actual' } as const;
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => recordUsageDelta(f.db, { ...base, sequence }), /positive safe integer/);
  assert.throws(() => recordUsageDelta(f.db, { ...base, sequence: 1, tokensIn: -1 }), BudgetError);
  assert.throws(() => recordUsageDelta(f.db, { ...base, sequence: 1, costUsd: Number.NaN }), BudgetError);
  assert.throws(() => readAllowance(f.db, { taskId: null, taskCapUsd: 3, dailyCapUsd: null }), /needs a taskId/);
  assert.throws(() => release(f.db, 'missing', { kind: 'no_launch' }), /Unknown budget reservation/);
});

test('the migration backfills history in one transaction and rolls back cleanly', () => {
  const db = openDb(':memory:');
  // Throwaway fixture: start from the pre-budget schema even if db.ts already appended this migration.
  db.exec('DROP TABLE IF EXISTS budget_reservations; DROP TABLE IF EXISTS usage_ledger;');
  const h = helpers(db);
  db.prepare("INSERT INTO projects (id, name, root, base_branch, created_at) VALUES ('p1', 'p1', '/fixture', 'main', ?)").run(NOON);
  const yesterday = new Date(2026, 10, 6, 23, 30).getTime();
  h.task('t1', { budget: 3, cost: 1.5 });
  h.task('t2', { budget: null, cost: 0 });
  h.run('old', 't1', { status: 'succeeded', started: yesterday, cost: 1.25, seq: 3, provenance: 'estimated' });
  h.run('live', 't1', { status: 'lost', started: NOON, cost: 0.25, seq: 2, provenance: 'actual' });
  h.run('live2', 't2', { status: 'running', started: NOON });
  h.run('plan', 'plan:p1', { role: 'plan', status: 'succeeded', started: NOON, cost: 0.3 });
  h.run('none', 'plan:none', { role: 'plan', status: 'succeeded', started: NOON, cost: 0.1 });
  h.run('empty', 't1', { status: 'failed', started: NOON });

  assert.throws(() => tx(db, () => { db.exec(budgetMigrationDDL); throw new Error('later migration failed'); }), /later migration failed/);
  assert.equal(hasBudgetTables(db), false, 'DDL and backfill roll back with the migration transaction');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 6);

  tx(db, () => db.exec(budgetMigrationDDL));
  const rows = db.prepare('SELECT run_id, sequence, task_id, project_id, day, cost_delta_micros FROM usage_ledger ORDER BY run_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { run_id: 'live', sequence: 2, task_id: 't1', project_id: 'p1', day: dayKey(NOON), cost_delta_micros: 250_000 },
    { run_id: 'none', sequence: 0, task_id: null, project_id: null, day: dayKey(NOON), cost_delta_micros: 100_000 },
    { run_id: 'old', sequence: 3, task_id: 't1', project_id: 'p1', day: dayKey(yesterday), cost_delta_micros: 1_250_000 },
    { run_id: 'plan', sequence: 0, task_id: null, project_id: 'p1', day: dayKey(NOON), cost_delta_micros: 300_000 },
  ]);
  assert.ok(Math.abs(observedSpendUsd(db, NOON) - 0.65) < 1e-9);
  assert.equal(observedSpendUsd(db, yesterday), 1.25);

  const legacy = listHeld(db);
  assert.deepEqual(legacy.map((r) => [r.runId, r.amountUsd, r.basis]), [['live', 1.75, 'legacy'], ['live2', null, 'legacy']]);
  assert.match(describeReservation(legacy[1]!), /already running at upgrade/);
  const t1 = readAllowance(db, { taskId: 't1', taskCapUsd: 3, dailyCapUsd: null, now: NOON });
  assert.deepEqual([t1.taskSpentUsd, t1.taskHeldUnspentUsd, t1.taskRemainingUsd], [1.5, 1.5, 0], "a legacy hold covers the task's remaining budget once");
  assert.equal(readAllowance(db, { taskId: null, taskCapUsd: null, dailyCapUsd: 25, now: NOON }).dailyRemainingUsd, 0, 'an uncapped live run blocks finite admission until it exits');
  assert.equal(recordUsageDelta(db, { runId: 'old', sequence: 3, taskId: 't1', projectId: 'p1', costUsd: 9, tokensIn: 0, tokensOut: 0, provenance: 'actual' }).applied, false,
    'the backfill keeps runs.usage_seq, so the next accepted snapshot is still usage_seq + 1');
  h.setRun('live', 'stopped');
  release(db, 'legacy-live', { kind: 'exited', runId: 'live' });
  db.close();
});
