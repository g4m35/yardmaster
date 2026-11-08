import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, tx, type Db } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { boardSummary } from '../src/api.ts';
import {
  attachRun, createAllowanceReader, dayKey, listHeld, readAllowance, recordUsageDelta, release, reserve,
  type AllowanceQuery, type ReserveRequest,
} from '../src/budgets.ts';
import { sandbox, tempDir } from './helpers.ts';

const NOON = new Date(2026, 10, 7, 12).getTime();
const src = (name: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', name)).href;
const query = (taskId: string | null, now = NOON): AllowanceQuery => ({ taskId, taskCapUsd: taskId === null ? null : 3, dailyCapUsd: 5, now });
const request = (taskId: string): ReserveRequest => ({ ...query(taskId), phase: 'implement', projectId: 'p', enforcement: 'reactive' });
function fixture(file = ':memory:') {
  const db = openDb(file);
  db.prepare("INSERT INTO projects (id,name,root,base_branch,created_at) VALUES ('p','p','/fixture','main',?)").run(NOON);
  for (const taskId of ['a', 'b', 'c']) db.prepare(`INSERT INTO tasks
    (id,project_id,title,prompt,fingerprint,status,tier,max_attempts,created_by,created_at,updated_at,budget_usd,generation)
    VALUES (?,'p',?,'p',?,'running','standard',3,'test',?,?,3,1)`).run(taskId, taskId, taskId, NOON, NOON);
  return db;
}
function run(db: Db, runId: string, taskId: string) {
  db.prepare(`INSERT INTO runs (id,task_id,attempt,machine_id,agent,status,started_at,role,generation)
    VALUES (?,?,1,'m','mock','running',?,'implement',1)`).run(runId, taskId, NOON);
}
function admitted(db: Db, taskId: string, extra: Partial<ReserveRequest> = {}) {
  const result = reserve(db, { ...request(taskId), ...extra });
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.reservation;
}

// External operations run in independent OS processes, never the test's SQLite connection.
function external(file: string, body: string, data: unknown = null): string {
  return execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { openDb } from ${JSON.stringify(src('db.ts'))};
    import { reserve, recordUsageDelta, release } from ${JSON.stringify(src('budgets.ts'))};
    const db = openDb(process.argv[1]), data = JSON.parse(process.argv[2]);
    try { ${body} } finally { db.close(); }
  `, file, JSON.stringify(data)], { encoding: 'utf8' });
}

test('display snapshot amortizes ledger aggregation and matches fresh reads for every task', (t) => {
  const db = fixture();
  try {
    const a = admitted(db, 'a');
    run(db, 'ra', 'a'); attachRun(db, a.id, 'ra');
    recordUsageDelta(db, { runId: 'ra', sequence: 1, taskId: 'a', projectId: 'p', costUsd: 1.2,
      tokensIn: 1, tokensOut: 1, provenance: 'estimated', at: NOON });
    admitted(db, 'b');
    const prepare = db.prepare.bind(db);
    let dailyReads = 0, heldReads = 0, taskAggregates = 0;
    t.mock.method(db, 'prepare', (sql: string) => {
      if (sql.includes('FROM usage_ledger WHERE day = ?')) dailyReads++;
      if (sql.includes("FROM budget_reservations r WHERE r.state = 'held'")) heldReads++;
      if (sql.includes('GROUP BY task_id')) taskAggregates++;
      return prepare(sql);
    });
    const read = createAllowanceReader(db);
    const displayed = Array.from({ length: 100 }, (_, i) => read(query(['a', 'b', 'c'][i % 3]!)));
    assert.deepEqual([dailyReads, heldReads, taskAggregates], [1, 1, 1], '100 display reads aggregate the ledger and holds once');
    for (let i = 0; i < displayed.length; i++) assert.deepEqual(displayed[i], readAllowance(db, query(['a', 'b', 'c'][i % 3]!)));
    recordUsageDelta(db, { runId: 'ra', sequence: 2, taskId: 'a', projectId: 'p', costUsd: .4,
      tokensIn: 1, tokensOut: 1, provenance: 'actual', at: NOON });
    assert.deepEqual(read(query('a')), readAllowance(db, query('a')), 'a downward correction refreshes task spend and held remainder');
    assert.equal(read(query('a')).taskSpentUsd, .4);
    const returned = read(query('b'));
    returned.availableUsd = 1000;
    assert.equal(read(query('b')).availableUsd, 0, 'mutating a displayed allowance cannot mutate the cached totals');
  } finally { db.close(); }
});

test('same-connection reserve, unknown usage, unbounded holds and release refresh an already warm reader', () => {
  const db = fixture();
  try {
    const read = createAllowanceReader(db);
    assert.equal(read(query('c')).availableUsd, 3);
    const hold = admitted(db, 'a', { dailyCapUsd: null, taskCapUsd: null });
    assert.equal(read(query('c')).unboundedHeld, 1);
    assert.equal(read(query('c')).availableUsd, 0);
    recordUsageDelta(db, { runId: 'unknown', sequence: 1, taskId: 'b', projectId: 'p', costUsd: 4,
      tokensIn: 1, tokensOut: 1, provenance: 'unknown', at: NOON });
    assert.equal(read(query('b')).taskSpentUsd, 0);
    release(db, hold.id, { kind: 'no_launch' });
    assert.equal(read(query('c')).availableUsd, 3);
    const finite = admitted(db, 'a');
    assert.equal(read(query('c')).availableUsd, 2);
    release(db, finite.id, { kind: 'no_launch' });
    assert.equal(read(query('c')).availableUsd, 3);
  } finally { db.close(); }
});

test('midnight refresh keeps all-day holds and lifetime task spend while resetting observed daily spend', () => {
  const db = fixture();
  try {
    const before = new Date(2026, 10, 7, 23, 59, 59, 999).getTime(), after = before + 1;
    const hold = admitted(db, 'a');
    run(db, 'ra', 'a'); attachRun(db, hold.id, 'ra');
    recordUsageDelta(db, { runId: 'ra', sequence: 1, taskId: 'a', projectId: 'p', costUsd: 1,
      tokensIn: 1, tokensOut: 1, provenance: 'actual', at: before });
    const read = createAllowanceReader(db);
    assert.equal(read(query('b', before)).dailyRemainingUsd, 2);
    const next = read(query('a', after));
    assert.equal(next.day, dayKey(after));
    assert.equal(next.observedTodayUsd, 0);
    assert.equal(next.heldUnspentUsd, 2);
    assert.equal(next.taskSpentUsd, 1);
    assert.equal(next.taskRemainingUsd, 0);
    assert.equal(next.dailyRemainingUsd, 3);
    assert.deepEqual(next, readAllowance(db, query('a', after)));
    // Correcting yesterday's estimate cannot grant more than today's unused daily cap.
    recordUsageDelta(db, { runId: 'ra', sequence: 2, taskId: 'a', projectId: 'p', costUsd: .2,
      tokensIn: 1, tokensOut: 1, provenance: 'actual', at: after });
    assert.deepEqual(read(query('a', after)), readAllowance(db, query('a', after)));
    assert.equal(read(query('b', after)).dailyRemainingUsd, 2.2);
  } finally { db.close(); }
});

test('a reader refreshed inside a rolled-back transaction discards that display on exit', () => {
  const db = fixture();
  try {
    const read = createAllowanceReader(db);
    assert.equal(read(query('c')).availableUsd, 3);
    assert.throws(() => tx(db, () => {
      admitted(db, 'a');
      assert.equal(read(query('c')).availableUsd, 2);
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(read(query('c')).availableUsd, 3);
    assert.equal(listHeld(db).length, 0);
  } finally { db.close(); }
});

test('separate processes warm stale displays then race fresh transactional reservations without overadmission', async () => {
  const file = join(tempDir('ym-budget-read-'), 'db.sqlite');
  const db = fixture(file);
  const read = createAllowanceReader(db);
  try {
    assert.equal(read(query('c')).availableUsd, 3);
    const workers = ['a', 'b'].map(taskId => {
      const code = `
        import { openDb } from ${JSON.stringify(src('db.ts'))};
        import { createAllowanceReader, reserve } from ${JSON.stringify(src('budgets.ts'))};
        const db = openDb(process.argv[1]), request = JSON.parse(process.argv[2]);
        const displayed = createAllowanceReader(db)(request);
        console.log('ready');
        process.stdin.once('data', () => {
          try { console.log(JSON.stringify({ displayed: displayed.availableUsd, result: reserve(db, request) })); }
          finally { db.close(); process.stdin.destroy(); }
        });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code, file, JSON.stringify(request(taskId))], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      let readyResolve: () => void;
      const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('ready\n')) readyResolve(); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise<{ displayed: number; result: ReturnType<typeof reserve> }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          readyResolve();
          if (code !== 0) reject(new Error(stderr || `Child exited ${code}`));
          else { try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)); } catch (error) { reject(error); } }
        });
      });
      return { child, ready, done };
    });
    try {
      await Promise.all(workers.map(worker => worker.ready));
      for (const worker of workers) worker.child.stdin.end('go');
      const results = await Promise.all(workers.map(worker => worker.done));
      assert.deepEqual(results.map(result => result.displayed), [3, 3], 'both processes saw the original display allowance');
      const amounts = results.map(({ result }) => { assert.ok(result.ok); return result.reservation.amountUsd!; });
      assert.deepEqual(amounts.sort(), [2, 3]);
      assert.equal(read(query('c')).availableUsd, 0, 'the original connection notices external commits');
      assert.equal(reserve(db, request('c')).ok, false);
      // Late usage above a phase's hold consumes more daily budget; stale displays cannot fund new work.
      external(file, `recordUsageDelta(db, data);`, { runId: 'late', sequence: 1, taskId: 'a', projectId: 'p', costUsd: 1,
        tokensIn: 1, tokensOut: 1, provenance: 'actual', at: NOON });
      assert.equal(read(query('c')).observedTodayUsd, 1);
      assert.equal(reserve(db, request('c')).ok, false);
      for (const held of listHeld(db)) external(file, `release(db, data.id, {kind: 'no_launch'});`, held);
      assert.equal(read(query('c')).availableUsd, 3);
      assert.equal(admitted(db, 'c').amountUsd, 3);
      assert.equal(admitted(db, 'b').amountUsd, 1, 'only the fresh daily remainder can be promised');
      assert.equal(reserve(db, request('a')).ok, false);
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.allSettled(workers.map(worker => worker.done));
    }
  } finally { db.close(); }
});

test('nested board reads update budget display within a pass after coordinator and external writes', async () => {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 }, coupling: 'off', review: { mode: 'never' } });
  const file = join(box.home, 'display.sqlite'), db = openDb(file);
  try {
    const coord = new Coordinator(db), project = await coord.registerProject(box.repo);
    const tasks = coord.addTasks(project.id, ['a', 'b', 'c'].map(name => ({ title: `Display ${name}`, agent: 'mock', files: [`${name}/**`] })), 'test', { force: true }).created;
    const waiting = (id: string) => boardSummary(coord, project.id).active.find(task => task.id === id)!.waiting;
    coord.pass(() => {
      assert.equal(waiting(tasks[2]!.id), null);
      const claim = coord.claimNext({ machineId: 'm', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!;
      const queued = tasks.filter(task => task.id !== claim.task.id);
      const run = coord.startRun(claim.task, 'm', 'mock', null, '');
      const owner = { generation: claim.task.generation, assignee: claim.task.assignee! };
      coord.recordRunUsage(run.id, claim.task.id, owner, 1, { costUsd: 4, tokensIn: 1, tokensOut: 1, provenance: 'actual', cacheReadTokens: 0, cacheWriteTokens: null });
      assert.equal(boardSummary(coord, project.id).spentToday, 4);
      const second = coord.claimNext({ machineId: 'm2', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!;
      const remaining = queued.find(task => task.id !== second.task.id)!;
      assert.match(waiting(remaining.id)!, /budget.*\$0\.00|\$0\.00.*budget/i);
      coord.abandonUnlaunchedClaim(second.task.id, second.task.generation, 'm2');
      assert.equal(waiting(remaining.id), null, 'release invalidates the display within the outer pass');
      external(file, `recordUsageDelta(db, data);`, { runId: 'late-plan', sequence: 1, taskId: null, projectId: project.id, costUsd: 1,
        tokensIn: 1, tokensOut: 1, provenance: 'actual', at: Date.now() });
      assert.equal(boardSummary(coord, project.id).spentToday, 5);
      assert.match(waiting(remaining.id)!, /\$0\.00/);
      coord.confirmRunExit(run.id, claim.task.id, owner);
      assert.match(waiting(remaining.id)!, /\$0\.00/, 'exit cannot erase measured spend');
    });
    assert.equal(boardSummary(coord, project.id).spentToday, 5);
  } finally { db.close(); }
});

test('coordinator daily display crosses local midnight inside one pass without a write', async (t) => {
  const box = sandbox();
  const db = openDb(join(box.home, 'midnight.sqlite'));
  let now = new Date(2026, 10, 7, 23, 59, 59, 999).getTime();
  t.mock.method(Date, 'now', () => now);
  try {
    const coord = new Coordinator(db);
    const project = await coord.registerProject(box.repo);
    coord.pass(() => {
      coord.recordSpend({ projectId: project.id, agent: 'mock', model: null, costUsd: 1, tokensIn: 1, tokensOut: 1, role: 'plan', machineId: 'm' });
      assert.equal(coord.spentToday(), 1);
      now++;
      assert.equal(coord.spentToday(), 0, 'a cache warmed before midnight must not keep yesterday’s spend');
      assert.equal(boardSummary(coord, project.id).spentToday, 0);
    });
    assert.equal(coord.spentToday(), 0);
  } finally { db.close(); }
});
