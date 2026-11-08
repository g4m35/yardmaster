import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { sandbox } from './helpers.ts';

test('prepared task and run lookups stay fresh across IDs, commits and savepoint rollback', async () => {
  const fixture = sandbox();
  const filename = join(fixture.root, 'statements.db');
  const db = openDb(filename);
  const external = openDb(filename);
  try {
    const coord = new Coordinator(db);
    const project = await coord.registerProject(fixture.repo);
    const { created: [first, second] } = coord.addTasks(project.id, [
      { title: 'First lookup task', prompt: 'first unrelated work' },
      { title: 'Second lookup task', prompt: 'second unrelated work' },
    ], 'test', { force: true });
    assert.ok(first && second);
    // Warm both statements, including the no-row result. Later inserts must remain visible.
    assert.equal(coord.getTask(first.id)?.title, first.title);
    assert.equal(coord.latestRun(first.id), null);
    assert.equal(coord.getTask(second.id)?.id, second.id);
    assert.equal(coord.getTask('missing'), null);
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('same connection', first.id);
    assert.equal(coord.getTask(first.id)?.title, 'same connection');
    external.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('external commit', first.id);
    assert.equal(coord.getTask(first.id)?.title, 'external commit');
    db.exec('SAVEPOINT task_lookup');
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('rolled back title', first.id);
    assert.equal(coord.getTask(first.id)?.title, 'rolled back title');
    db.exec('ROLLBACK TO task_lookup; RELEASE task_lookup');
    assert.equal(coord.getTask(first.id)?.title, 'external commit');
    assert.equal(coord.getTask(second.id)?.title, second.title);

    const insert = (connection: typeof db, id: string, taskId: string, startedAt: number, role = 'implement') => {
      connection.prepare(`INSERT INTO runs (id, task_id, attempt, machine_id, agent, status, started_at, role)
        VALUES (?, ?, 1, 'test-machine', 'mock', 'stopped', ?, ?)`).run(id, taskId, startedAt, role);
    };
    insert(db, 'r-first', first.id, 100);
    insert(db, 'r-other', second.id, 500);
    assert.equal(coord.latestRun(first.id)?.id, 'r-first');
    assert.equal(coord.latestRun(second.id)?.id, 'r-other');
    insert(external, 'r-external', first.id, 200);
    assert.equal(coord.latestRun(first.id)?.id, 'r-external');
    db.exec('SAVEPOINT run_lookup');
    insert(db, 'r-rollback', first.id, 300);
    assert.equal(coord.latestRun(first.id)?.id, 'r-rollback');
    db.exec('ROLLBACK TO run_lookup; RELEASE run_lookup');
    assert.equal(coord.latestRun(first.id)?.id, 'r-external');
    // Preserve the rowid tie break and implementation-role filter of the original query.
    insert(external, 'r-tied', first.id, 200);
    insert(external, 'r-review', first.id, 400, 'review');
    assert.equal(coord.latestRun(first.id)?.id, 'r-tied');
    assert.equal(coord.latestRun(second.id)?.id, 'r-other');
    assert.equal(coord.latestRun('missing'), null);
    db.prepare('UPDATE runs SET last_activity = ? WHERE id = ?').run('fresh activity', 'r-tied');
    assert.equal(coord.latestRun(first.id)?.last_activity, 'fresh activity');
  } finally {
    external.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
