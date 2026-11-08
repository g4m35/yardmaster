import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { addWorktree, revParse } from '../src/git.ts';
import { planCleanup, runCleanup, recover } from '../src/janitor.ts';
import { verifyArtifact } from '../src/verification.ts';

async function candidate(projectConfig?: Record<string, unknown>) {
  const box = sandbox({ cleanup: { auto: false } });
  if (projectConfig) writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify(projectConfig));
  if (projectConfig) sh(box.repo, 'git', ['commit', '-qam', 'test configuration']);
  const db = openDb(join(box.home, 'y.db'));
  const hub = new Hub({ db, token: 'test', machineId: 'm-test', includeMock: true });
  const project = await hub.coord.registerProject(box.repo);
  await hub.integrator.head(project.id);
  const task = hub.coord.addTasks(project.id, [{ title: 'Completed cleanup candidate', agent: 'mock' }], 'test').created[0]!;
  const path = join(box.root, 'worktrees', `repo-${project.id.slice(2, 8)}`, task.id);
  const branch = `yardmaster/${task.id}`;
  await addWorktree(box.repo, path, branch, 'main');
  hub.coord.updateTask(task.id, { status: 'done', worktree: path, branch, head_sha: await revParse(path, 'HEAD') });
  return { ...box, db, hub, project, task, path, branch };
}

test('cleanup revalidates new attached/detached commits, locks and task ownership', async () => {
  for (const change of ['attached', 'detached', 'locked', 'reclaimed'] as const) {
    const s = await candidate();
    try {
      const plan = await planCleanup(s.hub.coord, s.project.id, { sizes: false });
      assert.ok(plan.remove.some((i) => i.target === s.path));
      if (change === 'locked') sh(s.repo, 'git', ['worktree', 'lock', s.path]);
      else if (change === 'reclaimed') {
        s.hub.coord.updateTask(s.task.id, { status: 'queued' });
        assert.ok(s.hub.coord.claimNext({ machineId: 'm-test', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} }));
      }
      else {
        if (change === 'detached') sh(s.path, 'git', ['checkout', '--detach']);
        writeFileSync(join(s.path, 'unique.txt'), 'irreplaceable local work');
        sh(s.path, 'git', ['add', '-A']);
        sh(s.path, 'git', ['commit', '-qm', 'new local work']);
      }
      const head = sh(s.path, 'git', ['rev-parse', 'HEAD']);
      const result = await runCleanup(s.hub.coord, plan);
      assert.ok(result.failed.some((x) => x.item.target === s.path), change);
      assert.ok(existsSync(s.path), change);
      assert.equal(sh(s.path, 'git', ['rev-parse', 'HEAD']), head);
      if (change === 'attached' || change === 'detached') assert.equal(sh(s.path, 'git', ['show', 'HEAD:unique.txt']), 'irreplaceable local work');
    } finally { s.db.close(); }
  }
});

test('unchanged merged terminal worktree and exact branch are still cleaned', async () => {
  const s = await candidate();
  try {
    const result = await runCleanup(s.hub.coord, await planCleanup(s.hub.coord, s.project.id, { sizes: false }));
    assert.deepEqual(result.failed, []);
    assert.ok(!existsSync(s.path));
    assert.equal(sh(s.repo, 'git', ['branch', '--list', s.branch]), '');
  } finally { s.db.close(); }
});

test('unconfirmed process exit preserves canceled worktrees and their artifacts', async () => {
  const s = await candidate();
  try {
    const task = s.hub.coord.getTask(s.task.id)!;
    s.hub.coord.updateTask(task.id, { status: 'running', machine_id: 'm-test', assignee: 'machine:m-test', lease_until: Date.now() + 60_000 });
    s.db.prepare('UPDATE tasks SET generation = 1 WHERE id = ?').run(task.id);
    const run = s.hub.coord.startRun(s.hub.coord.getTask(task.id)!, 'm-test', 'mock', null, '');
    s.hub.coord.updateRun(run.id, { status: 'cleanup_failed', phase: 'setup', pid: 123 });
    s.hub.coord.control(task.id, 'cancel', 'test');
    const plan = await planCleanup(s.hub.coord, s.project.id, { sizes: false });
    assert.ok(plan.keep.some(i => i.target === s.path && /not been confirmed stopped/.test(i.reason)));
    assert.ok(!plan.remove.some(i => i.target === s.path || i.worktree === s.path));
    const stalePlan = { remove: [{ kind: 'worktree' as const, target: s.path, projectId: s.project.id, taskId: task.id, generation: 1, sha: sh(s.path, 'git', ['rev-parse', 'HEAD']), branch: s.branch, reason: 'stale plan' }], keep: [] };
    assert.ok((await runCleanup(s.hub.coord, stalePlan)).failed.length);
    assert.ok(existsSync(s.path));
  } finally { s.db.close(); }
});

test('restart recovers child-free phases and holds an unregistered spawn window', async () => {
  for (const phase of ['prepare', 'collect', 'review_wait', 'agent:spawning']) {
    const s = await candidate();
    try {
      s.hub.coord.updateTask(s.task.id, { status: 'running', machine_id: 'm-test', assignee: 'machine:m-test', lease_until: Date.now() + 60_000 });
      s.db.prepare('UPDATE tasks SET generation = 1 WHERE id = ?').run(s.task.id);
      const run = s.hub.coord.startRun(s.hub.coord.getTask(s.task.id)!, 'm-test', 'mock', null, '');
      s.hub.coord.updateRun(run.id, { phase, pid: null });
      await recover(s.hub.coord, 'm-test', new Set(), { startup: true });
      assert.equal(s.hub.coord.getTask(s.task.id)!.status, phase.endsWith(':spawning') ? 'needs_human' : 'queued', phase);
      assert.equal(s.hub.coord.getRun(run.id)!.status, phase.endsWith(':spawning') ? 'cleanup_failed' : 'stopped', phase);
    } finally { s.db.close(); }
  }
});

test('integration holds an unknown spawning window before touching interrupted merge contents', async () => {
  const s = await candidate();
  try {
    const path = s.hub.integrator.integrationPath(s.project, s.hub.coord.configFor(s.project.id));
    const before = sh(path, 'git', ['rev-parse', 'HEAD']);
    writeFileSync(join(path, 'README.md'), 'unverified check output');
    s.hub.coord.setMeta(`integrating:${s.project.id}`, before);
    s.hub.coord.setMeta(`integration_process:${s.project.id}`, JSON.stringify({ phase: 'verify:spawning', pid: null, startedAt: null }));
    await s.hub.integrator.head(s.project.id);
    assert.equal(sh(path, 'git', ['diff', '--', 'README.md']).includes('unverified check output'), true);
    assert.ok(s.hub.coord.getMeta(`integration_process:${s.project.id}`));
    assert.ok(s.hub.coord.getMeta(`integrating:${s.project.id}`));
  } finally { s.db.close(); }
});

test('event retention is bounded, revalidated and preserves unfinished or held task evidence', async () => {
  const s = await candidate();
  try {
    const old = Date.now() - 40 * 86_400_000;
    const queued = s.hub.coord.addTasks(s.project.id, [{ title: 'Unfinished event evidence', agent: 'mock' }], 'test').created[0]!;
    const insert = s.db.prepare('INSERT INTO events (ts,project_id,task_id,level,kind,message) VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 1005; index++) insert.run(old, s.project.id, s.task.id, 'info', 'retention.fixture', 'old completed event');
    insert.run(old, s.project.id, queued.id, 'info', 'retention.fixture', 'unfinished evidence');
    const plan = await planCleanup(s.hub.coord, s.project.id, { sizes: false });
    const eventsOnly = { remove: plan.remove.filter(i => i.kind === 'events'), keep: [] };
    assert.equal(eventsOnly.remove.length, 1);
    await runCleanup(s.hub.coord, eventsOnly);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='retention.fixture' AND task_id=?").get(s.task.id)!.n, 5);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='retention.fixture' AND task_id=?").get(queued.id)!.n, 1);
    // A stale cleanup plan cannot discard evidence after its task becomes active again.
    s.hub.coord.updateTask(s.task.id, { status: 'queued' });
    await runCleanup(s.hub.coord, eventsOnly);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='retention.fixture' AND task_id=?").get(s.task.id)!.n, 5);
  } finally { s.db.close(); }
});

test('interrupted integration rolls back only its recorded result and keeps later manual commits', async () => {
  for (const manual of [false, true]) {
    const s = await candidate();
    try {
      const path = s.hub.integrator.integrationPath(s.project, s.hub.coord.configFor(s.project.id));
      const before = sh(path, 'git', ['rev-parse', 'HEAD']);
      sh(path, 'git', ['commit', '--allow-empty', '-qm', 'recorded merge result']);
      const accepted = sh(path, 'git', ['rev-parse', 'HEAD']);
      s.hub.coord.setMeta(`integrating:${s.project.id}`, before);
      s.hub.coord.setMeta(`integrating_result:${s.project.id}`, accepted);
      s.hub.coord.updateTask(s.task.id, { status: 'merging' });
      if (manual) {
        writeFileSync(join(path, 'manual.txt'), 'unmerged manual work');
        sh(path, 'git', ['add', '-A']); sh(path, 'git', ['commit', '-qm', 'manual work after crash']);
      }
      const head = sh(path, 'git', ['rev-parse', 'HEAD']);
      await s.hub.integrator.head(s.project.id);
      assert.equal(sh(path, 'git', ['rev-parse', 'HEAD']), manual ? head : before);
      assert.equal(s.hub.coord.getTask(s.task.id)!.status, manual ? 'merging' : 'ready');
      if (manual) assert.equal(sh(path, 'git', ['show', 'HEAD:manual.txt']), 'unmerged manual work');
    } finally { s.db.close(); }
  }
});

test('owner can adopt an inspected interrupted commit only after exact-head checks pass', async () => {
  for (const passing of [true, false]) {
    const s = await candidate({ verify: passing ? ['node check.mjs'] : ['node -e "process.exit(1)"'] });
    try {
      const path = s.hub.integrator.integrationPath(s.project, s.hub.coord.configFor(s.project.id));
      const before = sh(path, 'git', ['rev-parse', 'HEAD']);
      writeFileSync(join(path, 'manual.txt'), 'keep the inspected owner commit');
      sh(path, 'git', ['add', '-A']); sh(path, 'git', ['commit', '-qm', 'manual recovery']);
      const head = sh(path, 'git', ['rev-parse', 'HEAD']);
      s.hub.coord.setMeta(`integrating:${s.project.id}`, before);
      s.hub.coord.updateTask(s.task.id, { status: 'merging' });
      await assert.rejects(s.hub.client['integration.adopt']({ projectId: s.project.id, head: before, note: 'Inspected all preserved changes.' }), /exact current HEAD/);
      const adoption = s.hub.client['integration.adopt']({ projectId: s.project.id, head, note: 'Inspected all preserved changes.' });
      if (passing) await adoption; else await assert.rejects(adoption, /did not pass checks/);
      assert.equal(sh(path, 'git', ['rev-parse', 'HEAD']), head);
      assert.equal(sh(path, 'git', ['show', 'HEAD:manual.txt']), 'keep the inspected owner commit');
      assert.equal(s.hub.coord.getTask(s.task.id)!.status, passing ? 'ready' : 'merging');
      assert.equal(s.hub.coord.getMeta(`integrating:${s.project.id}`), passing ? null : before);
    } finally { s.db.close(); }
  }
});

test('checks cannot validate different tracked contents, staged files or HEAD', async () => {
  for (const action of ['edit', 'stage', 'commit', 'move-head'] as const) {
    const s = sandbox();
    const command = action === 'move-head' ? 'git checkout --orphan changed-head' :
      `node -e "require('fs').writeFileSync('README.md','mutated')"${action === 'stage' || action === 'commit' ? ' && git add README.md' : ''}${action === 'commit' ? ' && git commit -qm changed' : ''}`;
    const before = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
    const result = await verifyArtifact(s.repo, [command], 1);
    assert.equal(result.ok, false, action);
    assert.equal(result.sha, before);
    assert.match(result.output, /does not validate/);
  }
  const s = sandbox();
  const result = await verifyArtifact(s.repo, ['node check.mjs'], 1);
  assert.equal(result.ok, true);
  assert.equal(result.sha, sh(s.repo, 'git', ['rev-parse', 'HEAD']));
});

test('cancellation during failed or passing integration checks remains terminal and rolls back', async () => {
  for (const exit of [0, 1]) {
    // Marker location is supplied by the shell environment, outside the artifact being checked.
    const marker = join(tempDir('ym-check-'), 'checking');
    const command = `node -e "require('fs').writeFileSync('${marker}','yes');setTimeout(()=>process.exit(${exit}),300)"`;
    const s = await candidate({ verify: [command], cleanup: { auto: false } });
    try {
      writeFileSync(join(s.path, 'change.js'), 'export const change = 1');
      sh(s.path, 'git', ['add', '-A']); sh(s.path, 'git', ['commit', '-qm', 'change']);
      s.hub.coord.updateTask(s.task.id, { status: 'ready', head_sha: sh(s.path, 'git', ['rev-parse', 'HEAD']), base_sha: '0'.repeat(40) });
      const before = sh(s.repo, 'git', ['rev-parse', 'yardmaster/integration']);
      const operation = s.hub.integrator.step(s.project.id);
      await until(() => existsSync(marker), Boolean, 10_000, 'integration check began');
      s.hub.coord.control(s.task.id, 'cancel', 'test');
      await operation;
      assert.equal(s.hub.coord.getTask(s.task.id)!.status, 'canceled');
      assert.equal(sh(s.repo, 'git', ['rev-parse', 'yardmaster/integration']), before);
      assert.ok(existsSync(s.path), 'canceled work is retained');
    } finally { s.db.close(); }
  }
});
