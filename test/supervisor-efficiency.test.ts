import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Supervisor } from '../src/supervisor.ts';
import { beginService, finishService } from '../src/service-holds.ts';
import { sandbox } from './helpers.ts';

test('supervision shares expensive reads, lists queued tasks once, and cleans readiness without task lookups', async (t) => {
  const box = sandbox({ supervision: { queueStallMinutes: 1000 } });
  const db = openDb(join(box.home, 'supervisor.db'));
  try {
    const coord = new Coordinator(db), project = await coord.registerProject(box.repo);
    const tasks = coord.addTasks(project.id, Array.from({ length: 100 }, (_, i) => ({ title: `Queue item ${i}`, agent: 'mock' })), 'test').created;
    const supervisor = new Supervisor(coord);
    supervisor.check();
    const list = coord.listTasks.bind(coord);
    let queuedLists = 0, taskLookups = 0, budgetAggregates = 0;
    t.mock.method(coord, 'listTasks', (projectId, statuses) => {
      if (statuses?.includes('queued')) queuedLists++;
      return list(projectId, statuses);
    });
    const get = coord.getTask.bind(coord);
    t.mock.method(coord, 'getTask', (id: string) => { taskLookups++; return get(id); });
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', (sql: string) => {
      if (sql.includes('FROM usage_ledger WHERE day = ?')) budgetAggregates++;
      return prepare(sql);
    });
    supervisor.check();
    assert.equal(queuedLists, 1);
    assert.equal(taskLookups, 0);
    assert.ok(budgetAggregates <= 2, 'budget totals are shared across all queued blockers');
    coord.updateTask(tasks[0]!.id, { status: 'canceled' });
    supervisor.check();
    assert.equal(supervisor.current().length, 0);
  } finally { db.close(); }
});

test('process and service holds remain fresh inside the supervisor pass, including savepoint rollback', async (t) => {
  const box = sandbox({ supervision: { queueStallMinutes: 0.001 } });
  const db = openDb(join(box.home, 'holds.db'));
  try {
    const coord = new Coordinator(db), project = await coord.registerProject(box.repo);
    const [task] = coord.addTasks(project.id, [{ title: 'Hold fixture', agent: 'mock' }], 'test').created;
    const supervisor = new Supervisor(coord);
    const blocker = coord.blocker.bind(coord);
    const hold = { requestId: 'fixture', capability: 'test', provider: 'test', receiptPath: '/fixture' };
    let checked = false;
    t.mock.method(coord, 'blocker', (current, now) => {
      assert.equal(blocker(current, now), null);
      db.exec('SAVEPOINT fresh_hold');
      db.prepare(`INSERT INTO runs (id,task_id,machine_id,attempt,agent,status,started_at,role)
        VALUES ('r-hold',?,'m',1,'mock','cleanup_failed',?,'implement')`).run(task!.id, Date.now());
      assert.match(blocker(current, now)!, /process.*not been confirmed stopped/);
      db.exec('ROLLBACK TO fresh_hold'); db.exec('RELEASE fresh_hold');
      assert.equal(blocker(current, now), null);
      beginService(db, `task:${task!.id}`, hold, { projectId: project.id, taskIds: [task!.id] });
      assert.match(blocker(current, now)!, /Provider request fixture/);
      finishService(db, `task:${task!.id}`, hold.requestId, 'passed', true);
      assert.equal(blocker(current, now), null);
      checked = true;
      return null;
    });
    supervisor.check();
    assert.equal(checked, true);
  } finally { db.close(); }
});
