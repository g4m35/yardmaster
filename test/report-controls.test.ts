import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { runAttempt, Semaphore, type StopReason } from '../src/runner.ts';
import { listHeld } from '../src/budgets.ts';
import type { Client } from '../src/api.ts';
import { sandbox, sh } from './helpers.ts';
import { PairingStore, authorizeWorkerRpc } from '../src/pairing.ts';
import { recordUtility, runUtilityKey } from '../src/utility-records.ts';
import { randomUUID } from 'node:crypto';

for (const action of ['stop', 'redirect', 'lifetime abort'] as const) {
  test(`late ${action} cannot be overwritten by report completion`, async () => {
    const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' } });
    const db = openDb(join(box.home, 'control.db'));
    const hub = new Hub({ db, token: 'fixture', machineId: 'm-report', includeMock: true });
    let stop: ((reason: StopReason, message: string) => void) | undefined;
    try {
      const project = await hub.coord.registerProject(box.repo);
      const task = hub.coord.addTasks(project.id, [{ title: 'Report conventions', prompt: 'Read and report only', allowNoChanges: true, agent: 'mock' }], 'fixture').created[0]!;
      const claim = hub.coord.claimNext({ machineId: 'm-report', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!;
      let fired = false;
      const api = new Proxy(hub.client, { get(target, key: keyof Client) {
        const call = target[key];
        if (!['lesson.outcome', 'task.completeReport', 'task.update'].includes(key)) return call;
        return async (params: unknown) => {
          const completing = key === 'task.completeReport' || (key === 'task.update' && (params as { patch?: { status?: string } }).patch?.status === 'done');
          if (!fired && (action === 'lifetime abort' ? key === 'lesson.outcome' : completing)) {
            fired = true;
            if (action === 'lifetime abort') stop!('shutdown', 'Fixture lifetime aborted before acceptance');
            else hub.coord.control(task.id, action, 'fixture', action === 'redirect' ? 'GUIDE99 include deployment conventions' : undefined);
          }
          return (call as (p: unknown) => Promise<unknown>)(params);
        };
      } });
      const result = await runAttempt({ api, machineId: 'm-report', task: claim.task, project, repoPath: box.repo, agent: 'mock', model: null,
        config: hub.coord.configFor(project.id), startPoint: (await hub.integrator.head(project.id))!, verifySlots: new Semaphore(1), installed: ['mock'], onSpawn: fn => { stop = fn; } });
      assert.ok(fired, 'the last acceptance window must be exercised');
      assert.equal(result.status, action === 'stop' ? 'needs_human' : 'queued');
      const final = hub.coord.getTask(task.id)!;
      assert.notEqual(final.status, 'done');
      if (action === 'redirect') assert.match(final.retry_note!, /GUIDE99/);
      assert.equal(hub.coord.eventsSince(0, project.id, 100, task.id).filter(e => e.kind === 'task.done').length, 0);
      assert.equal(listHeld(db).length, 0);
      assert.equal(hub.coord.runsFor(task.id).some(r => ['running', 'lost', 'cleanup_failed'].includes(r.status)), false);
    } finally { await hub.stop(); db.close(); rmSync(box.root, { recursive: true, force: true }); }
  });
}

for (const allowNoChanges of [false, true]) {
  test(`paired report RPC keeps code and process fences (report allowed=${allowNoChanges})`, async () => {
    const box = sandbox(); const db = openDb(':memory:');
    const hub = new Hub({ db, token: 'fixture', machineId: 'm-hub', includeMock: true });
    try {
      const project = await hub.coord.registerProject(box.repo);
      const task = hub.coord.addTasks(project.id, [{ title: 'Report RPC boundary', allowNoChanges, agent: 'mock' }], 'fixture').created[0]!;
      const claim = hub.coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
      const owner = { generation: claim.generation, assignee: claim.assignee! };
      const run = hub.coord.startRun(claim, 'm-worker', 'mock', null, '');
      const head = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
      hub.coord.updateTask(task.id, { status: 'verifying', head_sha: head });
      hub.coord.updateRun(run.id, { status: 'succeeded', phase: 'collect', pid: null, ended_at: Date.now() });
      const store = new PairingStore(db, { ownerId: 'fixture' });
      const invitation = store.createInvitation({ kind: 'owner', ownerId: 'fixture' }, { projectId: project.id });
      const paired = store.redeemInvitation(invitation.code, 'm-worker');
      const params = { taskId: task.id, runId: run.id, owner, head, summary: 'Report result' };
      const invoke = async (p = params) => { authorizeWorkerRpc(hub.coord, paired.identity, 'task.completeReport', p); return hub.client['task.completeReport'](p); };
      assert.throws(() => authorizeWorkerRpc(hub.coord, paired.identity, 'task.update', { id: task.id, owner, patch: { status: 'done' } }), 'general done writes stay forbidden');
      if (!allowNoChanges) { await assert.rejects(invoke(), /denied/i); return; }
      await assert.rejects(invoke({ ...params, owner: { ...owner, generation: owner.generation + 1 } }));
      await assert.rejects(invoke({ ...params, head: 'f'.repeat(40) }), /explicit unchanged report/);
      hub.coord.updateRun(run.id, { pid: 123, proc_started: Date.now() });
      await assert.rejects(invoke(), /confirmed process exit/);
      hub.coord.updateRun(run.id, { pid: null, proc_started: null, touched: ['changed.ts'] });
      await assert.rejects(invoke(), /explicit unchanged report/);
      hub.coord.updateRun(run.id, { touched: [] });
      const token = randomUUID();
      recordUtility(db, runUtilityKey(run.id), { action: 'intent', token, command: 'git' });
      await assert.rejects(invoke(), /confirmed process exit/);
      recordUtility(db, runUtilityKey(run.id), { action: 'exit', token, pid: null, startedAt: null, reaped: true });
      hub.coord.control(task.id, 'stop', 'fixture');
      assert.throws(() => hub.coord.updateTaskIfOwner(task.id, owner, { status: 'done' }), /Task control pending: stop/);
      await assert.rejects(invoke(), /Task control pending: stop/);
      hub.coord.updateTask(task.id, { control: null });
      assert.equal((await invoke()).status, 'done');
      assert.equal((await invoke()).status, 'done');
      assert.equal(listHeld(db).length, 0);
      assert.equal(hub.coord.eventsSince(0, project.id, 100, task.id).filter(e => e.kind === 'task.done').length, 1);
    } finally { await hub.stop(); db.close(); rmSync(box.root, { recursive: true, force: true }); }
  });
}

test('native report completion also preserves pending stop and redirect controls', async () => {
  const box = sandbox(); const db = openDb(':memory:');
  const hub = new Hub({ db, token: 'fixture', machineId: 'm-hub', includeMock: true });
  try {
    const project = await hub.coord.registerProject(box.repo);
    for (const action of ['stop', 'redirect'] as const) {
      const task = hub.coord.addTasks(project.id, [{ title: `Native report ${action}`, allowNoChanges: true }], 'fixture').created[0]!;
      const owned = hub.coord.claimForSession(`session:${action}`, project.id, task.id)!;
      hub.coord.control(task.id, action, 'fixture', action === 'redirect' ? 'Preserve this new direction' : undefined);
      assert.throws(() => hub.coord.finishForSession(owned.assignee!, task.id, 'Report result', 'done', undefined, owned.generation), /Task control pending/);
      assert.equal(hub.coord.getTask(task.id)!.status, 'running');
      assert.equal(hub.coord.eventsSince(0, project.id, 100, task.id).filter(e => e.kind === 'task.done').length, 0);
    }
  } finally { await hub.stop(); db.close(); rmSync(box.root, { recursive: true, force: true }); }
});
