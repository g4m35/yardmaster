import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sandbox } from './helpers.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { buildMethods, localClient } from '../src/api.ts';
import { runUtilityKey, utilities, taskHasPendingUtilities, recordUtility } from '../src/utility-records.ts';
import { processStartTime, terminateOwnedGroup, groupAlive } from '../src/proc.ts';
import { recover } from '../src/janitor.ts';

async function fixture() {
  const box = sandbox(); const coord = new Coordinator(openDb(join(box.home, 'utility.db')));
  const project = await coord.registerProject(box.repo);
  coord.addTasks(project.id, [{ title: 'Own parallel utilities', agent: 'mock' }], 'test');
  const task = coord.claimNext({ machineId: 'm-local', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  const owner = { generation: task.generation, assignee: task.assignee! };
  const run = coord.startRun(task, 'm-local', 'mock', null, '');
  const client = localClient(buildMethods(coord, { machineId: 'm-local' }));
  const utility = (operation: Parameters<typeof client['run.utility']>[0]['operation']) => client['run.utility']({ runId: run.id, taskId: task.id, owner, operation });
  return { ...box, coord, project, task, owner, run, client, utility };
}

test('concurrent utility tokens gate exit and late registration cannot resurrect an acknowledged run', async () => {
  const s = await fixture();
  try {
    for (const token of ['a', 'b']) await s.utility({ action: 'intent', token, command: 'git' });
    assert.equal(taskHasPendingUtilities(s.coord.db, s.task.id), true);
    const exit = () => s.client['run.exit']({ runId: s.run.id, taskId: s.task.id, owner: s.owner, reaped: true });
    await assert.rejects(exit(), /utilities/);
    await s.utility({ action: 'exit', token: 'a', pid: null, startedAt: null, reaped: true });
    await assert.rejects(s.utility({ action: 'spawn', token: 'a', pid: 424242, startedAt: 100 }), /live spawn intent/);
    await assert.rejects(exit(), /utilities/);
    await s.utility({ action: 'exit', token: 'b', pid: null, startedAt: null, reaped: true });
    await exit(); await exit();
    assert.equal(s.coord.getMeta(runUtilityKey(s.run.id)), null);
    await assert.rejects(s.utility({ action: 'spawn', token: 'a', pid: 424242, startedAt: 100 }), /live spawn intent/);
  } finally { s.coord.db.close(); }
});

test('scheduling holds remain fresh across direct journal writes and savepoint rollback within one pass', async () => {
  const s = await fixture();
  try {
    s.coord.pass(() => {
      assert.doesNotMatch(s.coord.blocker(s.task) ?? '', /utility|process.*recovery/);
      s.coord.db.exec('SAVEPOINT child');
      recordUtility(s.coord.db, runUtilityKey(s.run.id), { action: 'intent', token: 'rollback', command: 'git' });
      assert.match(s.coord.blocker(s.task)!, /utility/);
      s.coord.db.exec('ROLLBACK TO child');
      assert.doesNotMatch(s.coord.blocker(s.task) ?? '', /utility|process.*recovery/);
      s.coord.db.exec('RELEASE child');
      s.coord.updateRun(s.run.id, { status: 'cleanup_failed' });
      assert.match(s.coord.blocker(s.task)!, /process.*recovery/);
    });
  } finally { s.coord.db.close(); }
});

test('startup reaps every recorded utility before releasing a child-free attempt', async () => {
  const s = await fixture(); const children = [];
  try {
    for (const token of ['a', 'b']) {
      const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child); await once(child.stdout!, 'data');
      await s.utility({ action: 'intent', token, command: 'copy-fixture' });
      await s.utility({ action: 'spawn', token, pid: child.pid!, startedAt: await processStartTime(child.pid!) });
    }
    s.coord.updateRun(s.run.id, { phase: 'prepare', pid: null });
    await recover(s.coord, 'm-local', new Set(), { startup: true });
    assert.ok(children.every(child => !groupAlive(child.pid!)));
    assert.equal(s.coord.getTask(s.task.id)!.status, 'queued');
    assert.equal(s.coord.getRun(s.run.id)!.status, 'stopped');
    assert.equal(utilities(s.coord.db, runUtilityKey(s.run.id)).length, 0);
  } finally {
    for (const child of children) await terminateOwnedGroup(child.pid!, { graceMs: 20 });
    s.coord.db.close();
  }
});
