import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { emptyUsage, UsageReporter } from '../src/usage.ts';
import { tx } from '../src/transaction.ts';

function fixture() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare(`INSERT INTO projects (id,name,root,base_branch,created_at) VALUES ('p','fixture','/fixture','main',?)`).run(now);
  db.prepare(`INSERT INTO tasks (id,project_id,title,prompt,fingerprint,status,tier,max_attempts,created_by,created_at,updated_at)
    VALUES ('t','p','fixture','fixture','fixture','running','standard',3,'test',?,?)`).run(now, now);
  db.prepare(`INSERT INTO runs (id,task_id,machine_id,generation,attempt,agent,status,started_at,role)
    VALUES ('r','t','m',1,1,'mock','running',?,'implement')`).run(now);
  const coord = new Coordinator(db);
  const record = (sequence: number, usage = { ...emptyUsage(), costUsd: 1, tokensIn: 10, tokensOut: 2, provenance: 'estimated' as const }) =>
    coord.recordRunUsage('r', 't', { generation: 1, assignee: 'machine:m' }, sequence, usage);
  return { db, coord, record };
}

test('1,800 identical snapshots create one ledger row and one scheduler kick, with a durable sequence fence', () => {
  const f = fixture();
  try {
    let kicks = 0;
    f.coord.onChange = () => { kicks++; };
    for (let sequence = 1; sequence <= 1800; sequence++) f.record(sequence);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get()!.n, 1);
    assert.equal(kicks, 1);
    assert.equal(f.coord.getTask('t')!.cost_usd, 1);
    assert.equal(f.coord.getRun('r')!.usage_seq, 1800);
    f.record(1799, { ...emptyUsage(), costUsd: 99, tokensIn: 99, tokensOut: 99, provenance: 'estimated' });
    assert.equal(f.coord.getRun('r')!.cost_usd, 1, 'late, different snapshots cannot undo a newer acknowledgment');
    assert.throws(() => f.coord.recordRunUsage('r', 't', { generation: 2, assignee: 'machine:m' }, 1801, emptyUsage()), /recorded run identity/);
  } finally { f.db.close(); }
});

test('usage growth uses transaction-local run totals, retains provenance/cache changes, and survives rollback', (t) => {
  const f = fixture();
  try {
    const prepare = f.db.prepare.bind(f.db);
    const history: string[] = [];
    t.mock.method(f.db, 'prepare', (sql: string) => {
      if (/SUM\((cost_delta_micros|tokens_in_delta|day_cost_micros)\)/.test(sql)) history.push(sql);
      return prepare(sql);
    });
    f.record(1);
    for (let sequence = 2; sequence <= 100; sequence++) f.record(sequence, { ...emptyUsage(), costUsd: sequence, tokensIn: sequence, tokensOut: sequence, provenance: 'estimated' });
    assert.equal(history.length, 0, 'positive growth never aggregates earlier ledger rows');
    assert.throws(() => tx(f.db, () => { f.record(101); throw new Error('rollback'); }), /rollback/);
    const actual = { ...emptyUsage(), costUsd: 100, tokensIn: 100, tokensOut: 100, provenance: 'actual' as const, cacheReadTokens: 0 };
    f.coord.recordRunUsage('r', 't', { generation: 1, assignee: 'machine:m' }, 101, actual);
    assert.equal(f.coord.getRun('r')!.usage_provenance, 'actual');
    assert.equal(f.coord.getRun('r')!.cache_read_tokens, 0);
    f.coord.recordRunUsage('r', 't', { generation: 1, assignee: 'machine:m' }, 102, emptyUsage());
    assert.equal(f.coord.getRun('r')!.cost_usd, 100, 'unknown telemetry cannot erase measured usage');
    f.record(103);
    assert.equal(f.coord.getRun('r')!.cost_usd, 1);
    assert.equal(history.length, 2, 'only downward corrections aggregate same-day spend (including the rolled-back correction)');
    assert.equal(f.coord.spentToday(), 1);
  } finally { f.db.close(); }
});

test('the reporter deduplicates acknowledged values, retries failures and sends changed finals in order', async () => {
  const attempts: number[] = [];
  const sent: string[] = [];
  let fail = true;
  const reporter = new UsageReporter(async (sequence, usage) => {
    attempts.push(sequence);
    if (fail) { fail = false; throw new Error('temporary outage'); }
    sent.push(`${usage.provenance}:${usage.costUsd}:${usage.cacheReadTokens}`);
  });
  await assert.rejects(reporter.record(emptyUsage()), /outage/);
  await reporter.record(emptyUsage());
  for (let i = 0; i < 1800; i++) await reporter.record(emptyUsage());
  await Promise.all([
    reporter.record({ ...emptyUsage(), provenance: 'estimated' }),
    reporter.record({ ...emptyUsage(), provenance: 'actual', cacheReadTokens: 0 }),
    reporter.record({ ...emptyUsage(), provenance: 'actual', cacheReadTokens: 0, costUsd: .5 }),
    reporter.record({ ...emptyUsage(), provenance: 'actual', cacheReadTokens: 0, costUsd: .5 }),
  ]);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(sent, ['unknown:0:null', 'estimated:0:null', 'actual:0:0', 'actual:0.5:0']);
});


test('unmeasured initial telemetry needs only a sequence fence; measured zero still records provenance', () => {
  const f = fixture();
  try {
    let kicks = 0; f.coord.onChange = () => { kicks++; };
    const owner = { generation: 1, assignee: 'machine:m' };
    f.coord.recordRunUsage('r', 't', owner, 1, emptyUsage());
    f.coord.recordRunUsage('r', 't', owner, 2, emptyUsage());
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get()!.n, 0);
    assert.equal(f.coord.getRun('r')!.usage_seq, 2);
    assert.equal(f.coord.getRun('r')!.cost_estimated, true, 'unknown spend is never labeled actual');
    assert.equal(kicks, 0);
    f.coord.recordRunUsage('r', 't', owner, 3, { ...emptyUsage(), provenance: 'actual' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get()!.n, 1);
    assert.equal(f.coord.getRun('r')!.usage_provenance, 'actual');
    assert.equal(kicks, 1);
  } finally { f.db.close(); }
});
