import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { listHeld } from '../src/budgets.ts';
import { recover } from '../src/janitor.ts';
import { sandbox } from './helpers.ts';

async function fixture(machine = 'm-hub', role: 'implement' | 'review' = 'implement') {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 }, review: { mode: 'never' } });
  const file = join(box.home, 'terminal-recovery.db');
  const coord = new Coordinator(openDb(file));
  const project = await coord.registerProject(box.repo);
  const task = coord.addTasks(project.id, [{ title: 'Recover terminal allowance', agent: 'mock' }], 'fixture').created[0]!;
  const request = { machineId: machine, agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} };
  const claim = coord.claimNext(request)!.task;
  const implementation = coord.startRun(claim, machine, 'mock', null, '');
  const run = role === 'review' ? coord.startRun(claim, machine, 'mock', null, '', 'review', implementation.id) : implementation;
  coord.recordRunUsage(run.id, task.id, { generation: claim.generation, assignee: claim.assignee! }, 1,
    { costUsd: .25, tokensIn: 10, tokensOut: 2, provenance: 'actual', cacheReadTokens: null, cacheWriteTokens: null });
  return { ...box, file, coord, project, task: claim, run, request };
}

for (const role of ['implement', 'review'] as const) for (const status of ['succeeded', 'failed'] as const) test(`restart releases a terminal ${role}/${status} hold using durable idle evidence`, async () => {
  const f = await fixture('m-hub', role); let coord = f.coord;
  try {
    // The child and all utilities have stopped, but run.exit was not sent before the controller died.
    coord.updateRun(f.run.id, { status, phase: role === 'review' ? 'review' : 'collect', pid: null, proc_started: null, ended_at: Date.now(), stop_reason: 'preserved outcome' });
    coord.updateTask(f.task.id, { status: 'verifying', lease_until: Date.now() - 1 });
    await recover(coord, 'm-hub', new Set([f.task.id]));
    assert.equal(listHeld(coord.db).length, 1, 'a still-active controller owns its exit acknowledgement');
    coord.db.close(); coord = new Coordinator(openDb(f.file));
    await recover(coord, 'm-hub', new Set(), { startup: true });
    assert.equal(listHeld(coord.db).length, 0);
    assert.equal(coord.getRun(f.run.id)!.status, status, 'releasing allowance preserves the recorded outcome');
    assert.equal(coord.getRun(f.run.id)!.stop_reason, 'preserved outcome');
    assert.equal(coord.spentToday(), .25);
    const next = coord.claimNext(f.request); assert.ok(next, 'finite task allowance must admit the retry');
    assert.ok(next.task.generation > f.task.generation);
    assert.equal(listHeld(coord.db)[0]!.amountUsd, 2.75);
    await recover(coord, 'm-hub', new Set([f.task.id]));
    assert.equal(coord.spentToday(), .25, 'recovery never duplicates accounting');
  } finally { coord.db.close(); }
});

test('an exit acknowledgement during recovery does not resurrect a terminal hold', async () => {
  const f = await fixture();
  try {
    f.coord.updateRun(f.run.id, { status: 'succeeded', phase: null, pid: null, proc_started: null });
    f.coord.updateTask(f.task.id, { status: 'done' });
    queueMicrotask(() => f.coord.confirmRunExit(f.run.id, f.task.id, { generation: f.task.generation, assignee: f.task.assignee! }));
    await recover(f.coord, 'm-hub', new Set());
    assert.equal(listHeld(f.coord.db).length, 0);
    assert.equal(f.coord.getRun(f.run.id)!.status, 'succeeded');
    assert.equal(f.coord.getMeta(`recovery:${f.run.id}`), null);
    assert.equal(f.coord.getTask(f.task.id)!.status, 'done');
  } finally { f.coord.db.close(); }
});

test('attached task recovery never bypasses a live planning invocation accounting hold', async () => {
  const f = await fixture();
  try {
    const plan = f.coord.startPlan(f.project.id, 'm-hub', 'mock', null);
    await recover(f.coord, 'm-hub', new Set([f.task.id]));
    assert.ok(listHeld(f.coord.db).some(row => row.runId === plan.runId));
    assert.equal(f.coord.getRun(plan.runId)!.status, 'running');
    assert.equal(f.coord.getPlanInvocation(plan.runId)!.accountingPending, true);
  } finally { f.coord.db.close(); }
});

test('a real managed attempt preserves exit evidence across terminal write before acknowledgement', { timeout: 20_000 }, async () => {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, cleanup: { auto: false },
    worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null } });
  const file = join(box.home, 'producer.db');
  const hub = new Hub({ db: openDb(file), token: 'fixture', machineId: 'm-hub', host: '127.0.0.1', port: 0,
    tickMs: 150, includeMock: true, quiet: true });
  let terminal!: (id: string) => void;
  const finished = new Promise<string>(resolve => { terminal = resolve; });
  const write = hub.coord.updateRun.bind(hub.coord);
  hub.coord.updateRun = (id, patch) => { write(id, patch); if (patch.status === 'succeeded' && hub.coord.getRun(id)?.role === 'implement') terminal(id); };
  const acknowledge = hub.coord.confirmRunExit.bind(hub.coord);
  hub.coord.confirmRunExit = (id, ...args) => {
    if (hub.coord.getRun(id)?.status === 'succeeded') throw new Error('Fixture stopped before exit acknowledgement');
    return acknowledge(id, ...args);
  };
  let closed = false;
  try {
    await hub.start(); const project = await hub.coord.registerProject(box.repo);
    const task = hub.coord.addTasks(project.id, [{ title: 'Capture terminal crash window', prompt: '@mock write preserved.txt committed work', agent: 'mock' }], 'fixture').created[0]!;
    const runId = await finished;
    assert.equal(hub.coord.getRun(runId)!.phase, 'collect', 'the real producer must retain durable idle evidence');
    await hub.stop();
    assert.ok(listHeld(hub.coord.db).some(row => row.runId === runId));
    const worktree = hub.coord.getTask(task.id)!.worktree!;
    const spent = hub.coord.spentToday();
    hub.coord.db.close(); closed = true;
    const restored = new Coordinator(openDb(file));
    try {
      await recover(restored, 'm-hub', new Set(), { startup: true });
      assert.equal(listHeld(restored.db).length, 0);
      assert.equal(restored.getRun(runId)!.status, 'succeeded');
      assert.equal(restored.spentToday(), spent);
      assert.match(readFileSync(join(worktree, 'preserved.txt'), 'utf8'), /committed work/);
    } finally { restored.db.close(); }
  } finally { if (!closed) { await hub.stop(); hub.coord.db.close(); } }
});

for (const taskStatus of ['ready', 'done', 'canceled', 'needs_human', 'queued'] as const) test(`terminal hold recovery is independent of task state ${taskStatus}`, async () => {
  const f = await fixture();
  try {
    f.coord.updateRun(f.run.id, { status: 'succeeded', phase: 'collect', pid: null, proc_started: null });
    f.coord.updateTask(f.task.id, { status: taskStatus, attention: 'Preserve the original task explanation.' });
    await recover(f.coord, 'm-hub', new Set());
    assert.equal(listHeld(f.coord.db).length, 0);
    assert.equal(f.coord.getTask(f.task.id)!.status, taskStatus);
    assert.equal(f.coord.getTask(f.task.id)!.attention, 'Preserve the original task explanation.');
    assert.equal(f.coord.spentToday(), .25);
  } finally { f.coord.db.close(); }
});

test('an old terminal record without exit evidence stays held until the existing owner attestation', async () => {
  const f = await fixture();
  try {
    f.coord.updateRun(f.run.id, { status: 'succeeded', phase: null, pid: null, proc_started: null });
    f.coord.updateTask(f.task.id, { status: 'verifying', lease_until: Date.now() - 1 });
    await recover(f.coord, 'm-hub', new Set());
    assert.equal(listHeld(f.coord.db).length, 1);
    assert.equal(f.coord.getTask(f.task.id)!.status, 'needs_human');
    assert.equal(f.coord.getRun(f.run.id)!.status, 'cleanup_failed');
    f.coord.control(f.task.id, 'confirm-stopped', 'fixture', 'Inspected every process from this old terminal exit window; all stopped.');
    assert.equal(listHeld(f.coord.db).length, 0);
    assert.equal(f.coord.spentToday(), .25);
  } finally { f.coord.db.close(); }
});

for (const taskStatus of ['verifying', 'done'] as const) test(`offline remote terminal hold remains explicit for ${taskStatus} work`, async () => {
  const f = await fixture('m-remote');
  try {
    f.coord.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(Date.now() - 120_000, f.run.id);
    f.coord.updateRun(f.run.id, { status: 'succeeded', phase: 'collect', pid: null, proc_started: null,
      ended_at: Date.now() - 120_000 });
    f.coord.updateTask(f.task.id, { status: taskStatus, lease_until: Date.now() - 1 });
    await recover(f.coord, 'm-hub', new Set());
    assert.equal(listHeld(f.coord.db).length, 1, 'a remote idle phase is not local exit proof');
    assert.equal(f.coord.getRun(f.run.id)!.status, 'cleanup_failed');
    assert.equal(f.coord.getMeta(`recovery:${f.run.id}`), 'remote_lease_expired');
    if (taskStatus === 'verifying') assert.equal(f.coord.getTask(f.task.id)!.status, 'needs_human');
    else assert.equal(f.coord.getTask(f.task.id)!.status, 'done');
    f.coord.control(f.task.id, 'confirm-stopped', 'fixture', 'Verified all processes on the offline worker have exited.', { remote: true });
    assert.equal(listHeld(f.coord.db).length, 0);
    assert.equal(f.coord.spentToday(), .25);
  } finally { f.coord.db.close(); }
});

test('a recently finished remote run can acknowledge exit before its first machine heartbeat', async () => {
  const f = await fixture('m-remote');
  try {
    f.coord.updateRun(f.run.id, { status: 'succeeded', phase: 'collect', pid: null, proc_started: null, ended_at: Date.now() });
    f.coord.updateTask(f.task.id, { status: 'canceled' });
    await recover(f.coord, 'm-hub', new Set());
    assert.equal(f.coord.getRun(f.run.id)!.status, 'succeeded');
    assert.equal(listHeld(f.coord.db).length, 1);
    f.coord.confirmRunExit(f.run.id, f.task.id, { generation: f.task.generation, assignee: f.task.assignee! });
    assert.equal(listHeld(f.coord.db).length, 0);
    assert.equal(f.coord.spentToday(), .25);
  } finally { f.coord.db.close(); }
});
