import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { addWorktree } from '../src/git.ts';
import { planCleanup, runCleanup } from '../src/janitor.ts';
import { recordUtility, runUtilityKey, taskHasPendingUtilities } from '../src/utility-records.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture() {
  const box = sandbox({ cleanup: { auto: false } });
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  sh(box.repo, 'git', ['add', '.gitignore']);
  sh(box.repo, 'git', ['commit', '-qm', 'ignore rebuildable artifacts']);
  const coord = new Coordinator(openDb(join(box.home, 'artifacts.db')));
  const project = await coord.registerProject(box.repo);
  coord.addTasks(project.id, [{ title: 'Inspect idle artifacts', agent: 'mock' }], 'test');
  const task = coord.claimNext({ machineId: 'm-test', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  const run = coord.startRun(task, 'm-test', 'mock', null, '');
  coord.confirmRunExit(run.id, task.id, { generation: task.generation, assignee: task.assignee! });
  const worktree = join(box.root, 'worktrees', `repo-${project.id.slice(2, 8)}`, task.id);
  await addWorktree(box.repo, worktree, task.branch!, 'main');
  const artifact = join(worktree, 'node_modules');
  mkdirSync(artifact);
  const contents = Buffer.alloc(1_100_000, 'x');
  writeFileSync(join(artifact, 'rebuildable.bin'), contents);
  coord.updateTask(task.id, { status: 'needs_human', worktree });
  const plan = await planCleanup(coord, project.id, { sizes: false });
  const item = plan.remove.find(item => item.kind === 'artifacts' && item.target === artifact);
  assert.ok(item, 'the real planner finds the ignored artifact in an idle kept worktree');
  return { ...box, coord, project, task, run, worktree, artifact, contents, plan: { remove: [item], keep: [] } };
}

/** Hold the real scan at its final asynchronous operation, without replacing findArtifacts or its Git checks. */
function scanGate(root: string, artifact: string) {
  const oldPath = process.env.PATH;
  const realDu = (oldPath ?? '').split(delimiter).map(dir => join(dir, 'du')).find(path => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(realDu, 'a real du executable is required for this scan race');
  const bin = join(root, 'scan-bin');
  const entered = join(root, 'scan-entered');
  const released = join(root, 'scan-released');
  const completed = join(root, 'scan-completed');
  mkdirSync(bin);
  writeFileSync(join(bin, 'du'), `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.at(-1) === ${JSON.stringify(artifact)}) {
  writeFileSync(${JSON.stringify(entered)}, 'entered');
  const deadline = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(released)})) {
    if (Date.now() > deadline) process.exit(99);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const result = spawnSync(${JSON.stringify(realDu)}, args, { stdio: 'inherit' });
writeFileSync(${JSON.stringify(completed)}, String(result.status));
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  process.env.PATH = bin + delimiter + oldPath;
  return {
    entered,
    completed,
    release: () => writeFileSync(released, 'released'),
    restore: () => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; },
  };
}

for (const change of ['reclaim', 'utility', 'unchanged'] as const) {
  test(`artifact cleanup rechecks ownership after its real scan: ${change}`, { skip: process.platform === 'win32' }, async () => {
    const s = await fixture();
    const gate = scanGate(s.root, s.artifact);
    let cleanup: ReturnType<typeof runCleanup> | undefined;
    try {
      cleanup = runCleanup(s.coord, s.plan);
      await until(() => existsSync(gate.entered), Boolean, 10_000, 'artifact scan to enter real du');
      assert.ok(existsSync(s.artifact), 'no rename occurs while the scan is pending');
      if (change === 'reclaim') {
        s.coord.control(s.task.id, 'retry', 'test');
        const fresh = s.coord.claimNext({ machineId: 'm-test', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!.task;
        assert.ok(fresh.generation > s.task.generation);
        const run = s.coord.startRun(fresh, 'm-test', 'mock', null, '');
        assert.equal(s.coord.getTask(fresh.id)!.status, 'running');
        assert.equal(s.coord.getRun(run.id)!.status, 'running');
      } else if (change === 'utility') {
        recordUtility(s.coord.db, runUtilityKey(s.run.id), { action: 'intent', token: 'late-scan-utility', command: 'git' });
        assert.equal(taskHasPendingUtilities(s.coord.db, s.task.id), true);
        assert.equal(s.coord.getTask(s.task.id)!.generation, s.task.generation);
        assert.equal(s.coord.getTask(s.task.id)!.status, 'needs_human');
        assert.equal(s.coord.getRun(s.run.id)!.status, 'stopped', 'only the utility hold blocks this case');
      }
      gate.release();
      const result = await cleanup;
      assert.equal(readFileSync(gate.completed, 'utf8'), '0', 'the gated scan executes real du successfully');
      if (change === 'unchanged') {
        assert.deepEqual(result.failed, []);
        assert.deepEqual(result.removed, s.plan.remove);
        assert.equal(existsSync(s.artifact), false);
      } else {
        assert.deepEqual(result.removed, []);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0]!.item.target, s.artifact);
        assert.match(result.failed[0]!.error, change === 'reclaim' ? /Artifact owner changed/ : /Utility exit is unconfirmed/);
        assert.deepEqual(readFileSync(join(s.artifact, 'rebuildable.bin')), s.contents);
      }
    } finally {
      gate.release();
      await cleanup;
      gate.restore();
      s.coord.db.close();
      rmSync(s.root, { recursive: true, force: true });
    }
  });
}
