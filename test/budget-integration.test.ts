import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDb, SCHEMA_VERSION } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { listHeld, readAllowance, release, requireHeld } from '../src/budgets.ts';
import { loadConfig } from '../src/config.ts';
import { planGoalManaged } from '../src/planner.ts';
import { runAttempt, Semaphore, type StopReason } from '../src/runner.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import type { AgentEvent } from '../src/adapters/types.ts';
import { authorizeWorkerRpc, PairingStore } from '../src/pairing.ts';
import { sandbox, until } from './helpers.ts';

async function fixture(extra: Record<string, unknown> = {}) {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 }, review: { mode: 'never' }, worktree: { warmStart: 'off' }, ...extra });
  const file = join(box.home, 'budget.sqlite');
  const coord = new Coordinator(openDb(file));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm1', integrationHead: async () => 'a'.repeat(40) }));
  const add = (n: number, prompt = '@mock write result.txt correct') => coord.addTasks(project.id,
    [{ title: `Independent fixture ${n}`, prompt, files: [`file${n}.txt`], agent: 'mock' }], 'test', { force: true }).created[0]!;
  const claim = () => coord.claimNext({ machineId: 'm1', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} });
  return { ...box, file, coord, project, client, add, claim };
}
const ownerOf = (task: { generation: number; assignee: string | null }) => ({ generation: task.generation, assignee: task.assignee! });
const usage = (costUsd: number, provenance: 'actual' | 'estimated' | 'unknown' = 'actual') => ({ costUsd, tokensIn: 100, tokensOut: 10, provenance, cacheReadTokens: 0, cacheWriteTokens: null });

test('real concurrent Coordinator/API claims and starts cannot overpromise one daily allowance', async () => {
  const s = await fixture();
  const n = 6;
  for (let i = 0; i < n; i++) s.add(i);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const src = (name: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', name)).href;
  const code = `const {workerData:w,parentPort}=require('node:worker_threads');(async()=>{
    const {openDb}=await import(w.db); const {Coordinator}=await import(w.coord); const {buildMethods,localClient}=await import(w.api);
    const db=openDb(w.file); const c=new Coordinator(db); const api=localClient(buildMethods(c,{machineId:w.machine,integrationHead:async()=>'a'.repeat(40)}));
    Atomics.add(w.gate,0,1); while(Atomics.load(w.gate,0)<w.n) Atomics.wait(w.gate,0,Atomics.load(w.gate,0),5);
    const claim=await api['worker.claim']({machineId:w.machine,agents:['mock'],repos:{[w.project]:w.repo},runningByAgent:{}});
    let amount=null; if(claim){const owner={generation:claim.task.generation,assignee:claim.task.assignee};
      const runId=await api['run.start']({taskId:claim.task.id,machineId:w.machine,agent:'mock',logPath:'',owner});
      amount=(await api['run.update']({runId,patch:{},owner,launch:true})).amountUsd;}
    db.close();parentPort.postMessage({amount});
  })().catch(e=>parentPort.postMessage({error:e.stack}));`;
  try {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ amount: number | null; error?: string }>((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { db: src('db.ts'), coord: src('coordinator.ts'), api: src('api.ts'), file: s.file,
        machine: `m${i}`, gate, n, project: s.project.id, repo: s.repo } });
      let value: { amount: number | null; error?: string };
      worker.once('message', m => { value = m; }); worker.once('error', reject);
      worker.once('exit', code => code ? reject(new Error(`Worker exit ${code}`)) : resolve(value));
    })));
    assert.ok(results.every(r => !r.error), JSON.stringify(results));
    assert.deepEqual(results.flatMap(r => r.amount === null ? [] : [r.amount]).sort(), [2, 3]);
    assert.equal(listHeld(s.coord.db).reduce((a, r) => a + (r.amountUsd ?? 0), 0), 5);
    assert.equal(s.coord.listTasks(s.project.id).filter(t => t.generation === 1).length, 2);
  } finally { s.coord.db.close(); }
});

test('launch/exit gates retain unreaped holds and old usage cannot change a new lifecycle', async () => {
  const s = await fixture(); s.add(1);
  try {
    const claim = s.claim()!; const owner = ownerOf(claim.task);
    const runId = await s.client['run.start']({ taskId: claim.task.id, machineId: 'm1', agent: 'mock', logPath: '', owner });
    await assert.rejects(s.client['run.update']({ runId, patch: {}, launch: true, owner: { ...owner, generation: 99 } }), /owned|superseded/);
    assert.throws(() => release(s.coord.db, claim.reservation.id, { kind: 'exited', runId }), /running/);
    await s.client['run.usage']({ runId, taskId: claim.task.id, owner, sequence: 1, usage: usage(.6, 'estimated') });
    await s.client['run.usage']({ runId, taskId: claim.task.id, owner, sequence: 2, usage: usage(.4) });
    await s.client['run.usage']({ runId, taskId: claim.task.id, owner, sequence: 3, usage: usage(0, 'unknown') });
    s.coord.updateRun(runId, { status: 'cleanup_failed' });
    await assert.rejects(s.client['run.exit']({ runId, taskId: claim.task.id, owner, reaped: true }), /recovery/);
    assert.equal(listHeld(s.coord.db).length, 1);
    // Explicitly simulated process recovery, then historical exit proof. No lease/status-only release.
    s.coord.updateRun(runId, { status: 'stopped' });
    assert.equal(listHeld(s.coord.db).length, 1);
    await s.client['run.exit']({ runId, taskId: claim.task.id, owner, reaped: true });
    s.coord.updateTask(claim.task.id, { status: 'queued', assignee: null, machine_id: null });
    const fresh = s.claim()!;
    await s.client['run.usage']({ runId, taskId: claim.task.id, owner, sequence: 4, usage: usage(.5) });
    await s.client['run.usage']({ runId, taskId: claim.task.id, owner, sequence: 2, usage: usage(99) });
    assert.equal(s.coord.getTask(claim.task.id)!.generation, fresh.task.generation);
    assert.equal(s.coord.getTask(claim.task.id)!.cost_usd, .5);
    assert.equal(s.coord.getRun(runId)!.cost_usd, .5);
    assert.equal(s.coord.spentToday(), .5);
    assert.equal(listHeld(s.coord.db)[0]!.id, fresh.reservation.id);
    assert.equal(s.coord.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE run_id = ?').get(runId)!.n, 4);
  } finally { s.coord.db.close(); }
});

test('no-launch failure and cancel release unattached holds but lease/reclaim do not', async () => {
  const s = await fixture(); const task = s.add(1);
  try {
    const broken = localClient(buildMethods(s.coord, { machineId: 'm1', integrationHead: async () => { throw new Error('No integration head'); } }));
    await assert.rejects(broken['worker.claim']({ machineId: 'm1', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} }), /integration head/);
    assert.equal(listHeld(s.coord.db).length, 0);
    const claim = s.claim()!;
    s.coord.updateTask(task.id, { lease_until: Date.now() - 1, status: 'queued', assignee: null, machine_id: null });
    assert.equal(listHeld(s.coord.db)[0]!.id, claim.reservation.id);
    assert.equal(s.claim(), null);
    s.coord.control(task.id, 'cancel', 'test');
    assert.equal(listHeld(s.coord.db).length, 0, 'unattached hold is definitive no-launch proof');
  } finally { s.coord.db.close(); }
});

test('review admission atomically releases implementation and receives task/day remainder', async () => {
  const s = await fixture({ review: { mode: 'always', budgetUsd: 2 } }); s.add(1);
  try {
    const claim = s.claim()!; const owner = ownerOf(claim.task);
    const implementation = await s.client['run.start']({ taskId: claim.task.id, machineId: 'm1', agent: 'mock', logPath: '', owner });
    await s.client['run.usage']({ runId: implementation, taskId: claim.task.id, owner, sequence: 1, usage: usage(2.4) });
    await assert.rejects(s.client['run.start']({ taskId: claim.task.id, machineId: 'm1', agent: 'mock', logPath: '', role: 'review', owner }), /confirmed implementation exit/);
    const review = await s.client['run.start']({ taskId: claim.task.id, machineId: 'm1', agent: 'mock', logPath: '', role: 'review', implementationExited: implementation, owner });
    const held = await s.client['run.update']({ runId: review, patch: {}, launch: true, owner });
    assert.equal(held!.amountUsd, .6);
    assert.equal(listHeld(s.coord.db).length, 1);
    assert.equal(listHeld(s.coord.db)[0]!.phase, 'review');
  } finally { s.coord.db.close(); }
});

for (const outcome of ['malformed', 'canceled'] as const) test(`real ${outcome} review retains usage and releases only after exit`, async () => {
  const agent = `budget-review-${outcome}`;
  const s = await fixture({ review: { mode: 'always', required: true, budgetUsd: 1, reviewers: [agent], crossFamily: false } });
  const task = s.add(1, '@mock cost 2.6\n@mock write file1.txt correct');
  const script = join(s.root, 'review.mjs'); const marker = join(s.root, 'review-live');
  let cap: number | null | undefined;
  writeFileSync(script, `import{writeFileSync}from'node:fs';for await(const c of process.stdin){};console.log(JSON.stringify({type:'usage',tokensIn:100,tokensOut:10,costUsd:.05,cumulative:false}));writeFileSync(${JSON.stringify(marker)},'yes');${outcome === 'canceled' ? 'setTimeout(()=>{},10000);' : "console.log(JSON.stringify({type:'result',ok:true,text:'not json'}));"}`);
  registerAdapter({ name: agent, label: agent, binary: process.execPath, build: ctx => { cap = ctx.budgetUsd; return { command: process.execPath, args: [script], stdin: ctx.prompt }; }, parse: line => [JSON.parse(line) as AgentEvent] });
  const claim = s.claim()!; let stop: ((reason: StopReason, message: string) => void) | undefined;
  try {
    const operation = runAttempt({ api: s.client, machineId: 'm1', task: claim.task, project: s.project, repoPath: s.repo, agent: 'mock', model: null,
      config: loadConfig(s.repo), startPoint: 'main', verifySlots: new Semaphore(1), installed: ['mock', agent], onSpawn: fn => { stop = fn; } });
    if (outcome === 'canceled') { await until(() => existsSync(marker), Boolean, 10_000); stop!('stopped', 'test cancel'); }
    const result = await operation;
    assert.equal(result.status, 'needs_human');
    assert.ok(cap! > .3 && cap! < .4, `review receives remaining task budget, got ${cap}`);
    const review = s.coord.runsFor(task.id).find(r => r.role === 'review')!;
    assert.equal(review.cost_usd, .05);
    assert.equal(review.usage_provenance, 'actual');
    assert.equal(review.status, 'failed');
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.equal(s.coord.getTask(task.id)!.cost_usd, s.coord.runsFor(task.id).reduce((n, r) => n + r.cost_usd, 0));
  } finally { s.coord.db.close(); }
});

for (const mode of ['malformed', 'nonzero', 'spawn_failed'] as const) test(`live planning ${mode} accounts incrementally and closes its reservation`, async () => {
  const s = await fixture(); const agent = `budget-plan-${mode}`;
  const script = join(s.root, 'plan.mjs');
  writeFileSync(script, `for await(const c of process.stdin){};console.log(JSON.stringify({type:'usage',tokensIn:100,tokensOut:10,costUsd:.2,cumulative:false}));await new Promise(r=>setTimeout(r,100));console.log(JSON.stringify({type:'result',ok:true,text:'bad json'}));process.exitCode=${mode === 'nonzero' ? 1 : 0};`);
  let cap: number | null | undefined;
  registerAdapter({ name: agent, label: agent, binary: process.execPath, build: ctx => { cap = ctx.budgetUsd; return { command: mode === 'spawn_failed' ? join(s.root, 'missing') : process.execPath, args: [script], stdin: ctx.prompt }; }, parse: line => [JSON.parse(line) as AgentEvent] });
  let observedLive = false;
  const client = new Proxy(s.client, { get(target, key: keyof Client) {
    if (key !== 'plan.usage') return target[key];
    return async (p: Parameters<Client['plan.usage']>[0]) => {
      const r = s.coord.getRun(p.runId)!;
      if (p.usage.costUsd > 0) { assert.equal(r.status, 'running'); assert.ok(r.pid); assert.equal(requireHeld(s.coord.db, r.id).phase, 'plan'); observedLive = true; }
      return target['plan.usage'](p);
    };
  } });
  try {
    await assert.rejects(planGoalManaged('write something', { cwd: s.repo, agent, config: loadConfig(s.repo), client, projectId: s.project.id, machineId: 'm1' }));
    const run = s.coord.db.prepare("SELECT * FROM runs WHERE role = 'plan'").get()!;
    assert.equal(cap, 3); assert.equal(run.status, 'failed'); assert.equal(run.pid, null);
    assert.equal(run.cost_usd, mode === 'spawn_failed' ? 0 : .2);
    assert.equal(s.coord.spentToday(), mode === 'spawn_failed' ? 0 : .2);
    assert.equal(observedLive, mode !== 'spawn_failed'); assert.equal(listHeld(s.coord.db).length, 0);
  } finally { s.coord.db.close(); }
});

test('released schema5 upgrades preserve usage, live reservations and rows across restart', async () => {
  const s = await fixture(); const task = s.add(1); const claim = s.claim()!;
  const run = s.coord.startRun(claim.task, 'm1', 'mock', null, '/fixture/log');
  s.coord.updateRun(run.id, { cost_usd: .7, tokens_in: 77, tokens_out: 7 });
  s.coord.updateTask(task.id, { cost_usd: .7, tokens_in: 77, tokens_out: 7 });
  const saved = ['projects', 'tasks', 'runs'].map(table => ({ table, rows: s.coord.db.prepare(`SELECT * FROM ${table}`).all() }));
  for (const row of s.coord.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) s.coord.db.exec(`DROP TABLE "${String(row.name)}"`);
  s.coord.db.exec(readFileSync(new URL('./fixtures/schema-v5.sql', import.meta.url), 'utf8'));
  for (const { table, rows } of saved) {
    const columns = s.coord.db.prepare(`PRAGMA table_info(${table})`).all().map(c => String(c.name));
    for (const row of rows) s.coord.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c] as string | number | null));
  }
  s.coord.db.close();
  const db = openDb(s.file);
  try {
    assert.equal(SCHEMA_VERSION, 10); const coord = new Coordinator(db);
    assert.equal(coord.getRun(run.id)!.log_path, '/fixture/log'); assert.equal(coord.getTask(task.id)!.cost_usd, .7);
    assert.equal(coord.spentToday(), .7); assert.equal(listHeld(db)[0]!.amountUsd, 3);
    assert.equal(readAllowance(db, { taskId: task.id, taskCapUsd: 3, dailyCapUsd: 5 }).taskRemainingUsd, 0);
    assert.throws(() => release(db, listHeld(db)[0]!.id, { kind: 'exited', runId: run.id }), /running/);
  } finally { db.close(); }
  const reopened = openDb(s.file); try { assert.equal(listHeld(reopened).length, 1); } finally { reopened.close(); }
});

test('scoped workers can request only fenced launch authorization and cannot call planning/admin budget APIs', async () => {
  const s = await fixture(); s.add(1); const claim = s.claim()!;
  const admin = { kind: 'owner' as const, ownerId: 'personal' };
  const store = new PairingStore(s.coord.db, { ownerId: admin.ownerId });
  const invite = store.createInvitation(admin, { projectId: s.project.id });
  const { identity } = store.redeemInvitation(invite.code, 'm1');
  const owner = ownerOf(claim.task);
  try {
    const runId = await s.client['run.start']({ taskId: claim.task.id, machineId: 'm1', agent: 'mock', logPath: '', owner });
    const launch = { runId, owner, patch: {}, launch: true };
    authorizeWorkerRpc(s.coord, identity, 'run.update', launch);
    assert.equal((await s.client['run.update'](launch))!.amountUsd, 3);
    for (const method of ['plan.start', 'plan.spawning', 'plan.spawn', 'plan.usage', 'plan.finish', 'spend.record', 'budget.reserve', 'budget.release']) {
      assert.throws(() => authorizeWorkerRpc(s.coord, identity, method, {}), /not permitted|scope|denied|authorized/i);
    }
    await assert.rejects(s.client['run.update']({ runId, owner, patch: { cost_usd: 50 } }), /sequenced/);
    await assert.rejects(s.client['task.usage']({ id: claim.task.id, runId, owner, costUsd: 1, tokensIn: 1, tokensOut: 1 }), /Unsequenced/);
    assert.equal(s.coord.getTask(claim.task.id)!.cost_usd, 0);
  } finally { s.coord.db.close(); }
});

test('a plan with failed final accounting keeps its hold instead of returning unobserved allowance', async () => {
  const s = await fixture(); const agent = 'budget-plan-accounting-error'; const script = join(s.root, 'plan.mjs');
  writeFileSync(script, `for await(const c of process.stdin){};console.log(JSON.stringify({type:'usage',tokensIn:100,tokensOut:10,costUsd:.2,cumulative:false}));console.log(JSON.stringify({type:'result',ok:true,text:JSON.stringify({tasks:[{title:'Build the feature',prompt:'Build the feature'}]})}));`);
  registerAdapter({ name: agent, label: agent, binary: process.execPath, build: ctx => ({ command: process.execPath, args: [script], stdin: ctx.prompt }), parse: line => [JSON.parse(line) as AgentEvent] });
  const client = new Proxy(s.client, { get(target, key: keyof Client) {
    if (key === 'plan.usage') return async () => { throw new Error('accounting unavailable'); };
    return target[key];
  } });
  try {
    await assert.rejects(planGoalManaged('goal', { cwd: s.repo, agent, config: loadConfig(s.repo), client, projectId: s.project.id, machineId: 'm1' }), /accounting unavailable/);
    assert.equal(listHeld(s.coord.db).length, 1);
    assert.equal(s.coord.db.prepare("SELECT status FROM runs WHERE role='plan'").get()!.status, 'running');
  } finally { s.coord.db.close(); }
});

test('owner handback before run attachment proves no launch; recovery needs an explicit supervisor exit result', async () => {
  const s = await fixture(); s.add(1);
  try {
    const claim = s.claim()!;
    await s.client['task.update']({ id: claim.task.id, owner: ownerOf(claim.task), patch: { status: 'queued', assignee: null, machine_id: null, lease_until: null } });
    assert.equal(listHeld(s.coord.db).length, 0);
    const fresh = s.claim()!;
    const run = s.coord.startRun(fresh.task, 'm1', 'mock', null, '');
    s.coord.updateRun(run.id, { status: 'cleanup_failed' });
    assert.throws(() => s.coord.confirmRecoveredRunExit(run.id, { status: 'unverified' }), /did not confirm/);
    assert.equal(listHeld(s.coord.db).length, 1);
    s.coord.confirmRecoveredRunExit(run.id, { status: 'exited' });
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.equal(s.coord.getRun(run.id)!.status, 'stopped');
  } finally { s.coord.db.close(); }
});

test('every supervised runner child has durable spawn intent, registered identity, and reaped PID clearing', async () => {
  const agent = 'budget-phase-review';
  const s = await fixture({ review: { mode: 'always', required: true, reviewers: [agent], crossFamily: false }, worktree: { warmStart: 'off', setup: ['true', 'true'] } });
  const script = join(s.root, 'review.mjs');
  writeFileSync(script, `for await(const c of process.stdin){};console.log(JSON.stringify({type:'result',ok:true,text:JSON.stringify({verdict:'approve',issues:[],summary:'fine'})}));`);
  registerAdapter({ name: agent, label: agent, binary: process.execPath, build: ctx => ({ command: process.execPath, args: [script], stdin: ctx.prompt }), parse: line => [JSON.parse(line) as AgentEvent] });
  const claim = s.claim();
  // Add after adapter registration, then claim: fixture itself creates no task.
  assert.equal(claim, null);
  const task = s.add(1, '@mock write file1.txt correct');
  const actual = s.claim()!;
  const seen: string[] = [];
  const api = new Proxy(s.client, { get(target, key: keyof Client) {
    if (key !== 'run.update') return target[key];
    return async (p: Parameters<Client['run.update']>[0]) => {
      if (typeof p.patch.pid === 'number') {
        const before = s.coord.getRun(p.runId)!;
        assert.ok(before.phase?.endsWith(':spawning'), `PID registration preceded by ${before.phase}`);
        assert.equal(p.patch.phase, before.phase!.slice(0, -':spawning'.length));
        seen.push(String(p.patch.phase));
      }
      if (p.patch.pid === null) {
        const before = s.coord.getRun(p.runId)!;
        if (before.pid) { const { groupAlive } = await import('../src/proc.ts'); assert.equal(groupAlive(before.pid), false, 'PID only cleared after group exit'); }
      }
      return target['run.update'](p);
    };
  } });
  try {
    const outcome = await runAttempt({ api, machineId: 'm1', task: actual.task, project: s.project, repoPath: s.repo, agent: 'mock', model: null,
      config: loadConfig(s.repo), startPoint: 'main', verifySlots: new Semaphore(1), installed: ['mock', agent] });
    assert.equal(outcome.status, 'ready');
    assert.deepEqual(seen, ['setup', 'setup', 'agent', 'verify', 'review']);
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.ok(s.coord.runsFor(task.id).every(r => r.pid === null));
  } finally { s.coord.db.close(); }
});

test('identity-proven journal exit clears historical cleanup hold, safely requeues original generation, and replays', async () => {
  const s = await fixture(); s.add(1); const claim = s.claim()!; const owner = ownerOf(claim.task);
  try {
    const run = s.coord.startRun(claim.task, 'm1', 'mock', null, '');
    s.coord.updateRun(run.id, { status: 'cleanup_failed', phase: 'agent', pid: 123456, proc_started: 987654,
      stop_reason: 'Localized explanation may change without changing recovery behavior.' });
    s.coord.setMeta(`recovery:${run.id}`, 'remote_lease_expired');
    s.coord.updateTask(claim.task.id, { status: 'needs_human', lease_until: null, attention: 'Remote recovery is waiting for this worker to reconnect and confirm its process stopped.' });
    const acknowledge = (pid: number) => s.client['run.exit']({ runId: run.id, taskId: claim.task.id, owner, reaped: true, process: { pid, startedAt: 987654 } });
    await assert.rejects(acknowledge(123455), /identity/);
    assert.equal(listHeld(s.coord.db).length, 1);
    await acknowledge(123456); await acknowledge(123456);
    assert.equal(s.coord.getTask(claim.task.id)!.status, 'queued');
    assert.equal(s.coord.getTask(claim.task.id)!.generation, claim.task.generation);
    const newer = s.claim()!;
    await acknowledge(123456);
    assert.equal(s.coord.getTask(claim.task.id)!.generation, newer.task.generation);
    assert.equal(s.coord.getTask(claim.task.id)!.status, 'running');
  } finally { s.coord.db.close(); }
});

test('owner-only audited confirm-stopped clears PID-less spawning holds without reviving or retrying work', async () => {
  const s = await fixture(); s.add(1); let claim = s.claim()!;
  try {
    for (const phase of ['setup', 'agent', 'verify', 'review', 'plan']) {
      const run = s.coord.startRun(claim.task, 'm1', 'mock', null, '');
      s.coord.updateRun(run.id, { status: 'cleanup_failed', phase: `${phase}:spawning` });
      s.coord.updateTask(claim.task.id, { status: 'needs_human', lease_until: null });
      await assert.rejects(s.client['run.exit']({ runId: run.id, taskId: claim.task.id, owner: ownerOf(claim.task), reaped: true, noLaunchPhase: `${phase}:spawning` }), /No-launch/);
      await assert.rejects(s.client['task.control']({ id: claim.task.id, action: 'confirm-stopped', note: 'short' }), /Describe/);
      await s.client['task.control']({ id: claim.task.id, action: 'confirm-stopped', note: 'I inspected every process group and confirmed all stopped.' });
      assert.equal(s.coord.getTask(claim.task.id)!.status, 'needs_human');
      assert.equal(listHeld(s.coord.db).length, 0);
      assert.equal(s.coord.getRun(run.id)!.status, 'stopped');
      s.coord.control(claim.task.id, 'retry', 'test'); claim = s.claim()!;
    }
    assert.equal(s.coord.eventsSince(0, s.project.id, 1000).filter(e => e.kind === 'process.owner_confirmed_stopped').length, 5);
  } finally { s.coord.db.close(); }
});

test('planning spawn-window hold has a separate audited owner attestation and worker denial', async () => {
  const s = await fixture();
  try {
    const admitted = await s.client['plan.start']({ projectId: s.project.id, machineId: 'm1', agent: 'mock', model: null });
    await s.client['plan.spawning']({ runId: admitted.runId });
    await s.client['plan.finish']({ runId: admitted.runId, reaped: false, succeeded: false });
    assert.equal(listHeld(s.coord.db).length, 1);
    await s.client['plan.confirmStopped']({ runId: admitted.runId, note: 'All planner process groups were manually checked and are gone.' });
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.equal(s.coord.getRun(admitted.runId)!.status, 'stopped');
    assert.ok(s.coord.eventsSince(0, s.project.id).some(e => e.kind === 'process.owner_confirmed_stopped'));
  } finally { s.coord.db.close(); }
});
