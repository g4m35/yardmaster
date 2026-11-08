import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { fleetClient } from '../src/fleet-client.ts';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { controllerActivityKey, controllerLastSeen } from '../src/controller-activity.ts';
import { recover } from '../src/janitor.ts';
import { run, groupAlive } from '../src/proc.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import { utilities, runUtilityKey } from '../src/utility-records.ts';
import { WorkerLoop, type BranchTransport } from '../src/worker.ts';
import type { Client } from '../src/api.ts';
import type { Task } from '../src/types.ts';
import { ageControllerActivity, sandbox, sh, until } from './helpers.ts';

async function pair(hub: Hub, projectId: string, machineId: string): Promise<{ client: Client; token: string }> {
  const invite = await hub.client['fleet.invite']({ projectId });
  const response = await fetch(`${hub.url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, machineId }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const { token } = (await response.json()).result as { token: string };
  return { token, client: fleetClient(hub.url, token) };
}

for (const machineId of ['m-hub', 'm-remote']) test(`healthy ${machineId} upload keeps its owned utility after the model phase ages`, { timeout: 25_000 }, async () => {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, cleanup: { auto: false }, integration: { requireApproval: true },
    worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null } });
  const hub = new Hub({ db: openDb(join(box.home, 'live-upload.db')), token: 'fixture-owner', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, tickMs: 60_000, includeMock: false, quiet: true });
  const started = join(box.root, 'bundle-preparation'), release = join(box.root, 'continue-upload');
  let worker: WorkerLoop | undefined, uploading: Task | undefined, uploaded = false;
  try {
    await hub.start(); const project = await hub.coord.registerProject(box.repo);
    const clone = join(box.root, 'separate-worker-clone'); sh(box.root, 'git', ['clone', '--no-local', '-q', box.repo, clone]);
    const channel = await pair(hub, project.id, machineId), transfer = httpTransport(hub.url, channel.token, machineId);
    const transport: BranchTransport = {
      fetchBase: (...args) => transfer.fetchBase(...args),
      async uploadBranch(task, repo, branch, base, signal) {
        uploading = task;
        // An owned preparation utility represents a bundle taking longer than the model phase's lease.
        // The subsequent real Git bundle and HTTP upload must still complete under the same claim.
        await run(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'ready');
          const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`], { cwd: repo });
        const receipt = await transfer.uploadBranch(task, repo, branch, base, signal); uploaded = true; return receipt;
      },
    };
    const cfg = resolveConfig([loadConfig(), { worktreeRoot: join(box.root, 'worker-worktrees') }]);
    worker = new WorkerLoop({ hub: hub.url, client: channel.client, machineId, repos: () => ({ [project.id]: clone }),
      agents: () => ['mock'], localConfig: () => cfg, verifySlots: new Semaphore(1), transport });
    const task = hub.coord.addTasks(project.id, [{ title: 'Keep a healthy slow upload', agent: 'mock', prompt: '@mock write saved.txt verified work' }], 'fixture').created[0]!;
    await worker.heartbeat(); await worker.tick(); await until(() => existsSync(started), value => value, 10_000, 'owned upload preparation');
    assert.ok(uploading); const runRow = hub.coord.latestRun(task.id)!;
    const child = await until(() => utilities(hub.coord.db, runUtilityKey(runRow.id)).find(child => child.state === 'live'),
      child => !!child?.pid, 5000, 'upload utility PID registration'); assert.ok(child?.pid);
    hub.coord.db.prepare('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?').run(Date.now() - 120_000, Date.now() - 120_000, runRow.id);
    await recover(hub.coord, hub.machineId, new Set());
    assert.notEqual(hub.coord.getRun(runRow.id)!.status, 'cleanup_failed', 'first upload intent supplies activity before the next heartbeat');
    ageControllerActivity(hub.coord.db, task.id);
    const old = hub.coord.getMeta(controllerActivityKey(task.id));
    await hub.client['machine.heartbeat']({ id: machineId, name: 'embedded report', info: {},
      running: [{ taskId: task.id, generation: uploading.generation }] });
    assert.equal(hub.coord.getMeta(controllerActivityKey(task.id)), old, 'embedded heartbeat cannot mask a separate controller');
    await channel.client['machine.heartbeat']({ id: machineId, name: 'stale report', info: { repos: { [project.id]: clone } },
      running: [{ taskId: task.id, generation: uploading.generation + 1 }] });
    assert.equal(hub.coord.getMeta(controllerActivityKey(task.id)), old, 'wrong generation cannot refresh upload activity');
    await worker.heartbeat();
    assert.ok(controllerLastSeen(hub.coord.db, task.id, machineId, uploading.generation)! > Date.now() - 5000);
    for (let i = 0; i < 2; i++) await recover(hub.coord, hub.machineId, new Set());
    assert.equal(groupAlive(child.pid), true); assert.equal(hub.coord.getTask(task.id)!.status, 'ready');
    assert.notEqual(hub.coord.getRun(runRow.id)!.status, 'cleanup_failed');
    writeFileSync(release, 'continue');
    await until(() => uploaded, value => value, 10_000, 'actual Git bundle and HTTP receipt');
    await until(() => worker!.active.size, value => value === 0, 5000, 'upload controller drained');
    assert.equal(hub.coord.runsFor(task.id).filter(run => run.role === 'implement').length, 1);
    assert.equal(sh(box.repo, 'git', ['rev-parse', `refs/yardmaster/accepted/${task.id}/${uploading.generation}`]), uploading.head_sha);
    assert.equal(groupAlive(child.pid), false); assert.equal(hub.coord.getMeta(`recovery:${runRow.id}`), null);
  } finally {
    writeFileSync(release, 'finish'); worker?.stopAll('shutdown', 'activity fixture finished'); await worker?.drain();
    await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true });
  }
});

test('sibling and embedded heartbeats cannot hide an abandoned ready upload or clear a fresh owner hold', async () => {
  const box = sandbox({ review: { mode: 'never' }, cleanup: { auto: false } });
  const hub = new Hub({ db: openDb(join(box.home, 'expired-upload.db')), token: 'fixture-owner', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, tickMs: 60_000, includeMock: false, quiet: true });
  try {
    await hub.start(); hub.coord.onChange = null; const project = await hub.coord.registerProject(box.repo);
    const channel = await pair(hub, project.id, hub.machineId);
    hub.coord.addTasks(project.id, [{ title: 'Offline ready upload', agent: 'mock' }], 'fixture');
    const claim = await channel.client['worker.claim']({ machineId: hub.machineId, agents: ['mock'], repos: { [project.id]: box.repo } }); assert.ok(claim);
    const owner = { generation: claim.task.generation, assignee: claim.task.assignee! };
    const id = await channel.client['run.start']({ taskId: claim.task.id, machineId: hub.machineId, agent: 'mock', owner, logPath: '' });
    await channel.client['run.update']({ runId: id, owner, patch: { status: 'succeeded', phase: 'collect', ended_at: Date.now() } });
    await channel.client['run.exit']({ runId: id, taskId: claim.task.id, owner, reaped: true });
    hub.coord.updateTask(claim.task.id, { status: 'ready', lease_until: null });
    await channel.client['run.utility']({ runId: id, taskId: claim.task.id, owner, operation: { action: 'intent', token: 'bundle', command: 'git' } });
    hub.coord.db.prepare('UPDATE runs SET started_at=?, ended_at=? WHERE id=?').run(Date.now() - 120_000, Date.now() - 120_000, id);
    ageControllerActivity(hub.coord.db, claim.task.id);
    const siblingRepo = join(box.root, 'sibling'); mkdirSync(siblingRepo); sh(siblingRepo, 'git', ['init', '-q', '-b', 'main']);
    sh(siblingRepo, 'git', ['commit', '--allow-empty', '-qm', 'fixture']);
    const sibling = await hub.coord.registerProject(siblingRepo), peer = await pair(hub, sibling.id, hub.machineId);
    const old = hub.coord.getMeta(controllerActivityKey(claim.task.id));
    await peer.client['machine.heartbeat']({ id: hub.machineId, name: 'healthy sibling', info: { repos: { [sibling.id]: siblingRepo } }, running: [] });
    await assert.rejects(peer.client['machine.heartbeat']({ id: hub.machineId, name: 'foreign report', info: {},
      running: [{ taskId: claim.task.id, generation: owner.generation }] }), /denied/i);
    assert.equal(hub.coord.getMeta(controllerActivityKey(claim.task.id)), old);
    await recover(hub.coord, hub.machineId, new Set());
    assert.equal(hub.coord.getRun(id)!.status, 'cleanup_failed');
    await channel.client['machine.heartbeat']({ id: hub.machineId, name: 'returning controller', info: { repos: { [project.id]: box.repo } },
      running: [{ taskId: claim.task.id, generation: owner.generation }] });
    await assert.rejects(hub.client['task.control']({ id: claim.task.id, action: 'confirm-stopped', remote: true,
      note: 'Owner must not attest while this exact upload controller is fresh.' }), /No PID-less process-recovery hold/);
    ageControllerActivity(hub.coord.db, claim.task.id);
    hub.coord.control(claim.task.id, 'confirm-stopped', 'fixture', 'Confirmed that this abandoned bundle utility never launched.', { remote: true });
    assert.equal(hub.coord.getRun(id)!.status, 'stopped'); assert.equal(hub.coord.getTask(claim.task.id)!.status, 'ready');
    hub.coord.control(claim.task.id, 'cancel', 'fixture'); hub.coord.control(claim.task.id, 'retry', 'fixture');
    const next = await channel.client['worker.claim']({ machineId: hub.machineId, agents: ['mock'], repos: { [project.id]: box.repo } }); assert.ok(next);
    assert.ok(next.task.generation > owner.generation);
    await channel.client['run.start']({ taskId: claim.task.id, machineId: hub.machineId, agent: 'mock', logPath: '',
      owner: { generation: next.task.generation, assignee: next.task.assignee! } });
    const currentStamp = hub.coord.getMeta(controllerActivityKey(claim.task.id));
    await channel.client['machine.heartbeat']({ id: hub.machineId, name: 'old generation', info: { repos: { [project.id]: box.repo } },
      running: [{ taskId: claim.task.id, generation: owner.generation }] });
    assert.equal(hub.coord.getMeta(controllerActivityKey(claim.task.id)), currentStamp);
    assert.equal(controllerLastSeen(hub.coord.db, claim.task.id, hub.machineId, owner.generation), 0);
    hub.coord.setMeta(controllerActivityKey(claim.task.id), '{');
    assert.equal(controllerLastSeen(hub.coord.db, claim.task.id, hub.machineId, next.task.generation), 0);
  } finally { await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true }); }
});
