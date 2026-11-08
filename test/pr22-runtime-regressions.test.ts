import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerAdapter } from '../src/adapters/index.ts';
import { resolveConfig } from '../src/config.ts';
import { runOneShot } from '../src/oneshot.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, localClient } from '../src/api.ts';
import { addLesson, listLessons } from '../src/lessons.ts';
import { sandbox, settleTasks } from './helpers.ts';

// An existing plugin may return an ordinary launch without using Yardmaster's effort helper.
test('one-shot plugin review launches enforce the configured floor before any child starts', async () => {
  const box = sandbox();
  const agent = 'review-plugin-floor-fixture';
  const marker = join(box.root, 'launched');
  registerAdapter({ name: agent, label: 'Fixture plugin', binary: process.execPath,
    build: () => ({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started'); console.log(JSON.stringify({type:'result',ok:true,text:'fixture'}))`] }),
    parse: line => [JSON.parse(line)] });
  for (const attestedEffort of [undefined, 'medium', 'high']) {
    rmSync(marker, { force: true });
    let spawned = false;
    const config = resolveConfig([{ agents: { [agent]: { minimumEffort: 'high', ...(attestedEffort ? { attestedEffort } : {}) } } }]);
    const result = await runOneShot({ agent, prompt: 'Read-only fixture review', cwd: box.repo, config,
      readOnly: true, tier: 'standard', timeoutMs: 2000, hooks: { onSpawn: () => { spawned = true; } } });
    assert.equal(spawned, attestedEffort === 'high');
    assert.equal(existsSync(marker), attestedEffort === 'high');
    assert.equal(result.ok, attestedEffort === 'high');
    if (attestedEffort !== 'high') { assert.equal(result.status, 'spawn_failed'); assert.match(result.error, /minimumEffort/); }
    assert.equal(result.reaped, true);
  }
});

test('late brief attachment counts each lesson once and rejects stale or foreign-project writes', async () => {
  const box = sandbox(); const coord = new Coordinator(openDb(join(box.home, 'lessons.db')));
  try {
    const project = await coord.registerProject(box.repo);
    coord.db.prepare('INSERT INTO projects (id,name,root,base_branch,created_at) VALUES (?,?,?,?,?)')
      .run('p-private', 'private fixture', '/fixture/private', 'main', Date.now());
    const own = addLesson(coord, project.id, 'Use integer cents for the learned module.', 'you', ['learned.txt'], null)!;
    const foreign = addLesson(coord, 'p-private', 'Private unrelated lesson stays scoped.', 'you', [], null)!;
    const task = coord.addTasks(project.id, [{ title: 'Update learned module', agent: 'mock', files: ['learned.txt'] }], 'fixture').created[0]!;
    const claim = coord.claimNext({ machineId: 'm1', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
    const owner = { generation: claim.generation, assignee: claim.assignee! };
    const client = localClient(buildMethods(coord, { machineId: 'm1' }));
    await assert.rejects(client['run.start']({ taskId: task.id, machineId: 'm1', agent: 'mock', logPath: '', owner, lessons: [foreign.id] }), /does not belong/);
    assert.equal(coord.runsFor(task.id).length, 0);
    const runId = await client['run.start']({ taskId: task.id, machineId: 'm1', agent: 'mock', logPath: '', owner });
    await client['run.update']({ runId, owner, patch: { lessons: [own.id, own.id] } });
    await client['run.update']({ runId, owner, patch: { lessons: [own.id] } });
    assert.deepEqual(coord.getRun(runId)!.lessons, [own.id]);
    assert.equal(listLessons(coord, project.id)[0]!.uses, 1);
    await assert.rejects(client['run.update']({ runId, owner: { ...owner, generation: owner.generation + 1 }, patch: { lessons: [own.id] } }));
    await assert.rejects(client['run.update']({ runId, owner, patch: { lessons: [foreign.id] } }), /does not belong/);
    assert.equal(listLessons(coord, 'p-private')[0]!.uses, 0);
    assert.equal(listLessons(coord, project.id)[0]!.uses, 1);
    await client['run.exit']({ runId, taskId: task.id, owner, reaped: true, noLaunchPhase: 'prepare' });
  } finally { coord.db.close(); }
});

test('real managed attempt attributes its brief and credits a helpful lesson', async () => {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, cleanup: { auto: false },
    worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null } });
  const hub = new Hub({ db: openDb(join(box.home, 'learning.db')), token: 'fixture', machineId: 'm-learning',
    host: '127.0.0.1', port: 0, tickMs: 150, includeMock: true, quiet: true });
  try {
    await hub.start(); const project = await hub.coord.registerProject(box.repo);
    const lesson = addLesson(hub.coord, project.id, 'Use integer cents in the learned module.', 'you', ['learned.txt'], null)!;
    const task = hub.coord.addTasks(project.id, [{ title: 'Build learned module', prompt: '@mock write learned.txt integer cents', files: ['learned.txt'], agent: 'mock' }], 'fixture').created[0]!;
    const [finished] = await settleTasks(hub.coord, [task.id], box.root, 15000);
    assert.equal(finished!.status, 'done', finished!.attention ?? '');
    assert.deepEqual(hub.coord.latestRun(task.id)!.lessons, [lesson.id]);
    const credited = listLessons(hub.coord, project.id).find(row => row.id === lesson.id)!;
    assert.equal(credited.uses, 1); assert.equal(credited.wins, 1);
  } finally { await hub.stop(); hub.coord.db.close(); }
});
