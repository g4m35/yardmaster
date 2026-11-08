import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { type Client } from '../src/api.ts';
import { listHeld } from '../src/budgets.ts';
import { loadConfig } from '../src/config.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { fleetClient } from '../src/fleet-client.ts';
import { Hub } from '../src/hub.ts';
import { recover } from '../src/janitor.ts';
import { groupAlive } from '../src/proc.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import { WorkerLoop } from '../src/worker.ts';
import { utilities, runUtilityKey } from '../src/utility-records.ts';
import { sandbox, until } from './helpers.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const stage of ['agent', 'terminal', 'post-review', 'post-review-cancel'] as const) test(`a same-ID paired HTTP controller keeps its fresh ${stage} claim through hub recovery`, { timeout: 25_000 }, async () => {
  const postReview = stage.startsWith('post-review');
  const box = sandbox({ maxParallel: 1, review: { mode: postReview ? 'always' : 'never', reviewers: ['mock'], crossFamily: false }, cleanup: { auto: false },
    worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null } });
  const hub = new Hub({ db: openDb(join(box.home, 'same-id.db')), token: 'fixture-owner', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, tickMs: 60_000, includeMock: false, quiet: true });
  const continueTerminal = latch(); let terminalReached = false, reviewExited = false;
  let worker: WorkerLoop | undefined;
  try {
    const url = await hub.start(), project = await hub.coord.registerProject(box.repo);
    const invite = await hub.client['fleet.invite']({ projectId: project.id });
    const response = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code, machineId: hub.machineId }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const { result: paired } = await response.json() as { result: { token: string } };
    const channel = fleetClient(url, paired.token);
    const client = new Proxy(channel, { get(target, key: keyof Client) {
      if (key === 'then' as keyof Client) return undefined;
      if (key === 'run.exit') return async (params: Parameters<Client['run.exit']>[0]) => {
        const result = await target['run.exit'](params);
        if (hub.coord.getRun(params.runId)?.role === 'review') reviewExited = true;
        return result;
      };
      if (key === 'run.utility') return async (params: Parameters<Client['run.utility']>[0]) => {
        const result = await target['run.utility'](params);
        if (postReview && reviewExited && !terminalReached && params.operation.action === 'intent' && hub.coord.getRun(params.runId)?.role === 'implement') {
          terminalReached = true; await continueTerminal.promise;
        }
        return result;
      };
      if (key !== 'run.update') return target[key];
      return async (params: Parameters<Client['run.update']>[0]) => {
        const result = await target['run.update'](params);
        if (stage === 'terminal' && params.patch.status === 'succeeded') { terminalReached = true; await continueTerminal.promise; }
        return result;
      };
    } });
    worker = new WorkerLoop({ hub: url, client, machineId: hub.machineId,
      repos: () => ({ [project.id]: project.root }), agents: () => ['mock'], localConfig: () => loadConfig(),
      verifySlots: new Semaphore(1), transport: httpTransport(url, paired.token, hub.machineId) });
    const task = hub.coord.addTasks(project.id, [{ title: `Same-ID ${stage}`, agent: 'mock',
      prompt: stage === 'agent' ? '@mock sleep 20000' : '@mock write saved.txt preserved artifact' }], 'fixture').created[0]!;
    await worker.heartbeat(); await worker.tick();
    if (stage === 'terminal' || postReview) await until(() => terminalReached, value => value, 5000, 'terminal or post-review boundary');
    else await until(() => hub.coord.latestRun(task.id), run => !!run?.pid && run.phase === 'agent', 5000, 'external mock PID');
    await worker.heartbeat();
    const before = hub.coord.getTask(task.id)!, run = hub.coord.latestRun(task.id)!;
    assert.equal(worker.active.has(task.id), true); assert.equal(hub.worker.active.has(task.id), false);
    assert.ok(before.lease_until! > Date.now());
    await recover(hub.coord, hub.machineId, new Set(hub.worker.active.keys()));
    const reopened = new Coordinator(openDb(join(box.home, 'same-id.db')));
    try { await recover(reopened, hub.machineId, new Set(), { startup: true }); } finally { reopened.db.close(); }
    const after = hub.coord.getTask(task.id)!;
    assert.equal(after.status, before.status); assert.equal(after.generation, before.generation); assert.equal(after.assignee, before.assignee);
    assert.equal(hub.coord.getMeta(`http_run:${run.id}`), '1');
    assert.equal(listHeld(hub.coord.db).length, postReview ? 0 : 1);
    if (postReview) {
      const implementation = hub.coord.runsFor(task.id).find(run => run.role === 'implement')!;
      assert.equal(reviewExited, true);
      assert.equal(implementation.status, 'stopped', 'review admission already acknowledged implementation exit');
      assert.ok(utilities(hub.coord.db, runUtilityKey(implementation.id)).some(child => child.state !== 'exited'));
      assert.equal(hub.coord.getMeta(`http_run:${implementation.id}`), '1', 'phase allowance release retains controller origin');
    }
    if (stage === 'agent') {
      assert.equal(groupAlive(run.pid!), true, 'hub recovery never signals another live controller');
      hub.coord.updateTask(task.id, { lease_until: Date.now() - 1 });
      await recover(hub.coord, hub.machineId, new Set(hub.worker.active.keys()));
      assert.equal(hub.coord.getTask(task.id)!.status, 'needs_human');
      assert.equal(groupAlive(run.pid!), true, 'expiry still needs this worker journal to prove exit');
      worker.stopAll('shutdown', 'fixture stopped external controller'); await worker.drain();
      assert.equal(groupAlive(run.pid!), false);
    } else {
      if (stage === 'post-review-cancel') hub.coord.control(task.id, 'cancel', 'fixture');
      continueTerminal.release();
      await until(() => worker!.active.size, size => size === 0, 10_000, 'external controller acknowledgment');
      if (stage === 'post-review-cancel') assert.equal(hub.coord.getTask(task.id)!.status, 'canceled');
      else assert.ok(['ready', 'merging', 'done'].includes(hub.coord.getTask(task.id)!.status), hub.coord.getTask(task.id)!.attention ?? 'original artifact must be accepted');
      assert.equal(hub.coord.runsFor(task.id).length, postReview ? 2 : 1, 'no duplicate coding attempt');
    }
    assert.equal(hub.coord.getMeta(`http_run:${run.id}`), '1', 'controller origin remains factual after exit');
    assert.equal(listHeld(hub.coord.db).length, 0);
  } finally {
    continueTerminal.release(); worker?.stopAll('shutdown', 'same-ID fixture finished'); await worker?.drain();
    await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true });
  }
});

test('an offline same-ID HTTP terminal hold survives hub heartbeats and accepts explicit owner exit proof', async () => {
  const box = sandbox({ review: { mode: 'never' } });
  const hub = new Hub({ db: openDb(join(box.home, 'offline-id.db')), token: 'fixture-owner', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, tickMs: 150, includeMock: false, quiet: true });
  try {
    const url = await hub.start(), project = await hub.coord.registerProject(box.repo), client = fleetClient(url, hub.token);
    hub.coord.addTasks(project.id, [{ title: 'Offline external controller', agent: 'mock' }], 'fixture');
    const claim = await client['worker.claim']({ machineId: hub.machineId, agents: ['mock'], repos: { [project.id]: project.root } }); assert.ok(claim);
    const owner = { generation: claim.task.generation, assignee: claim.task.assignee! };
    const id = await client['run.start']({ taskId: claim.task.id, machineId: hub.machineId, agent: 'mock', owner, logPath: '' });
    hub.coord.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, id);
    hub.coord.updateRun(id, { status: 'succeeded', phase: 'collect', ended_at: Date.now() - 120_000 });
    hub.coord.updateTask(claim.task.id, { status: 'done' });
    await recover(hub.coord, hub.machineId, new Set());
    assert.equal(hub.coord.getRun(id)!.status, 'cleanup_failed'); assert.equal(listHeld(hub.coord.db).length, 1);
    assert.ok(hub.coord.getMachine(hub.machineId)!.last_seen > Date.now() - 90_000);
    hub.coord.control(claim.task.id, 'confirm-stopped', 'fixture', 'Inspected the separate worker and confirmed all its processes stopped.', { remote: true });
    assert.equal(hub.coord.getTask(claim.task.id)!.status, 'done'); assert.equal(listHeld(hub.coord.db).length, 0);
    assert.equal(hub.coord.getMeta(`http_run:${id}`), '1');
  } finally { await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true }); }
});
