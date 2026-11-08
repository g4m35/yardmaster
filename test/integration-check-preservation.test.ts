import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { Integrator } from '../src/integrator.ts';
import { Semaphore } from '../src/runner.ts';
import { sandbox, sh } from './helpers.ts';

type Mutation = 'tracked-edit' | 'check-commit' | 'unchanged';
async function fixture(trainSize: number, mutation: Mutation) {
  const box = sandbox({
    verifyQuick: ['node -e "process.exit(0)"'],
    integration: { trainSize, syncBase: false },
    cleanup: { auto: false },
    worktree: { warmStart: 'off' },
    review: { mode: 'never' },
  });
  const sentinel = `verification must preserve ${mutation}\n`;
  writeFileSync(join(box.repo, 'check.mjs'), `import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
import {execFileSync} from 'node:child_process';
if(basename(process.cwd()) !== '_integration') process.exit(0);
${mutation === 'unchanged' ? '' : `appendFileSync('README.md', ${JSON.stringify(sentinel)});`}
${mutation === 'check-commit' ? `execFileSync('git',['add','README.md']);execFileSync('git',['commit','-qm','commit created by combined verification']);` : ''}
console.error('combined verification deliberately failed');process.exitCode=1;
`);
  sh(box.repo, 'git', ['add', 'check.mjs']);
  sh(box.repo, 'git', ['commit', '-qm', 'install integration-only verification fixture']);
  const base = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  const originalReadme = readFileSync(join(box.repo, 'README.md'), 'utf8');
  const dbFile = join(box.home, 'integration.sqlite');
  const coord = new Coordinator(openDb(dbFile));
  const project = await coord.registerProject(box.repo);
  const tasks = [];
  for (let i = 0; i < trainSize; i++) {
    const file = `task-${i}.txt`;
    const task = coord.addTasks(project.id, [{ title: `Independent artifact ${i}`, prompt: 'Integrate the committed fixture artifact without invoking an agent.', files: [file], agent: 'mock' }], 'test', { force: true }).created[0]!;
    const claim = coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} });
    assert.equal(claim?.task.id, task.id);
    const branch = `fixture/artifact-${i}`;
    const worktree = join(box.root, `artifact-${i}`);
    sh(box.repo, 'git', ['worktree', 'add', '-qb', branch, worktree, base]);
    writeFileSync(join(worktree, file), `accepted artifact ${i}\n`);
    sh(worktree, 'git', ['add', file]);
    sh(worktree, 'git', ['commit', '-qm', `accepted artifact ${i}`]);
    const head = sh(worktree, 'git', ['rev-parse', 'HEAD']);
    coord.updateTask(task.id, { status: 'ready', branch, worktree, base_sha: base, head_sha: head, ready_at: Date.now() + i });
    tasks.push(coord.getTask(task.id)!);
  }
  const integrator = new Integrator(coord, new Semaphore(1));
  assert.equal(await integrator.head(project.id), base);
  const path = integrator.integrationPath(project, coord.configFor(project.id));
  return { ...box, dbFile, coord, project, tasks, integrator, path, base, sentinel, originalReadme };
}

for (const trainSize of [1, 2]) for (const mutation of ['tracked-edit', 'check-commit'] as const) {
  test(`${trainSize === 1 ? 'single merge' : 'merge train'} preserves ${mutation} from a failed combined check across head and restart`, async () => {
    const s = await fixture(trainSize, mutation);
    let coord = s.coord;
    let integrator = s.integrator;
    try {
      const progressed = await integrator.step(s.project.id);
      assert.equal(readFileSync(join(s.path, 'README.md'), 'utf8'), s.originalReadme + s.sentinel, 'failed verification must preserve its changed tracked file before any rollback');
      assert.equal(progressed, false, 'mutated verification must hold integration before rollback');
      const preservedHead = sh(s.path, 'git', ['rev-parse', 'HEAD']);
      const checkedHead = coord.getMeta(`integrating_result:${s.project.id}`);
      assert.ok(checkedHead);
      assert.equal(coord.getMeta(`integrating:${s.project.id}`), s.base, 'interrupted marker must remain to protect the changed checkout');
      if (mutation === 'check-commit') {
        assert.notEqual(preservedHead, checkedHead, 'the check must have created a real commit after the checked merge');
        assert.equal(sh(s.path, 'git', ['log', '-1', '--format=%s']), 'commit created by combined verification');
        assert.equal(sh(s.path, 'git', ['status', '--porcelain']), '');
      } else {
        assert.equal(preservedHead, checkedHead);
        assert.match(sh(s.path, 'git', ['status', '--porcelain']), /M README\.md/);
      }
      for (const task of s.tasks) {
        assert.equal(coord.getTask(task.id)!.status, 'merging');
        assert.match(coord.getTask(task.id)!.attention ?? '', /Verification changed the integration checkout/);
        sh(s.path, 'git', ['merge-base', '--is-ancestor', task.head_sha!, preservedHead]);
      }
      assert.ok(coord.eventsSince(0, s.project.id, 100).some(event => event.kind === 'integration.verification_changed'));
      assert.ok(coord.eventsSince(0, s.project.id, 100).some(event => event.kind === (trainSize === 2 ? 'integration.train' : 'integration.reverify')));
      const assertPreserved = () => {
        assert.equal(readFileSync(join(s.path, 'README.md'), 'utf8'), s.originalReadme + s.sentinel);
        assert.equal(sh(s.path, 'git', ['rev-parse', 'HEAD']), preservedHead);
        assert.equal(coord.getMeta(`integrating:${s.project.id}`), s.base);
        assert.equal(coord.getMeta(`integrating_result:${s.project.id}`), checkedHead);
        for (let i = 0; i < trainSize; i++) assert.equal(readFileSync(join(s.path, `task-${i}.txt`), 'utf8'), `accepted artifact ${i}\n`);
        assert.equal(readFileSync(join(s.repo, 'README.md'), 'utf8'), s.originalReadme, 'the user checkout must remain untouched');
      };
      assertPreserved();
      await integrator.head(s.project.id);
      await integrator.step(s.project.id);
      assertPreserved();
      await integrator.stop(); coord.db.close();
      coord = new Coordinator(openDb(s.dbFile));
      integrator = new Integrator(coord, new Semaphore(1));
      await integrator.head(s.project.id);
      await integrator.step(s.project.id);
      await integrator.head(s.project.id);
      assertPreserved();
      for (const task of s.tasks) assert.match(coord.getTask(task.id)!.attention ?? '', /preserved/);
    } finally { await integrator.stop(); coord.db.close(); }
  });
}

for (const trainSize of [1, 2]) test(`${trainSize === 1 ? 'single merge' : 'merge train'} still rolls back an unchanged failed check`, async () => {
  const s = await fixture(trainSize, 'unchanged');
  try {
    await s.integrator.step(s.project.id);
    assert.equal(sh(s.path, 'git', ['rev-parse', 'HEAD']), s.base);
    assert.equal(sh(s.path, 'git', ['status', '--porcelain']), '');
    assert.equal(readFileSync(join(s.path, 'README.md'), 'utf8'), s.originalReadme);
    assert.equal(s.coord.getMeta(`integrating:${s.project.id}`), null);
    assert.ok(s.tasks.every(task => s.coord.getTask(task.id)!.status !== 'merging'));
    assert.equal(s.coord.eventsSince(0, s.project.id, 100).some(event => event.kind === 'integration.verification_changed'), false);
    assert.ok(s.coord.eventsSince(0, s.project.id, 100).some(event => event.kind === 'integration.reverify_failed'));
    assert.equal(await s.integrator.head(s.project.id), s.base);
  } finally { await s.integrator.stop(); s.coord.db.close(); }
});
