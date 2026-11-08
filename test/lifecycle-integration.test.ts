import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { runAttempt, Semaphore, type StopReason } from '../src/runner.ts';
import { groupAlive } from '../src/proc.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import type { AgentEvent } from '../src/adapters/types.ts';
import type { Client } from '../src/api.ts';

async function fixture(config: Record<string, unknown> = {}, prompt = '@mock write result.txt correct') {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' }, ...config });
  const db = openDb(join(box.home, 'y.db'));
  const hub = new Hub({ db, token: 'test', machineId: 'm-fixture', includeMock: true });
  const project = await hub.coord.registerProject(box.repo);
  const task = hub.coord.addTasks(project.id, [{ title: 'Build fixture component', prompt, agent: 'mock' }], 'test').created[0]!;
  const claim = hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!;
  const startPoint = await hub.integrator.head(project.id);
  const ctx = { api: hub.client, machineId: 'm-fixture', task: claim.task, project, repoPath: box.repo, agent: 'mock', model: null,
    config: loadConfig(box.repo), startPoint: startPoint!, verifySlots: new Semaphore(1), installed: ['mock'] };
  return { ...box, db, hub, project, task, claim, ctx };
}

test('PID registration rejection reaps the coding process and closes the attempt naturally', async () => {
  const s = await fixture({}, '@mock sleep 10000\n@mock write late.txt forbidden');
  let pid = 0;
  let reject = true;
  const api = new Proxy(s.hub.client, { get(target, key: keyof Client) {
    if (key !== 'run.update') return target[key];
    return async (params: Parameters<Client['run.update']>[0]) => {
      if (reject && typeof params.patch.pid === 'number') { reject = false; pid = params.patch.pid; throw new Error('simulated PID transport rejection'); }
      return target['run.update'](params);
    };
  } });
  try {
    const outcome = await runAttempt({ ...s.ctx, api });
    assert.equal(outcome.status, 'needs_human');
    assert.ok(pid > 0);
    assert.equal(groupAlive(pid), false);
    assert.equal(s.hub.coord.latestRun(s.task.id)!.status, 'failed');
    assert.ok(!existsSync(join(s.hub.coord.getTask(s.task.id)!.worktree!, 'late.txt')));
  } finally { s.db.close(); }
});

test('a stop accepted at verification cannot become ready even before the next control poll', async () => {
  const s = await fixture();
  const api = new Proxy(s.hub.client, { get(target, key: keyof Client) {
    if (key !== 'task.update') return target[key];
    return async (params: Parameters<Client['task.update']>[0]) => {
      const result = await target['task.update'](params);
      if (params.patch.status === 'verifying') s.hub.coord.control(s.task.id, 'stop', 'test');
      return result;
    };
  } });
  try {
    await runAttempt({ ...s.ctx, api });
    assert.equal(s.hub.coord.getTask(s.task.id)!.status, 'needs_human');
    assert.equal(s.hub.coord.runsFor(s.task.id).some((r) => r.status === 'running'), false);
  } finally { s.db.close(); }
});

test('live reviewer is registered, stoppable and accounted even when canceled', async () => {
  const s = await fixture({ review: { mode: 'always', required: true, reviewers: ['review-fixture'], crossFamily: false } });
  const marker = join(s.root, 'review-started');
  const script = join(s.root, 'review.mjs');
  writeFileSync(script, `import{writeFileSync}from'node:fs';for await(const c of process.stdin){};console.log(JSON.stringify({type:'usage',tokensIn:100,tokensOut:10,costUsd:.05,cumulative:false}));writeFileSync(${JSON.stringify(marker)},'yes');setTimeout(()=>console.log(JSON.stringify({type:'result',ok:true,text:JSON.stringify({verdict:'approve',issues:[]})})),10000);`);
  registerAdapter({ name: 'review-fixture', label: 'Review fixture', binary: process.execPath,
    build: (ctx) => ({ command: process.execPath, args: [script], stdin: ctx.prompt }),
    parse: (line) => [JSON.parse(line) as AgentEvent] });
  let stop: ((reason: StopReason, message: string) => void) | undefined;
  try {
    const operation = runAttempt({ ...s.ctx, installed: ['mock', 'review-fixture'], onSpawn: (fn) => { stop = fn; } });
    const review = await until(() => s.hub.coord.runsFor(s.task.id).find((r) => r.role === 'review' && r.pid && existsSync(marker)), Boolean, 10_000, 'live review row');
    assert.ok(review && review.pid);
    assert.equal(groupAlive(review.pid), true);
    stop!('stopped', 'Stop the live review');
    await operation;
    assert.equal(groupAlive(review.pid), false);
    const final = s.hub.coord.getRun(review.id)!;
    assert.equal(final.status, 'failed');
    assert.equal(final.usage_provenance, 'actual');
    assert.equal(final.cost_usd, .05);
    assert.ok(s.hub.coord.getTask(s.task.id)!.cost_usd >= .05);
    assert.equal(s.hub.coord.getTask(s.task.id)!.status, 'needs_human');
  } finally { s.db.close(); }
});

test('late usage is sequence-idempotent and never borrows a newer claim identity', async () => {
  const s = await fixture();
  try {
    const old = s.claim.task;
    const owner = { generation: old.generation, assignee: old.assignee! };
    const run = s.hub.coord.startRun(old, 'm-fixture', 'mock', null, '');
    const usage = { costUsd: .2, tokensIn: 100, tokensOut: 10, provenance: 'estimated' as const, cacheReadTokens: 20, cacheWriteTokens: 5 };
    const record = (sequence: number, costUsd: number) => s.hub.client['run.usage']({ runId: run.id, taskId: old.id, owner, sequence, usage: { ...usage, costUsd } });
    await record(1, .2); await record(1, .2);
    s.hub.coord.updateTask(old.id, { status: 'queued', assignee: null, machine_id: null });
    const newer = s.hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!.task;
    await record(2, .3); await record(1, 999); await record(3, .25);
    assert.ok(Math.abs(s.hub.coord.getTask(old.id)!.cost_usd - .25) < 1e-9);
    assert.equal(s.hub.coord.getTask(old.id)!.generation, newer.generation);
    assert.equal(s.hub.coord.getTask(old.id)!.status, 'running');
    assert.equal(s.hub.coord.getRun(run.id)!.cost_usd, .25);
    await assert.rejects(s.hub.client['run.usage']({ runId: run.id, taskId: old.id, owner: { ...owner, generation: newer.generation }, sequence: 4, usage }), /recorded run identity/);
  } finally { s.db.close(); }
});

test('a model transition starts a fresh conversation while preserving the retry worktree', async () => {
  const previous = process.env.YARDMASTER_MOCK_RESUMABLE;
  process.env.YARDMASTER_MOCK_RESUMABLE = '1';
  const s = await fixture({}, '@mock attempt 1 write bug.txt BROKEN\n@mock attempt 2 write bug.txt fixed');
  try {
    const first = await runAttempt({ ...s.ctx, model: 'model-a' });
    assert.equal(first.status, 'queued');
    const old = s.hub.coord.getTask(s.task.id)!;
    assert.ok(old.agent_session && old.session_fingerprint);
    const next = s.hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!.task;
    const second = await runAttempt({ ...s.ctx, task: next, model: 'model-b' });
    assert.equal(second.status, 'ready');
    const final = s.hub.coord.getTask(s.task.id)!;
    assert.equal(final.worktree, old.worktree);
    assert.notEqual(final.session_fingerprint, old.session_fingerprint);
    assert.equal(s.hub.coord.latestRun(s.task.id)!.resumed, false);
    assert.ok(s.hub.coord.eventsSince(0, s.project.id, 100).some((e) => e.kind === 'task.resume_identity_changed'));
  } finally {
    if (previous === undefined) delete process.env.YARDMASTER_MOCK_RESUMABLE;
    else process.env.YARDMASTER_MOCK_RESUMABLE = previous;
    s.db.close();
  }
});
