import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { fleetClient } from '../src/fleet-client.ts';
import { Hub } from '../src/hub.ts';
import { recover, planCleanup } from '../src/janitor.ts';
import { listHeld } from '../src/budgets.ts';
import { groupAlive, processStartTime, terminateOwnedGroup } from '../src/proc.ts';
import { recordUtility, runUtilityKey, taskHasPendingUtilities, utilities } from '../src/utility-records.ts';
import { WorkerJournal } from '../src/worker-journal.ts';
import { sandbox, sh } from './helpers.ts';

type Kind = 'embedded' | 'remote' | 'same-host';
async function fixture(kind: Kind, state: 'canceled' | 'ready' | 'needs_human' | 'queued' | 'done' = 'canceled') {
  const box = sandbox({ review: { mode: 'never' }, cleanup: { auto: false }, disk: { minFreeGb: 0, maxWorktreesGb: null } });
  const dbFile = join(box.home, 'utility-only.db');
  const hub = new Hub({ db: openDb(dbFile), machineId: 'm-hub', token: 'fixture-owner',
    includeMock: false, host: '127.0.0.1', port: 0, tickMs: 60_000, quiet: true });
  try {
    const url = await hub.start();
    hub.coord.onChange = null; // This fixture drives recovery explicitly, not integration of synthetic ready rows.
    const project = await hub.coord.registerProject(box.repo);
    const machine = kind === 'remote' ? 'm-worker' : hub.machineId;
    let client = hub.client;
    if (kind !== 'embedded') {
      const invitation = await hub.client['fleet.invite']({ projectId: project.id });
      const response = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: invitation.code, machineId: machine }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const paired = (await response.json()).result as { token: string };
      client = fleetClient(url, paired.token);
    }
    hub.coord.addTasks(project.id, [{ title: 'Preserve utility-only interrupted work', agent: 'mock' }], 'fixture');
    const claim = await client['worker.claim']({ machineId: machine, agents: ['mock'], repos: { [project.id]: box.repo } }); assert.ok(claim);
    const owner = { generation: claim.task.generation, assignee: claim.task.assignee! };
    const worktree = join(box.root, 'worktrees', `${project.name}-${project.id.slice(2, 8)}`, claim.task.id);
    mkdirSync(dirname(worktree), { recursive: true });
    sh(box.repo, 'git', ['worktree', 'add', '-qb', claim.task.branch!, worktree, claim.startPoint]);
    writeFileSync(join(worktree, 'unfinished.txt'), 'user work survives recovery\n');
    await client['task.update']({ id: claim.task.id, owner, patch: { worktree } });
    const run = await client['run.start']({ taskId: claim.task.id, machineId: machine, agent: 'mock', logPath: '', owner });
    await client['run.update']({ runId: run, owner, patch: { phase: 'collect' } });
    await client['run.usage']({ runId: run, taskId: claim.task.id, owner, sequence: 1,
      usage: { costUsd: .25, tokensIn: 20, tokensOut: 3, provenance: 'actual', cacheReadTokens: null, cacheWriteTokens: null } });
    const review = await client['run.start']({ taskId: claim.task.id, machineId: machine, agent: 'mock', logPath: '', owner, role: 'review', implementationExited: run });
    await client['run.update']({ runId: review, owner, patch: { status: 'succeeded', phase: 'review', ended_at: Date.now() } });
    await client['run.exit']({ runId: review, taskId: claim.task.id, owner, reaped: true });
    await client['run.utility']({ runId: run, taskId: claim.task.id, owner,
      operation: { action: 'intent', token: 'post-review', command: 'git' } });
    if (state === 'canceled') hub.coord.control(claim.task.id, 'cancel', 'fixture');
    else hub.coord.updateTask(claim.task.id, { status: state, lease_until: null });
    hub.coord.db.prepare('UPDATE runs SET started_at = ?, ended_at = ? WHERE task_id = ?').run(Date.now() - 120_000, Date.now() - 120_000, claim.task.id);
    assert.equal(listHeld(hub.coord.db).length, 0, 'both model phase allowances are already released');
    return { ...box, dbFile, hub, url, project, machine, client, task: claim.task, owner, run, worktree,
      async close() { await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true }); } };
  } catch (error) { await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true }); throw error; }
}

for (const kind of ['embedded', 'remote', 'same-host'] as const) for (const state of ['canceled', 'ready'] as const) {
  test(`${kind} ${state} utility-only hold becomes recoverable without a budget reservation`, async () => {
    const f = await fixture(kind, state);
    try {
      for (let i = 0; i < 2; i++) await recover(f.hub.coord, f.hub.machineId, new Set());
      const reopened = new Coordinator(openDb(f.dbFile));
      try { await recover(reopened, f.hub.machineId, new Set(), { startup: true }); } finally { reopened.db.close(); }
      assert.equal(f.hub.coord.getRun(f.run)!.status, 'cleanup_failed');
      assert.equal(f.hub.coord.getTask(f.task.id)!.status, state, 'recovery never revives or cancels the task');
      if (kind !== 'embedded') assert.equal(f.hub.coord.getMeta(`recovery:${f.run}`), 'remote_lease_expired');
      assert.ok(taskHasPendingUtilities(f.hub.coord.db, f.task.id));
      const plan = await planCleanup(f.hub.coord, f.project.id, { sizes: false });
      assert.ok(plan.keep.some(item => item.target === f.worktree));
      if (state === 'ready') f.hub.coord.control(f.task.id, 'cancel', 'fixture');
      f.hub.coord.control(f.task.id, 'retry', 'fixture');
      const request = { machineId: 'm-next', agents: ['mock'], repos: { [f.project.id]: f.repo } };
      assert.equal(await f.hub.client['worker.claim'](request), null, 'retry cannot overlap an unconfirmed utility');
      f.hub.coord.control(f.task.id, 'confirm-stopped', 'fixture', 'Inspected every process and confirmed this pending utility never launched.', { remote: kind !== 'embedded' });
      assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
      assert.equal(listHeld(f.hub.coord.db).length, 0); assert.equal(f.hub.coord.spentToday(), .25);
      assert.equal(readFileSync(join(f.worktree, 'unfinished.txt'), 'utf8'), 'user work survives recovery\n');
      const next = await f.hub.client['worker.claim'](request); assert.ok(next); assert.ok(next.task.generation > f.task.generation);
    } finally { await f.close(); }
  });
}

for (const state of ['needs_human', 'queued', 'done'] as const) test(`utility-only discovery includes ${state} work`, async () => {
  const f = await fixture('remote', state);
  try {
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'cleanup_failed');
    assert.equal(f.hub.coord.getTask(f.task.id)!.status, state);
    f.hub.coord.control(f.task.id, 'confirm-stopped', 'fixture', 'Confirmed that the disconnected worker has no remaining utility processes.', { remote: true });
    assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
  } finally { await f.close(); }
});

for (const kind of ['remote', 'same-host'] as const) test(`${kind} returning journal proves a utility-only exit after the model phase already exited`, async () => {
  const f = await fixture(kind), journal = new WorkerJournal(f.machine, { hub: f.url, projectIds: [f.project.id] });
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data'); const startedAt = await processStartTime(child.pid!); assert.ok(startedAt);
    await f.client['run.utility']({ runId: f.run, taskId: f.task.id, owner: f.owner,
      operation: { action: 'spawn', token: 'post-review', pid: child.pid!, startedAt } });
    await journal.acquire(f.client);
    journal.runs[f.run] = { runId: f.run, taskId: f.task.id, owner: f.owner, worktree: f.worktree, pid: null, startedAt: null,
      phase: 'collect', idlePhase: 'collect', utilities: utilities(f.hub.coord.db, runUtilityKey(f.run)) };
    journal.save();
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'cleanup_failed');
    assert.equal(groupAlive(child.pid!), true, 'hub never signals a separate controller');
    assert.equal((await journal.recover(f.client)).size, 0);
    assert.equal(groupAlive(child.pid!), false); assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'stopped'); assert.equal(f.hub.coord.getTask(f.task.id)!.status, 'canceled');
    assert.equal(f.hub.coord.spentToday(), .25); assert.deepEqual(journal.runs, {});
  } finally { journal.release(); await terminateOwnedGroup(child.pid!, { graceMs: 20 }); await f.close(); }
});

test('late utility exit during local recovery cannot resurrect an acknowledged utility-only hold', async () => {
  const f = await fixture('embedded');
  try {
    queueMicrotask(() => recordUtility(f.hub.coord.db, runUtilityKey(f.run), { action: 'exit', token: 'post-review', pid: null, startedAt: null, reaped: true }));
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'stopped'); assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
    assert.equal(f.hub.coord.getMeta(`recovery:${f.run}`), null); assert.equal(listHeld(f.hub.coord.db).length, 0);
  } finally { await f.close(); }
});

test('embedded recovery reaps a recorded utility-only child after its active controller leaves', async () => {
  const f = await fixture('embedded');
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data'); const startedAt = await processStartTime(child.pid!); assert.ok(startedAt);
    await f.client['run.utility']({ runId: f.run, taskId: f.task.id, owner: f.owner,
      operation: { action: 'spawn', token: 'post-review', pid: child.pid!, startedAt } });
    await recover(f.hub.coord, f.hub.machineId, new Set([f.task.id]));
    assert.equal(groupAlive(child.pid!), true, 'active embedded controller retains its own child');
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.equal(groupAlive(child.pid!), false); assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
    assert.equal(f.hub.coord.getTask(f.task.id)!.status, 'canceled'); assert.equal(f.hub.coord.spentToday(), .25);
    assert.equal(readFileSync(join(f.worktree, 'unfinished.txt'), 'utf8'), 'user work survives recovery\n');
  } finally { await terminateOwnedGroup(child.pid!, { graceMs: 20 }); await f.close(); }
});

test('connected remote controller keeps utility-only ownership while its heartbeat is fresh', async () => {
  const f = await fixture('remote', 'ready');
  try {
    f.hub.coord.heartbeatMachine(f.machine, 'connected worker', { agents: ['mock'], repos: { [f.project.id]: f.repo },
      maxParallel: 1, running: 0, loadPerCpu: 0, freeMemMb: 1000, platform: process.platform, version: 'fixture' });
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'stopped'); assert.equal(f.hub.coord.getMeta(`recovery:${f.run}`), null);
    assert.equal(f.hub.coord.getTask(f.task.id)!.status, 'ready'); assert.ok(taskHasPendingUtilities(f.hub.coord.db, f.task.id));
    assert.equal(existsSync(f.worktree), true);
  } finally { await f.close(); }
});

test('returning PID-less utility journal remains held until explicit owner confirmation', async () => {
  const f = await fixture('same-host'), journal = new WorkerJournal(f.machine, { hub: f.url, projectIds: [f.project.id] });
  try {
    await journal.acquire(f.client);
    journal.runs[f.run] = { runId: f.run, taskId: f.task.id, owner: f.owner, worktree: f.worktree, pid: null, startedAt: null,
      phase: 'collect', idlePhase: 'collect', utilities: utilities(f.hub.coord.db, runUtilityKey(f.run)) };
    journal.save();
    await recover(f.hub.coord, f.hub.machineId, new Set());
    assert.deepEqual(await journal.recover(f.client), new Set([f.task.id]));
    f.hub.coord.control(f.task.id, 'confirm-stopped', 'fixture', 'Confirmed every process stopped, including the unregistered utility window.', { remote: true });
    assert.equal((await journal.recover(f.client)).size, 0); assert.deepEqual(journal.runs, {});
    assert.equal(taskHasPendingUtilities(f.hub.coord.db, f.task.id), false);
    assert.equal(f.hub.coord.getTask(f.task.id)!.status, 'canceled'); assert.equal(f.hub.coord.spentToday(), .25);
  } finally { journal.release(); await f.close(); }
});

test('an earlier phase exit never bypasses pending utility, generation or spawning-main proof', async () => {
  const f = await fixture('remote');
  try {
    await recover(f.hub.coord, f.hub.machineId, new Set());
    const exit = { runId: f.run, taskId: f.task.id, owner: f.owner, reaped: true as const };
    await assert.rejects(f.client['run.exit']({ ...exit, owner: { ...f.owner, generation: f.owner.generation + 1 } }), /belong|denied/i);
    await assert.rejects(f.client['run.exit'](exit), /utilities/i);
    await f.client['run.utility']({ runId: f.run, taskId: f.task.id, owner: f.owner,
      operation: { action: 'exit', token: 'post-review', pid: null, startedAt: null, reaped: true } });
    f.hub.coord.updateRun(f.run, { phase: 'agent:spawning' });
    await assert.rejects(f.client['run.exit'](exit), /identity-proven recovery/i);
    await assert.rejects(f.client['run.exit']({ ...exit, noLaunchPhase: 'collect' }), /phase does not match/i);
    assert.equal(f.hub.coord.getRun(f.run)!.status, 'cleanup_failed');
  } finally { await f.close(); }
});
