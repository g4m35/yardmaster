import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { Coordinator, StaleAttemptError } from '../src/coordinator.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { runAttempt, Semaphore } from '../src/runner.ts';
import { nativeArtifactRef } from '../src/handoff.ts';
import { loadConfig } from '../src/config.ts';
import { Integrator } from '../src/integrator.ts';
import { WorkerLoop } from '../src/worker.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import type { AgentEvent } from '../src/adapters/types.ts';
import { listHeld } from '../src/budgets.ts';
import { authorizeWorkerRpc, PairingStore } from '../src/pairing.ts';
import { recover } from '../src/janitor.ts';
import { diskReport, planCleanup, runCleanup } from '../src/janitor.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture(config: Record<string, unknown> = {}) {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' }, ...config });
  const dbFile = join(box.home, 'handoff.db');
  const coord = new Coordinator(openDb(dbFile));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  const sessionId = coord.registerSession('native', 'native-editor', project.id, box.repo, 'm-hub');
  const task = coord.addTasks(project.id, [{ title: 'Native authored result', files: ['result.txt'], prompt: 'Never launch a coding model for this artifact' }], 'test').created[0]!;
  const claim = coord.claimForSession(sessionId, project.id, task.id)!;
  const base = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  sh(box.repo, 'git', ['checkout', '-q', '-b', 'native-result']);
  writeFileSync(join(box.repo, 'result.txt'), 'correct\n');
  sh(box.repo, 'git', ['add', 'result.txt']); sh(box.repo, 'git', ['commit', '-qm', 'native result']);
  const sha = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  const params = { sessionId, taskId: task.id, generation: claim.generation, branch: 'native-result', summary: 'native result' };
  const submit = () => client['session.finish'](params);
  const workerClaim = () => client['worker.claim']({ machineId: 'm-hub', agents: [], repos: { [project.id]: box.repo } });
  const execute = async (api: Client = client, installed: string[] = []) => {
    const next = await workerClaim(); assert.ok(next);
    return runAttempt({ api, machineId: 'm-hub', task: next.task, project, repoPath: box.repo, agent: next.route.agent, model: next.route.model,
      config: loadConfig(box.repo), startPoint: next.startPoint, verifySlots: new Semaphore(1), installed });
  };
  return { ...box, dbFile, coord, project, client, sessionId, task, claim, base, sha, params, submit, workerClaim, execute };
}

function intercept(api: Client, fn: (key: keyof Client, params: any) => void | Promise<void>): Client {
  return new Proxy(api, { get(target, key: keyof Client) { return async (params: any) => { const value = await (target[key] as (p: any) => unknown)(params); await fn(key, params); return value; }; } });
}

test('native branch submission queues an exact artifact without coding or source modification', async () => {
  const s = await fixture();
  try {
    const started = Date.now(); const submitted = await s.submit();
    assert.ok(Date.now() - started < 5000);
    assert.equal(submitted.status, 'queued'); assert.equal(submitted.head_sha, s.sha); assert.equal(submitted.ready_at, null);
    assert.equal(s.coord.renewSessionLease(s.task.id, s.sessionId, s.claim.generation), false);
    assert.equal(await s.client['worker.claim']({ machineId: 'remote', agents: ['mock'], repos: { [s.project.id]: s.repo } }), null);
    assert.equal((await s.execute()).status, 'ready');
    const accepted = s.coord.getTask(s.task.id)!;
    assert.equal(accepted.head_sha, s.sha); assert.notEqual(accepted.worktree, s.repo);
    assert.equal(sh(s.repo, 'git', ['rev-parse', 'HEAD']), s.sha);
    assert.equal(sh(s.repo, 'git', ['branch', '--show-current']), 'native-result');
    assert.equal(sh(s.repo, 'git', ['status', '--porcelain']), '');
    assert.ok(s.coord.runsFor(s.task.id).every(r => r.agent === 'native' && r.usage_provenance === 'unknown'));
    assert.deepEqual(listHeld(s.coord.db), []);
    const integrator = new Integrator(s.coord, new Semaphore(1));
    await integrator.step(s.project.id);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'done');
    assert.equal(sh(s.repo, 'git', ['show', 'yardmaster/integration:result.txt']), 'correct');
    assert.equal(sh(s.repo, 'git', ['rev-parse', 'native-result']), s.sha);
    assert.ok(existsSync(join(s.repo, 'result.txt')));
  } finally { s.coord.db.close(); }
});

for (const mutation of ['dirty', 'detached', 'wrong branch', 'remote']) test(`native capture refuses ${mutation} source and retains manual work`, async () => {
  const s = await fixture();
  try {
    if (mutation === 'dirty') writeFileSync(join(s.repo, 'manual.txt'), 'preserve me');
    if (mutation === 'detached') sh(s.repo, 'git', ['checkout', '-q', '--detach']);
    if (mutation === 'wrong branch') sh(s.repo, 'git', ['checkout', '-q', 'main']);
    if (mutation === 'remote') s.coord.db.prepare('UPDATE sessions SET machine_id = ? WHERE id = ?').run('remote', s.sessionId);
    await assert.rejects(s.submit(), /Native source|Unsupported remote native handoff/);
    assert.equal(s.coord.getTask(s.task.id)!.ready_at, null);
    assert.equal(sh(s.repo, 'git', ['rev-parse', 'native-result']), s.sha);
    if (mutation === 'dirty') assert.equal(readFileSync(join(s.repo, 'manual.txt'), 'utf8'), 'preserve me');
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

test('queued handoff survives hub restart and duplicate finish never borrows a newer generation', async () => {
  const s = await fixture();
  await s.submit(); s.coord.db.close();
  const coord = new Coordinator(openDb(s.dbFile));
  try {
    const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
    const replay = await client['session.finish'](s.params); assert.equal(replay.status, 'queued');
    const next = await client['worker.claim']({ machineId: 'm-hub', agents: [], repos: { [s.project.id]: s.repo } }); assert.ok(next);
    assert.equal((await client['session.finish'](s.params)).generation, next.task.generation);
    assert.equal(coord.runsFor(s.task.id).length, 1, 'duplicate submission cannot launch another capture');
    await assert.rejects(client['session.finish']({ ...s.params, branch: undefined }), StaleAttemptError);
    const result = await runAttempt({ api: client, machineId: 'm-hub', task: next.task, project: s.project, repoPath: s.repo, agent: next.route.agent, model: null,
      config: loadConfig(s.repo), startPoint: next.startPoint, verifySlots: new Semaphore(1), installed: [] });
    assert.equal(result.status, 'ready');
    assert.deepEqual(listHeld(coord.db), []);
  } finally { coord.db.close(); }
});

for (const phase of ['before verification', 'during checks']) test(`source edits ${phase} do not invalidate the captured artifact`, async () => {
  const s = await fixture();
  const move = () => { writeFileSync(join(s.repo, 'manual.txt'), 'manual commit'); sh(s.repo, 'git', ['add', 'manual.txt']); sh(s.repo, 'git', ['commit', '-qm', 'manual after capture']); };
  try {
    await s.submit();
    if (phase === 'before verification') move();
    const api = intercept(s.client, (key, p) => { if (phase === 'during checks' && key === 'task.update' && p.patch.status === 'verifying') move(); });
    assert.equal((await s.execute(api)).status, 'ready');
    assert.equal(s.coord.getTask(s.task.id)!.head_sha, s.sha);
    assert.equal(sh(s.repo, 'git', ['rev-parse', nativeArtifactRef(s.task.id, s.claim.generation)]), s.sha);
    assert.equal(readFileSync(join(s.repo, 'manual.txt'), 'utf8'), 'manual commit');
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

for (const command of ['echo mutation >> result.txt', 'git commit --allow-empty -qm mutated']) test(`mutating check cannot validate native SHA: ${command}`, async () => {
  const s = await fixture();
  try {
    s.coord.updateTask(s.task.id, { verify: [command] });
    await s.submit(); const result = await s.execute(); assert.equal(result.status, 'needs_human');
    const failed = s.coord.getTask(s.task.id)!;
    assert.match(failed.attention!, /Verification changed HEAD/);
    assert.ok(existsSync(failed.worktree!));
    assert.equal(sh(s.repo, 'git', ['rev-parse', 'HEAD']), s.sha);
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

test('required unavailable review never reports verified ready', async () => {
  const s = await fixture({ review: { required: true, reviewers: ['unavailable'], crossFamily: false } });
  try {
    await s.submit(); assert.equal((await s.execute()).status, 'needs_human');
    assert.match(s.coord.getTask(s.task.id)!.attention!, /Required review did not complete/);
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

for (const verdict of ['approve', 'request_changes']) test(`native ${verdict} review binds SHA and accounts once without coding rerun`, async () => {
  const s = await fixture({ review: { required: true, reviewers: ['native-test-reviewer'], crossFamily: false } });
  const script = join(s.root, 'review.mjs');
  writeFileSync(script, `for await(const c of process.stdin){}; console.log(JSON.stringify({type:'usage',tokensIn:10,tokensOut:5,costUsd:.02,cumulative:false}));console.log(JSON.stringify({type:'result',ok:true,text:JSON.stringify({verdict:${JSON.stringify(verdict)},issues:${verdict === 'approve' ? '[]' : "[{severity:'major',note:'Fix this exact issue'}]"}})}));`);
  registerAdapter({ name: 'native-test-reviewer', label: 'Mock native reviewer', binary: process.execPath,
    build: ctx => ({ command: process.execPath, args: [script], stdin: ctx.prompt }), parse: line => [JSON.parse(line) as AgentEvent] });
  try {
    await s.submit(); assert.equal((await s.execute(s.client, ['native-test-reviewer'])).status, verdict === 'approve' ? 'ready' : 'needs_human');
    const review = s.coord.runsFor(s.task.id).find(r => r.role === 'review')!;
    assert.equal(review.verdict_sha, s.sha); assert.equal(review.cost_usd, .02);
    assert.equal(s.coord.getTask(s.task.id)!.cost_usd, .02);
    assert.equal(s.coord.runsFor(s.task.id).filter(r => r.role === 'implement').length, 2, 'capture and artifact checks only');
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

for (const action of ['cancel', 'expired lease']) test(`${action} at native verification cannot become ready`, async () => {
  const s = await fixture();
  try {
    await s.submit();
    const api = intercept(s.client, (key, p) => { if (key === 'task.update' && p.patch.status === 'verifying') {
      if (action === 'cancel') s.coord.control(s.task.id, 'cancel', 'test'); else s.coord.updateTask(s.task.id, { lease_until: Date.now() - 1 });
    } });
    await s.execute(api).catch(error => assert.match(error.message, /no longer owned|claim|canceled/i));
    assert.notEqual(s.coord.getTask(s.task.id)!.status, 'ready');
    assert.equal(sh(s.repo, 'git', ['rev-parse', 'HEAD']), s.sha);
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

test('cancel and native reclaim fence an old queued generation and release only scoped locks', async () => {
  const s = await fixture();
  try {
    const other = s.coord.addTasks(s.project.id, [{ title: 'Other session task', files: ['other.txt'] }], 'test').created[0]!;
    s.coord.claimForSession(s.sessionId, s.project.id, other.id);
    s.coord.claimLocks(s.project.id, s.sessionId, ['result.txt', 'other.txt', 'manual/**'], 'native', 30);
    const queued = await s.submit();
    assert.deepEqual(s.coord.activeLocks(s.project.id).map(l => l.pattern).sort(), ['manual/**', 'other.txt']);
    s.coord.control(s.task.id, 'cancel', 'test');
    await assert.rejects(s.submit(), /Native handoff is canceled/, 'lost-response retry cannot resurrect canceled job');
    s.coord.control(s.task.id, 'retry', 'test');
    const next = s.coord.claimForSession(s.sessionId, s.project.id, s.task.id)!;
    assert.ok(next.generation > queued.generation); assert.equal(next.native_handoff, null);
    await assert.rejects(s.submit(), StaleAttemptError);
    await assert.rejects(s.client['session.finish']({ ...s.params, generation: undefined }), /valid claim generation/);
    assert.equal((await s.client['session.finish']({ sessionId: s.sessionId, taskId: next.id, generation: next.generation, summary: 'reported only' })).status, 'done');
  } finally { s.coord.db.close(); }
});

test('interrupted capture is recovered without inventing an artifact or launching coding', async () => {
  const s = await fixture();
  try {
    const started = s.coord.beginSessionHandoff(s.sessionId, s.task.id, s.claim.generation, 'native-result', 'm-hub', 'capture interrupted');
    await assert.rejects(s.submit(), /capture is still in progress/);
    s.coord.confirmRunExit(started.run!.id, s.task.id, { generation: started.task.generation, assignee: started.task.assignee! });
    s.coord.updateTask(s.task.id, { lease_until: Date.now() - 1 });
    await recover(s.coord, 'm-hub', new Set());
    assert.equal(await s.workerClaim(), null);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'queued');
    assert.match(s.coord.blocker(s.coord.getTask(s.task.id)!)!, /native client.*take.*again/);
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});

test('native redirect and failed-capture replay explain taking the task again without reporting success', async () => {
  const s = await fixture();
  try {
    writeFileSync(join(s.repo, 'scratch.txt'), 'keep');
    await assert.rejects(s.submit(), /Take this task again/);
    const count = s.coord.runsFor(s.task.id).length;
    await assert.rejects(s.submit(), /capture did not complete/);
    assert.throws(() => s.coord.control(s.task.id, 'redirect', 'test', 'do something else'), /native client.*take this task again/);
    assert.equal(s.coord.runsFor(s.task.id).length, count);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'needs_human');
  } finally { s.coord.db.close(); }
});

for (const laterCommit of [false, true]) test(`historical native checkouts retain task ownership and guarded cleanup (later manual commit=${laterCommit})`, async () => {
  const s = await fixture({ cleanup: { auto: false, deleteMergedBranches: true } });
  try {
    s.coord.updateTask(s.task.id, { verify: ['node -e "process.exit(1)"'] });
    await s.submit(); assert.equal((await s.execute()).status, 'needs_human');
    const old = s.coord.getTask(s.task.id)!.worktree!;
    if (laterCommit) {
      writeFileSync(join(old, 'manual.txt'), 'Preserve unmerged inspection');
      sh(old, 'git', ['add', '-A']); sh(old, 'git', ['commit', '-qm', 'inspection commit']);
    }
    const claim = s.coord.claimForSession(s.sessionId, s.project.id, s.task.id)!;
    writeFileSync(join(s.repo, 'result.txt'), 'fixed\n'); sh(s.repo, 'git', ['commit', '-qam', 'native fix']);
    s.coord.updateTask(s.task.id, { verify: [] });
    await s.client['session.finish']({ ...s.params, generation: claim.generation });
    assert.equal((await s.execute()).status, 'ready');
    await new Integrator(s.coord, new Semaphore(1)).step(s.project.id);
    const latest = s.coord.getTask(s.task.id)!.worktree;
    const report = await diskReport(s.coord, s.project.id);
    assert.equal(report.worktrees.find(w => w.path === old)!.taskId, s.task.id);
    const plan = await planCleanup(s.coord, s.project.id, { sizes: false });
    if (laterCommit) {
      assert.ok(plan.keep.some(item => item.target === old && /never merged/.test(item.reason)));
      assert.equal(readFileSync(join(old, 'manual.txt'), 'utf8'), 'Preserve unmerged inspection');
    } else {
      assert.ok(plan.remove.some(item => item.target === old && item.taskId === s.task.id));
      const result = await runCleanup(s.coord, { keep: plan.keep, remove: plan.remove.filter(item => item.kind === 'worktree' && item.target === old) });
      assert.deepEqual(result.failed, []); assert.equal(existsSync(old), false);
      assert.equal(s.coord.getTask(s.task.id)!.worktree, latest, 'retiring an old generation cannot clear the current checkout pointer');
    }
    assert.equal(sh(s.repo, 'git', ['branch', '--show-current']), 'native-result');
  } finally { s.coord.db.close(); }
});

test('long checks run in ordinary WorkerLoop after prompt submission and can be stopped/reaped', async () => {
  const s = await fixture();
  let pid: number | null = null;
  const client = intercept(s.client, (key, p) => { if (key === 'run.update' && p.patch.phase === 'verify' && p.patch.pid) pid = p.patch.pid; });
  const worker = new WorkerLoop({ client, machineId: 'm-hub', repos: () => ({ [s.project.id]: s.repo }), agents: () => [], localConfig: () => loadConfig(s.repo), verifySlots: new Semaphore(1) });
  try {
    s.coord.updateTask(s.task.id, { verify: ['node -e "setTimeout(()=>{},30000)"'] });
    const time = Date.now(); await s.submit(); assert.ok(Date.now() - time < 5000);
    await worker.tick();
    await until(() => pid, Boolean, 10000, 'native check PID');
    s.coord.control(s.task.id, 'cancel', 'test');
    await worker.drain(10000);
    assert.equal(worker.active.size, 0); assert.equal(s.coord.getTask(s.task.id)!.status, 'canceled');
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { worker.stopAll('shutdown', 'fixture cleanup'); await worker.drain(10000); s.coord.db.close(); }
});


test('scoped worker credentials cannot acquire session or admin handoff authority', async () => {
  const s = await fixture();
  try {
    const owner = { kind: 'owner' as const, ownerId: 'test-owner' };
    const store = new PairingStore(s.coord.db, { ownerId: owner.ownerId });
    const invitation = store.createInvitation(owner, { projectId: s.project.id });
    const paired = store.redeemInvitation(invitation.code, 'remote');
    for (const method of ['session.register', 'session.claim', 'session.finish', 'session.heartbeat', 'task.adminUpdate']) {
      assert.throws(() => authorizeWorkerRpc(s.coord, paired.identity, method, s.params));
    }
    assert.throws(() => authorizeWorkerRpc(s.coord, paired.identity, 'task.update', { id: s.task.id, owner: { generation: s.claim.generation, assignee: s.sessionId }, patch: { native_handoff: '{}' } }));
    assert.equal(s.coord.getTask(s.task.id)!.assignee, s.sessionId);
  } finally { s.coord.db.close(); }
});

test('native linked source worktree is retained through successful artifact acceptance', async () => {
  const s = await fixture();
  const source = join(s.root, 'user-worktree');
  try {
    sh(s.repo, 'git', ['checkout', '-q', 'main']);
    sh(s.repo, 'git', ['worktree', 'add', '-q', source, 'native-result']);
    s.coord.registerSession('native', 'native-editor', s.project.id, source, 'm-hub');
    await s.submit(); assert.equal((await s.execute()).status, 'ready');
    assert.equal(sh(source, 'git', ['rev-parse', 'HEAD']), s.sha);
    assert.equal(sh(source, 'git', ['branch', '--show-current']), 'native-result');
    assert.ok(existsSync(join(source, 'result.txt')));
  } finally { s.coord.db.close(); }
});

for (const mode of ['cancel', 'deadline']) test(`bounded capture ${mode} stops owned Git and never queues an artifact`, async () => {
  const s = await fixture();
  const originalPath = process.env.PATH;
  const gitPath = sh(s.repo, 'which', ['git']);
  const bin = join(s.root, 'bin'); mkdirSync(bin);
  const marker = join(s.root, 'capture-started');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "check-ref-format" ]; then touch '${marker}'; sleep 20; fi\nexec '${gitPath}' "$@"\n`, { mode: 0o700 });
  try {
    process.env.PATH = `${bin}:${originalPath}`;
    const started = Date.now();
    const operation = s.submit();
    // Attach rejection handling immediately while observing the in-flight capture.
    const rejected = assert.rejects(operation, /cancel|abort|deadline|Owned utility|no longer owned/i);
    await until(() => existsSync(marker), Boolean, 3000, 'capture Git started');
    if (mode === 'cancel') s.coord.control(s.task.id, 'cancel', 'test');
    await rejected;
    assert.ok(Date.now() - started < 14000, 'capture plus owned cleanup fits the default RPC deadline');
    assert.equal(s.coord.getTask(s.task.id)!.ready_at, null);
    assert.notEqual(s.coord.getTask(s.task.id)!.status, 'queued');
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { process.env.PATH = originalPath; s.coord.db.close(); }
});

test('a restarted native MCP connection cannot borrow an existing session generation', async () => {
  const { Client: McpClient } = await import('@modelcontextprotocol/client');
  const { buildMcpServer } = await import('../src/mcp.ts');
  const s = await fixture();
  const connect = async (claims = new Map<string, number>()) => {
    const server = buildMcpServer({ client: s.client, cwd: s.repo, identity: s.sessionId, agentName: 'native-editor', claims });
    const mcp = new McpClient({ name: 'native-restart-test', version: '1' });
    const a: any = { start: async () => {}, close: async () => {}, send: async (message: unknown) => queueMicrotask(() => b.onmessage?.(structuredClone(message))) };
    const b: any = { start: async () => {}, close: async () => {}, send: async (message: unknown) => queueMicrotask(() => a.onmessage?.(structuredClone(message))) };
    await server.connect(a); await mcp.connect(b);
    return { server, mcp, claims };
  };
  const restarted = await connect();
  const captured = await connect(new Map([[s.task.id, s.claim.generation]]));
  try {
    const refused = await restarted.mcp.callTool({ name: 'yard_finish_task', arguments: { id: s.task.id, summary: 'restart', branch: 'native-result' } });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /no captured claim/);
    assert.equal(s.coord.getTask(s.task.id)!.generation, s.claim.generation);
    const queued = await captured.mcp.callTool({ name: 'yard_finish_task', arguments: { id: s.task.id, summary: 'native result', branch: 'native-result' } });
    assert.ok(!queued.isError, JSON.stringify(queued)); assert.match(JSON.stringify(queued.content), /queued/);
    assert.equal(captured.claims.size, 0);
    const repeated = await captured.mcp.callTool({ name: 'yard_finish_task', arguments: { id: s.task.id, summary: 'again' } });
    assert.equal(repeated.isError, true);
  } finally { await restarted.mcp.close(); await restarted.server.close(); await captured.mcp.close(); await captured.server.close(); s.coord.db.close(); }
});


for (const location of ['reserved branch', 'owned worktree root']) test(`native source preservation refuses ${location} cleanup ownership`, async () => {
  const s = await fixture();
  try {
    let branch = 'native-result';
    let source = s.repo;
    if (location === 'reserved branch') { branch = `yardmaster/${s.task.id}`; sh(source, 'git', ['branch', '-m', branch]); }
    else {
      source = join(s.root, 'worktrees', `${s.project.name}-${s.project.id.slice(2, 8)}`, s.task.id);
      sh(s.repo, 'git', ['checkout', '-q', 'main']);
      sh(s.repo, 'git', ['worktree', 'add', '-q', source, branch]);
      s.coord.registerSession('native', 'native-editor', s.project.id, source, 'm-hub');
    }
    await assert.rejects(s.client['session.finish']({ ...s.params, branch }), /reserved yardmaster|Yardmaster-owned worktree roots/);
    assert.equal(sh(source, 'git', ['rev-parse', 'HEAD']), s.sha);
    assert.ok(existsSync(join(source, 'result.txt')));
    assert.equal(s.coord.getTask(s.task.id)!.ready_at, null);
    assert.deepEqual(listHeld(s.coord.db), []);
  } finally { s.coord.db.close(); }
});
