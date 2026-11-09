import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { chooseAgent } from '../src/router.ts';
import { resolveConfig } from '../src/config.ts';
import { sandbox } from './helpers.ts';
import { buildMethods, localClient } from '../src/api.ts';

test('editing scope or checks cannot suppress the original request, while lifecycle updates retain identity', async () => {
  const box = sandbox(); const db = openDb(':memory:'); const c = new Coordinator(db);
  try {
    const p = await c.registerProject(box.repo);
    const api = localClient(buildMethods(c, { machineId: 'fixture' }));
    for (const patch of [{ scope: ['beta.ts'] }, { verify: ['node other-check.mjs'] }, { priority: 5 }]) {
      const input = { title: `Keep exact check ${Object.keys(patch)[0]}`, files: ['alpha.ts'], verify: ['node first-check.mjs'] };
      const first = c.addTasks(p.id, [input], 'test').created[0]!;
      await api['task.adminUpdate']({ id: first.id, patch: { summary: 'status note', lease_until: null, cost_usd: 0.01 } });
      assert.equal(c.addTasks(p.id, [input], 'test').duplicates[0]!.existing, first.id, 'telemetry does not change requested work');
      c.updateTask(first.id, { agent: 'mock', model: 'fixture-model', tier: 'strong' });
      assert.equal(c.addTasks(p.id, [input], 'test').duplicates[0]!.existing, first.id, 'execution routing does not edit the request');
      await api['task.adminUpdate']({ id: first.id, patch });
      assert.equal(c.addTasks(p.id, [input], 'test').created.length, 1, 'the old scope/check request is no longer represented');
    }
  } finally { db.close(); rmSync(box.root, { recursive: true, force: true }); }
});

test('automatic deduplication requires identical instructions and scope/options', async () => {
  const box = sandbox(); const db = openDb(join(box.home, 'identity.db')); const c = new Coordinator(db);
  try {
    const p = await c.registerProject(box.repo);
    const add = (tasks: Parameters<Coordinator['addTasks']>[1]) => c.addTasks(p.id, tasks, 'test');
    assert.equal(add([{ title: 'Update validation tests', files: ['src/billing/**'] }, { title: 'Update validation tests', files: ['src/auth/**'] }]).created.length, 2);
    assert.equal(add([{ title: 'Move validation before persistence' }, { title: 'Move persistence before validation' }]).created.length, 2);
    assert.equal(add([{ title: 'Export variable Foo' }, { title: 'Export variable foo' }]).created.length, 2);
    const first = add([{ title: 'Exactly repeat this request', files: ['a.ts', 'b.ts'], verify: ['check-one'] }]).created[0]!;
    const repeated = add([{ title: 'Exactly repeat this request', files: ['b.ts', 'a.ts'], verify: ['check-one'] }]);
    assert.equal(repeated.created.length, 0); assert.equal(repeated.duplicates[0]!.existing, first.id);
    assert.equal(add([{ title: 'Exactly repeat this request', files: ['a.ts', 'b.ts'], verify: ['check-two'] }]).created.length, 1);
    c.updateTask(first.id, { prompt: 'An owner changed these instructions to different work' });
    assert.equal(add([{ title: 'Exactly repeat this request', files: ['a.ts','b.ts'], verify: ['check-one'] }]).created.length, 1, 'a changed task cannot suppress its old instructions');
    const a = add([{ key: 'pre', title: 'Prepare first requirement' }, { title: 'Same followup instructions', after: ['pre'] }]);
    const b = add([{ key: 'pre', title: 'Prepare second requirement' }, { title: 'Same followup instructions', after: ['pre'] }]);
    assert.equal(a.created.length, 2); assert.equal(b.created.length, 2);
    assert.notEqual(c.depsOf(a.created[1]!.id)[0]!.id, c.depsOf(b.created[1]!.id)[0]!.id);
  } finally { db.close(); rmSync(box.root, { recursive: true, force: true }); }
});

test('session identity stays project/machine scoped and preserves matching legacy claims', async () => {
  const box = sandbox(); const db = openDb(join(box.home, 'sessions.db')); const c = new Coordinator(db);
  try {
    const one = c.registerSession('native-name', 'codex', 'p-one', '/one', 'm-one');
    assert.equal(c.registerSession('native-name', 'codex', 'p-one', '/one/sub', 'm-one'), one);
    const two = c.registerSession('native-name', 'codex', 'p-two', '/two', 'm-one');
    const remote = c.registerSession('native-name', 'codex', 'p-one', '/remote', 'm-two');
    assert.notEqual(one, two); assert.notEqual(one, remote);
    assert.equal(c.listSessions('p-two')[0]!.id, two);
    db.prepare('INSERT INTO sessions(id,name,agent,project_id,cwd,machine_id,last_seen) VALUES(?,?,?,?,?,?,?)').run('session:legacy','legacy','codex','p-one','/old','m-one',Date.now());
    assert.equal(c.registerSession('legacy','codex','p-one','/new','m-one'), 'session:legacy');
    assert.notEqual(c.registerSession('legacy','codex','p-two','/two','m-one'), 'session:legacy');
  } finally { db.close(); rmSync(box.root, { recursive: true, force: true }); }
});

test('learned routing keeps configured model histories separate', async () => {
  const box = sandbox(); const db = openDb(join(box.home, 'models.db')); const c = new Coordinator(db);
  try {
    const p = await c.registerProject(box.repo);
    const t = c.addTasks(p.id, [{ title: 'Routing history fixture' }], 'test').created[0]!;
    for (const [id,agent,model] of [['old','claude','old-model'],['current','codex','current-model']] as const) {
      db.prepare('INSERT INTO runs(id,task_id,attempt,machine_id,agent,model,status,tier,started_at,ended_at,cost_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,t.id,1,'m',agent,model,'succeeded','standard',1,2,0.1);
    }
    const stats = c.agentStats(p.id);
    const config = resolveConfig([{ routing: { standard: ['claude','codex'] }, agents: { claude: { models: { standard: 'new-model' } }, codex: { models: { standard: 'current-model' } } }, learning: { minRuns: 1, explore: 0 } }]);
    const route = chooseAgent({ config, tier:'standard', forced:null, installed:['claude','codex'], runningByAgent:{}, stats, random:()=>0.99 })!;
    assert.equal(route.agent, 'codex'); assert.equal(route.model, 'current-model');
    assert.equal(stats.claude!.byModel![JSON.stringify('old-model')]!.standard!.verified, 1);
    const unknown = chooseAgent({ config, tier:'standard', forced:null, installed:['claude','codex'], runningByAgent:{}, stats:{ claude:{ runs:20,verified:20,cost:2,ms:0,byTier:{ standard:{runs:20,verified:20,cost:2} } } }, random:()=>0.99 })!;
    assert.ok(!unknown.reason.includes('20/20'), unknown.reason);
  } finally { db.close(); rmSync(box.root, { recursive: true, force: true }); }
});
