import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { addWorktree, revParse } from '../src/git.ts';
import { planCleanup, runCleanup } from '../src/janitor.ts';
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
