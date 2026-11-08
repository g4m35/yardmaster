import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { recover } from '../src/janitor.ts';
import { planGoalManaged } from '../src/planner.ts';
import { loadConfig } from '../src/config.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import type { AgentEvent } from '../src/adapters/types.ts';
import { listHeld } from '../src/budgets.ts';
import { isAlive, processStartTime, terminateOwnedGroup } from '../src/proc.ts';
import { sandbox, until } from './helpers.ts';

async function fixture() {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 } });
  const coord = new Coordinator(openDb(join(box.home, 'plan.sqlite')));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm1', integrationHead: async () => 'a'.repeat(40) }));
  const owner = { pid: process.pid, startedAt: (await processStartTime(process.pid))! };
  return { ...box, coord, project, client, owner };
}
function expire(s: Awaited<ReturnType<typeof fixture>>, runId: string) {
  s.coord.setMeta(`plan_invocation:${runId}`, JSON.stringify({ ...s.coord.getPlanInvocation(runId), leaseUntil: Date.now() - 1 }));
}
async function admit(s: Awaited<ReturnType<typeof fixture>>, machineId = 'm1') {
  return s.client['plan.start']({ projectId: s.project.id, machineId, agent: 'mock', model: null, owner: s.owner });
}
async function stopChild(child: ChildProcess | undefined) {
  if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
}

for (const signal of ['SIGKILL', 'SIGTERM'] as const) test(`real managed CLI ${signal}: its TERM-resistant planner is reaped and reservation released exactly once`, async () => {
  const s = await fixture();
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      const value = await (s.client[method as keyof Client] as (p: unknown) => Promise<unknown>)(params);
      res.end(JSON.stringify({ value }));
    } catch (error) { res.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const planner = join(s.root, 'planner.mjs');
  writeFileSync(planner, `process.on('SIGTERM',()=>{});for await(const x of process.stdin){};console.log(JSON.stringify({type:'usage',costUsd:.2,tokensIn:20,tokensOut:2,cumulative:false}));setInterval(()=>{},1000);`);
  const source = (name: string) => pathToFileURL(join(import.meta.dirname, '../src', name)).href;
  const cli = join(s.root, 'cli.mjs');
  writeFileSync(cli, `import {registerAdapter} from ${JSON.stringify(source('adapters/index.ts'))};
import {planGoalManaged} from ${JSON.stringify(source('planner.ts'))};import {loadConfig} from ${JSON.stringify(source('config.ts'))};
registerAdapter({name:'plan-crash-fixture',label:'fixture',binary:process.execPath,build:ctx=>({command:process.execPath,args:[${JSON.stringify(planner)}],stdin:ctx.prompt}),parse:line=>[JSON.parse(line)]});
const client=new Proxy({}, {get:(_,method)=>async params=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',body:JSON.stringify({method,params})});const b=await r.json();if(b.error)throw new Error(b.error);return b.value;}});
await planGoalManaged('goal',{cwd:${JSON.stringify(s.repo)},agent:'plan-crash-fixture',config:loadConfig(${JSON.stringify(s.repo)}),client,projectId:${JSON.stringify(s.project.id)},machineId:'m1'});`);
  let child: ChildProcess | undefined;
  let plannerPid: number | null = null;
  try {
    child = spawn(process.execPath, [cli], { stdio: 'ignore', env: { ...process.env } });
    const run = await until(() => s.coord.db.prepare("SELECT id, pid, cost_usd FROM runs WHERE role='plan'").get() as { id: string; pid: number | null; cost_usd: number } | undefined,
      r => !!r?.pid && r.cost_usd === .2, 15_000);
    plannerPid = run!.pid;
    assert.equal(listHeld(s.coord.db).length, 1);
    child.kill(signal); await once(child, 'exit');
    await recover(s.coord, 'm1', new Set(), { startup: true });
    assert.equal(isAlive(plannerPid), false);
    assert.equal(s.coord.getRun(run!.id)!.status, signal === 'SIGKILL' ? 'stopped' : 'failed');
    assert.equal(s.coord.spentToday(), .2);
    assert.equal(listHeld(s.coord.db).length, 0);
    await recover(s.coord, 'm1', new Set());
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.equal(s.coord.spentToday(), .2);
  } finally {
    await stopChild(child);
    if (plannerPid) await terminateOwnedGroup(plannerPid, { graceMs: 50 });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    s.coord.db.close();
  }
});

test('active plan owner and renewed heartbeat survive recovery; invocation lease expiry reaps even a live owner', async () => {
  const s = await fixture(); let child: ChildProcess | undefined;
  try {
    const { runId } = await admit(s);
    await s.client['plan.spawning']({ runId });
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!; const startedAt = (await processStartTime(pid))!;
    await s.client['plan.spawn']({ runId, pid, startedAt });
    await s.client['plan.heartbeat']({ runId, owner: s.owner });
    await recover(s.coord, 'm1', new Set(), { startup: true });
    assert.equal(isAlive(pid), true); assert.equal(s.coord.getRun(runId)!.status, 'running');
    expire(s, runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(isAlive(pid), false); assert.equal(listHeld(s.coord.db).length, 0);
  } finally { if (child?.pid) await terminateOwnedGroup(child.pid, { graceMs: 50 }); s.coord.db.close(); }
});

test('reused PID retains planning hold and does not signal unrelated group; narrow owner attestation clears it', async () => {
  const s = await fixture(); let child: ChildProcess | undefined;
  try {
    const { runId } = await admit(s); await s.client['plan.spawning']({ runId });
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!; const startedAt = (await processStartTime(pid))!;
    await s.client['plan.spawn']({ runId, pid, startedAt: startedAt - 60_000 }); expire(s, runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(isAlive(pid), true); assert.equal(s.coord.getRun(runId)!.status, 'cleanup_failed'); assert.equal(listHeld(s.coord.db).length, 1);
    await assert.rejects(s.client['plan.finish']({ runId, reaped: true, succeeded: false, process: { pid, startedAt } }), /identity does not match/);
    await terminateOwnedGroup(pid, { graceMs: 50 });
    await s.client['plan.confirmStopped']({ runId, note: 'Fixture group was independently inspected and killed before attesting.' });
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.ok(s.coord.eventsSince(0, s.project.id).some(e => e.kind === 'process.owner_confirmed_stopped'));
  } finally { if (child?.pid) await terminateOwnedGroup(child.pid, { graceMs: 50 }); s.coord.db.close(); }
});

test('plan.finish requires process/no-launch/spawn-failure proof and remote recovery never signals local PID', async () => {
  const s = await fixture();
  try {
    let admitted = await admit(s); const runId = admitted.runId;
    await assert.rejects(s.client['plan.finish']({ runId, reaped: true, succeeded: false }), /requires matching/);
    await s.client['plan.finish']({ runId, reaped: true, succeeded: false, noLaunchPhase: 'plan' });
    await s.client['plan.finish']({ runId, reaped: true, succeeded: false, noLaunchPhase: 'plan' });
    assert.equal(listHeld(s.coord.db).length, 0);
    admitted = await admit(s); await s.client['plan.spawning']({ runId: admitted.runId });
    await assert.rejects(s.client['plan.finish']({ runId: admitted.runId, reaped: true, succeeded: false, noLaunchPhase: 'plan:spawning' }), /phase does not match/);
    await s.client['plan.finish']({ runId: admitted.runId, reaped: true, succeeded: false, spawnFailure: { status: 'spawn_failed', pid: null } });
    admitted = await admit(s); await s.client['plan.spawning']({ runId: admitted.runId }); expire(s, admitted.runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(s.coord.getRun(admitted.runId)!.status, 'cleanup_failed'); assert.equal(listHeld(s.coord.db).length, 1);
    await s.client['plan.confirmStopped']({ runId: admitted.runId, note: 'No planner group exists after inspecting the spawning window.' });
    admitted = await admit(s, 'remote');
    await s.client['plan.spawning']({ runId: admitted.runId });
    await s.client['plan.spawn']({ runId: admitted.runId, pid: s.owner.pid, startedAt: s.owner.startedAt }); expire(s, admitted.runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(s.coord.getRun(admitted.runId)!.status, 'cleanup_failed'); assert.equal(listHeld(s.coord.db).length, 1);
    assert.equal(isAlive(process.pid), true);
  } finally { s.coord.db.close(); }
});

for (const outcome of ['rejected', 'hung'] as const) test(`managed planning aborts and accounts when heartbeat RPCs stay ${outcome} beyond its lease`, async () => {
  const s = await fixture();
  const script = join(s.root, 'lease-planner.mjs');
  writeFileSync(script, `for await(const x of process.stdin){};console.log(JSON.stringify({type:'usage',costUsd:.2,tokensIn:20,tokensOut:2,cumulative:false}));setInterval(()=>{},1000);`);
  const agent = `planning-heartbeat-${outcome}`;
  registerAdapter({ name: agent, label: agent, binary: process.execPath, build: ctx => ({ command: process.execPath, args: [script], stdin: ctx.prompt }), parse: line => [JSON.parse(line) as AgentEvent] });
  let heartbeats = 0;
  const client = new Proxy(s.client, { get(target, key: keyof Client) {
    if (key === 'plan.start') return async (p: Parameters<Client['plan.start']>[0]) => {
      const admitted = await target['plan.start'](p);
      s.coord.setMeta(`plan_invocation:${admitted.runId}`, JSON.stringify({ ...s.coord.getPlanInvocation(admitted.runId), leaseMs: 1200, leaseUntil: Date.now() + 1200 }));
      return { ...admitted, leaseMs: 1200, heartbeatMs: 100 };
    };
    if (key === 'plan.heartbeat') return async () => { heartbeats++; if (outcome === 'hung') await new Promise(() => {}); throw new Error('fixture heartbeat unavailable'); };
    return target[key];
  } });
  try {
    await assert.rejects(planGoalManaged('goal', { cwd: s.repo, agent, config: loadConfig(s.repo), client, projectId: s.project.id, machineId: 'm1' }));
    const run = s.coord.db.prepare("SELECT id FROM runs WHERE role='plan'").get() as { id: string };
    assert.ok(heartbeats > 0);
    assert.equal(s.coord.getRun(run.id)!.status, 'failed');
    assert.equal(s.coord.getRun(run.id)!.pid, null);
    assert.equal(s.coord.getRun(run.id)!.cost_usd, .2);
    assert.equal(listHeld(s.coord.db).length, 0);
  } finally { s.coord.db.close(); }
});

test('expired no-launch plan recovers automatically, and an exact recorded process proof can finalize a remote recovery hold', async () => {
  const s = await fixture(); let child: ChildProcess | undefined;
  try {
    let admitted = await admit(s); expire(s, admitted.runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(s.coord.getRun(admitted.runId)!.status, 'stopped');
    assert.equal(listHeld(s.coord.db).length, 0);
    admitted = await admit(s, 'remote'); await s.client['plan.spawning']({ runId: admitted.runId });
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const processProof = { pid: child.pid!, startedAt: (await processStartTime(child.pid!))! };
    await s.client['plan.spawn']({ runId: admitted.runId, ...processProof }); expire(s, admitted.runId);
    await recover(s.coord, 'm1', new Set());
    assert.equal(isAlive(processProof.pid), true);
    await assert.rejects(s.client['plan.finish']({ runId: admitted.runId, reaped: true, succeeded: false }), /requires matching/);
    await terminateOwnedGroup(processProof.pid, { graceMs: 50 });
    await s.client['plan.finish']({ runId: admitted.runId, reaped: true, succeeded: false, process: processProof });
    assert.equal(listHeld(s.coord.db).length, 0);
    assert.equal(s.coord.getRun(admitted.runId)!.status, 'failed');
  } finally { if (child?.pid) await terminateOwnedGroup(child.pid, { graceMs: 50 }); s.coord.db.close(); }
});
