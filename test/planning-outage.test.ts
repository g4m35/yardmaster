import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { listHeld, readAllowance } from '../src/budgets.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { recover } from '../src/janitor.ts';
import { normalizePlanningHub, PlanningJournal, recoverPlanningReceipts } from '../src/planning-journal.ts';
import { planGoalManaged } from '../src/planner.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { loadConfig } from '../src/config.ts';
import { processStartTime } from '../src/proc.ts';
import { sandbox } from './helpers.ts';

const usage = { costUsd: .3, tokensIn: 30, tokensOut: 3, provenance: 'actual' as const, cacheReadTokens: null, cacheWriteTokens: null };
function clientFor(coord: Coordinator): Client { return localClient(buildMethods(coord, { machineId: 'm1', integrationHead: async () => 'a'.repeat(40) })); }
function receipts(home: string) { return readdirSync(join(home, 'planning-receipts')).filter(name => name.endsWith('.json')); }

for (const failure of ['result', 'stderr']) test(`failed planner ${failure} stays out of outage receipts while usage and exit remain replayable`, async () => {
  const box = sandbox();
  const coord = new Coordinator(openDb(join(box.home, 'privacy.sqlite')));
  const sentinel = 'PRIVATE-PLANNER-OUTPUT-SENTINEL';
  const agent = `privacy-${failure}-fixture`;
  const script = `console.log(JSON.stringify({type:'usage',costUsd:.3,tokensIn:30,tokensOut:3,cumulative:false})); ${failure === 'result'
    ? `console.log(JSON.stringify({type:'result',ok:false,text:${JSON.stringify(sentinel)}}));`
    : `console.error(${JSON.stringify(sentinel)}); process.exitCode=1;`}`;
  registerAdapter({ name: agent, label: 'Privacy fixture', binary: process.execPath,
    build: () => ({ command: process.execPath, args: ['-e', script] }), parse: line => [JSON.parse(line)] });
  const client = clientFor(coord);
  let restored = false;
  const outage = new Proxy(client, { get(target, key: keyof Client) {
    if (key === 'plan.usage') return async (params: Parameters<Client['plan.usage']>[0]) => {
      if (params.final && !restored) throw new Error('fixture final accounting outage');
      return target[key](params);
    };
    return target[key];
  } });
  try {
    const project = await coord.registerProject(box.repo);
    await assert.rejects(planGoalManaged('PRIVATE-GOAL-SENTINEL', { cwd: box.repo, agent, config: loadConfig(box.repo),
      client: outage, projectId: project.id, machineId: 'm1', hub: 'https://privacy.example' }), /fixture final accounting outage/);
    const file = join(box.home, 'planning-receipts', receipts(box.home)[0]!);
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(sentinel), 'durable accounting must not retain agent output');
    assert.ok(!text.includes('PRIVATE-GOAL-SENTINEL'), 'durable accounting must not retain the goal');
    const receipt = JSON.parse(text);
    assert.equal(receipt.snapshot.usage.costUsd, .3);
    assert.equal(receipt.snapshot.final, true);
    assert.equal(receipt.outcome.reaped, true);
    assert.equal(receipt.outcome.succeeded, false);
    assert.equal(listHeld(coord.db).length, 1);
    restored = true;
    const journal = PlanningJournal.read(join(box.home, 'planning-receipts'), file);
    assert.equal(await journal.replay(outage), true);
    assert.equal(coord.spentToday(), .3);
    assert.equal(coord.getRun(receipt.runId)!.status, 'failed');
    assert.equal(listHeld(coord.db).length, 0);
    assert.equal(receipts(box.home).length, 0);
    // With working RPC, the original detailed exception still reaches the invoking caller.
    await assert.rejects(planGoalManaged('goal', { cwd: box.repo, agent, config: loadConfig(box.repo),
      client: outage, projectId: project.id, machineId: 'm1', hub: 'https://privacy.example' }), new RegExp(sentinel));
    assert.equal(receipts(box.home).length, 0);
    assert.equal(listHeld(coord.db).length, 0);
  } finally { coord.db.close(); }
});

for (const hub of [undefined, '']) test(`local CLI recovery replays its receipt with ${hub === undefined ? 'unset' : 'empty'} hub configuration`, async () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'machine-id'), 'm1\n');
  const dbPath = join(box.home, 'yardmaster.db');
  const coord = new Coordinator(openDb(dbPath));
  try {
    const project = await coord.registerProject(box.repo);
    const owner = { pid: process.pid, startedAt: (await processStartTime(process.pid))! - 60_000 };
    const admitted = await clientFor(coord)['plan.start']({ projectId: project.id, machineId: 'm1', agent: 'mock', model: null, owner });
    new PlanningJournal({ hub: `local:${dbPath}`, machineId: 'm1', projectId: project.id, runId: admitted.runId, owner });
    const env = { ...process.env, YARDMASTER_HUB: hub, YARDMASTER_TOKEN: '' };
    if (hub === undefined) delete env.YARDMASTER_HUB;
    const child = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'recover', '--json'],
      { cwd: box.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { errors += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { replayed: [admitted.runId], pending: [], skippedLive: [] });
    assert.equal(listHeld(coord.db).length, 0);
    assert.equal(receipts(box.home).length, 0);
  } finally { coord.db.close(); }
});

for (const outage of ['final-unavailable', 'usage-ack-lost', 'finish-ack-lost'] as const) test(`planning receipt survives ${outage} and restart accounts before release exactly once`, async () => {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 } });
  const dbPath = join(box.home, 'outage.sqlite');
  let coord = new Coordinator(openDb(dbPath));
  const project = await coord.registerProject(box.repo);
  let client = clientFor(coord);
  let finalCalls = 0;
  let finishCalls = 0;
  let spawnCalls = 0;
  let networkRestored = false;
  writeFileSync(join(box.home, 'machine-id'), 'm1\n');
  let child: ChildProcess | undefined;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const standard = req.url?.startsWith('/api/rpc/');
      const parsed = JSON.parse(body);
      const method = standard ? req.url!.slice('/api/rpc/'.length) : parsed.method;
      const params = standard ? parsed : parsed.params;
      if (method === 'plan.spawn') spawnCalls++;
      if (method === 'plan.usage') {
        const file = join(box.home, 'planning-receipts', receipts(box.home)[0]!);
        const durable = JSON.parse(readFileSync(file, 'utf8'));
        assert.ok(durable.snapshot.sequence >= params.sequence, 'snapshot must be durable before RPC');
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(join(box.home, 'planning-receipts')).mode & 0o777, 0o700);
        assert.equal(durable.hub, endpoint);
        assert.equal(durable.projectId, project.id);
        assert.equal(durable.machineId, 'm1');
        if (params.final) { finalCalls++; assert.ok(durable.outcome?.reaped); }
        if (!networkRestored && outage === 'final-unavailable') throw new Error('accounting unavailable');
      }
      if (method === 'plan.finish') {
        finishCalls++;
        assert.equal(coord.spentToday(), .3, 'final spend must land before release');
        assert.equal(listHeld(coord.db).length, 1);
      }
      const value = await (client[method as keyof Client] as (p: unknown) => Promise<unknown>)(params);
      if (!networkRestored && method === 'plan.usage' && params.final && outage === 'usage-ack-lost') throw new Error('usage acknowledgment lost');
      if (!networkRestored && method === 'plan.finish' && outage === 'finish-ack-lost') throw new Error('finish acknowledgment lost');
      res.end(JSON.stringify(standard ? { ok: true, result: value } : { value }));
    } catch (error) { res.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const slowPs = join(box.root, 'slow-identity-bin'); mkdirSync(slowPs);
  writeFileSync(join(slowPs, 'ps'), '#!/bin/sh\n/bin/sleep 0.2\nexec /bin/ps "$@"\n');
  chmodSync(join(slowPs, 'ps'), 0o755);
  const planner = join(box.root, 'agent.mjs');
  writeFileSync(planner, `for await(const c of process.stdin){}; console.log(JSON.stringify({type:'usage',costUsd:.3,tokensIn:30,tokensOut:3,cumulative:false})); console.log(JSON.stringify({type:'result',ok:true,text:JSON.stringify({tasks:[{title:'One task',prompt:'Implement one bounded task'}]})}));`);
  const source = (name: string) => pathToFileURL(join(import.meta.dirname, '../src', name)).href;
  const cli = join(box.root, 'cli.mjs');
  writeFileSync(cli, `import {registerAdapter} from ${JSON.stringify(source('adapters/index.ts'))};
import {planGoalManaged} from ${JSON.stringify(source('planner.ts'))}; import {loadConfig} from ${JSON.stringify(source('config.ts'))};
registerAdapter({name:'outage-fixture',label:'fixture',binary:process.execPath,build:ctx=>({command:process.execPath,args:[${JSON.stringify(planner)}],stdin:ctx.prompt}),parse:line=>[JSON.parse(line)]});
const client=new Proxy({}, {get:(_,method)=>async params=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',body:JSON.stringify({method,params})});const b=await r.json();if(b.error)throw new Error(b.error);return b.value;}});
try {await planGoalManaged('goal',{cwd:${JSON.stringify(box.repo)},agent:'outage-fixture',config:loadConfig(${JSON.stringify(box.repo)}),client,hub:${JSON.stringify(endpoint)},projectId:${JSON.stringify(project.id)},machineId:'m1'});process.exitCode=2;}catch(e){if(!/unavailable|acknowledgment lost/.test(String(e)))throw e;}`);
  try {
    child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: slowPs + delimiter + process.env.PATH } });
    let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
    assert.equal(spawnCalls, 1, 'even a fast planner must register before receiving its prompt');
    assert.equal(finalCalls, 1);
    assert.equal(finishCalls, outage === 'finish-ack-lost' ? 1 : 0);
    assert.equal(receipts(box.home).length, 1, 'unacknowledged completion must remain durable');
    const runId = String(coord.db.prepare("SELECT id FROM runs WHERE role='plan'").get()!.id);
    assert.equal(listHeld(coord.db).length, outage === 'finish-ack-lost' ? 0 : 1);
    // A hub/process recovery pass cannot release a final-accounting hold during the outage.
    if (outage === 'final-unavailable') await recover(coord, 'm1', new Set());
    assert.equal(listHeld(coord.db).length, outage === 'finish-ack-lost' ? 0 : 1);
    assert.equal(coord.spentToday(), outage === 'final-unavailable' ? 0 : .3);
    coord.db.close(); coord = new Coordinator(openDb(dbPath)); client = clientFor(coord);
    const replayOrder: string[] = [];
    const restored = new Proxy(client, { get(target, key: keyof Client) {
      if (key === 'plan.usage') return async (params: Parameters<Client['plan.usage']>[0]) => {
        replayOrder.push('usage');
        if (outage === 'final-unavailable') assert.equal(listHeld(coord.db).length, 1);
        return target[key](params);
      };
      if (key === 'plan.finish') return async (params: Parameters<Client['plan.finish']>[0]) => {
        replayOrder.push('finish'); assert.equal(coord.spentToday(), .3); return target[key](params);
      };
      return target[key];
    } });
    networkRestored = true;
    let result;
    if (outage === 'final-unavailable') {
      client = restored;
      const recoverCli = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'recover', '--hub', endpoint, '--token', 'fixture-only', '--json'],
        { cwd: box.repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      recoverCli.stdout!.on('data', data => { output += data; }); recoverCli.stderr!.on('data', data => { errors += data; });
      const [code] = await once(recoverCli, 'exit'); assert.equal(code, 0, errors);
      result = JSON.parse(output);
    } else result = await recoverPlanningReceipts(restored, { hub: endpoint + '/', machineId: 'm1' });
    assert.deepEqual(result, { replayed: [runId], pending: [], skippedLive: [] });
    assert.deepEqual(replayOrder, ['usage', 'finish']);
    assert.equal(coord.getRun(runId)!.status, 'succeeded');
    assert.equal(coord.spentToday(), .3);
    assert.equal(coord.getRun(runId)!.tokens_in, 30);
    assert.equal(listHeld(coord.db).length, 0);
    assert.equal(readAllowance(coord.db, { taskId: null, taskCapUsd: null, dailyCapUsd: 5 }).dailyRemainingUsd, 4.7);
    assert.equal(receipts(box.home).length, 0);
    assert.deepEqual(await recoverPlanningReceipts(restored, { hub: endpoint, machineId: 'm1' }), { replayed: [], pending: [], skippedLive: [] });
    assert.equal(coord.spentToday(), .3);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    coord.db.close();
  }
});

test('receipt replay skips live owners and other hub/machine scopes; missing final usage stays held', async () => {
  const box = sandbox({ budget: { dailyUsd: 5, perTaskUsd: 3 } });
  const coord = new Coordinator(openDb(join(box.home, 'scope.sqlite')));
  const project = await coord.registerProject(box.repo);
  const client = clientFor(coord);
  const owner = { pid: process.pid, startedAt: (await processStartTime(process.pid))! };
  try {
    const admitted = await client['plan.start']({ projectId: project.id, machineId: 'm1', agent: 'mock', model: null, owner });
    const journal = new PlanningJournal({ hub: 'https://one.example', machineId: 'm1', projectId: project.id, runId: admitted.runId, owner });
    journal.snapshot(usage);
    assert.deepEqual(await recoverPlanningReceipts(client, { hub: 'https://two.example', machineId: 'm1' }), { replayed: [], pending: [], skippedLive: [] });
    assert.deepEqual(await recoverPlanningReceipts(client, { hub: 'https://one.example', machineId: 'm2' }), { replayed: [], pending: [], skippedLive: [] });
    assert.deepEqual((await recoverPlanningReceipts(client, { hub: 'https://one.example', machineId: 'm1' })).skippedLive, [admitted.runId]);
    assert.equal(coord.spentToday(), 0);
    // A reused owner PID is not the former invocation and is never signaled by receipt recovery.
    journal.value.owner.startedAt -= 60_000; journal.snapshot(usage);
    const result = await recoverPlanningReceipts(client, { hub: 'https://one.example', machineId: 'm1' });
    assert.match(result.pending[0]!.reason, /No final accounting receipt/);
    assert.equal(coord.spentToday(), .3);
    assert.equal(listHeld(coord.db).length, 1);
    assert.equal(receipts(box.home).length, 1);
    const retiredOwner = { ...owner, startedAt: owner.startedAt - 60_000 };
    const idle = await client['plan.start']({ projectId: project.id, machineId: 'm1', agent: 'mock', model: null, owner: retiredOwner });
    new PlanningJournal({ hub: `local:${box.home}/outage.sqlite`, machineId: 'm1', projectId: project.id, runId: idle.runId, owner: retiredOwner });
    assert.deepEqual((await recoverPlanningReceipts(client, { hub: `local:${box.home}/outage.sqlite`, machineId: 'm1' })).replayed, [idle.runId]);
    assert.equal(listHeld(coord.db).length, 1, 'only the launched receipt without final accounting remains held');
    assert.throws(() => new PlanningJournal({ hub: 'https://name:secret@one.example', machineId: 'm1', projectId: project.id, runId: 'bad', owner }), /credentials/);
    assert.equal(normalizePlanningHub(`local:${box.home}/intermediate/../outage.sqlite`), `local:${box.home}/outage.sqlite`);
    assert.throws(() => normalizePlanningHub('local:relative.sqlite'), /absolute database path/);
  } finally { coord.db.close(); }
});
