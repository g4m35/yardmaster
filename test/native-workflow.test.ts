import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { fleetClient } from '../src/fleet-client.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture() {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, worktree: { warmStart: 'off' },
    disk: { minFreeGb: 0, maxWorktreesGb: null }, cleanup: { auto: false, deleteMergedBranches: false } });
  const hub = new Hub({ db: openDb(join(box.home, 'native-live.db')), token: 'native-fixture-owner', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, includeMock: false, tickMs: 100, quiet: true });
  const url = await hub.start();
  const api = fleetClient(url, hub.token);
  const project = await hub.coord.registerProject(box.repo);
  const sessionId = await api['session.register']({ name: 'editor', agent: 'native', projectId: project.id, cwd: box.repo, machineId: 'm-hub' });
  const task = hub.coord.addTasks(project.id, [{ title: 'Native result under a live scheduler', files: ['result.txt'], verify: ['node -e "setTimeout(()=>{},500)"'] }], 'fixture').created[0]!;
  const claim = await api['session.claim']({ sessionId, projectId: project.id, taskId: task.id }); assert.ok(claim);
  sh(box.repo, 'git', ['checkout', '-qb', 'native-result']);
  const commit = (text: string) => { writeFileSync(join(box.repo, 'result.txt'), text); sh(box.repo, 'git', ['add', 'result.txt']); sh(box.repo, 'git', ['commit', '-qm', 'native result']); };
  const submit = (generation = claim.generation) => api['session.finish']({ sessionId, taskId: task.id, generation, branch: 'native-result', summary: 'Native result' });
  const final = () => until(() => hub.coord.getTask(task.id)!, task => ['done', 'needs_human', 'failed'].includes(task.status), 15_000, 'native artifact outcome');
  return { ...box, hub, api, project, sessionId, task, claim, commit, submit, final,
    async close() { await hub.stop(); hub.coord.db.close(); } };
}

for (const failure of ['uncommitted', 'checks'] as const) {
  for (const retry of [false, true]) test(`live Hub: ${failure} native failure can be taken again (retry=${retry}) without rechecking the old artifact`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      if (failure === 'uncommitted') {
        writeFileSync(join(f.repo, 'result.txt'), 'uncommitted\n');
        await assert.rejects(f.submit(), /Take this task again/);
      } else {
        f.commit('BRO' + 'KEN\n'); await f.submit();
        assert.equal((await f.final()).status, 'needs_human');
      }
      const runsBefore = f.hub.coord.runsFor(f.task.id).length;
      f.commit('fixed\n');
      let ticks = 0;
      const tick = f.hub.worker.tick.bind(f.hub.worker);
      f.hub.worker.tick = async () => { ticks++; return tick(); };
      if (retry) await f.api['task.control']({ id: f.task.id, action: 'retry' });
      await until(() => ticks, n => n >= 3, 5000, 'scheduler competing before native reclaim');
      assert.equal(f.hub.coord.runsFor(f.task.id).length, runsBefore, 'waiting for edits cannot run verification/review again');
      const claim = await f.api['session.claim']({ sessionId: f.sessionId, projectId: f.project.id, taskId: f.task.id }); assert.ok(claim);
      assert.ok(claim.generation > f.claim.generation);
      await f.submit(claim.generation);
      assert.equal((await f.final()).status, 'done');
      assert.ok(f.hub.coord.eventsSince(0, f.project.id, 100, f.task.id).some(e => e.kind === 'task.ready'));
      assert.equal(sh(f.repo, 'git', ['branch', '--show-current']), 'native-result');
    } finally { await f.close(); }
  });
}

test('live Hub verifies the captured ref while the native editor switches branches and creates scratch work', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.commit('correct\n'); const sha = sh(f.repo, 'git', ['rev-parse', 'HEAD']);
    await f.submit();
    await until(() => f.hub.coord.getTask(f.task.id)!.status, status => status === 'verifying', 10_000, 'artifact verification');
    sh(f.repo, 'git', ['checkout', '-q', 'main']);
    writeFileSync(join(f.repo, 'scratch.txt'), 'Keep native scratch work');
    assert.equal((await f.final()).status, 'done');
    assert.equal(sh(f.repo, 'git', ['branch', '--show-current']), 'main');
    assert.equal(readFileSync(join(f.repo, 'scratch.txt'), 'utf8'), 'Keep native scratch work');
    assert.equal(sh(f.repo, 'git', ['rev-parse', `refs/yardmaster/native/${f.task.id}/${f.claim.generation}`]), sha);
  } finally { await f.close(); }
});

test('native capture does not refresh or rewrite the editor index', async () => {
  const f = await fixture();
  try {
    f.commit('correct\n');
    const index = join(f.repo, '.git', 'index');
    const before = readFileSync(index);
    utimesSync(join(f.repo, 'result.txt'), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    await f.submit();
    assert.deepEqual(readFileSync(index), before, 'read-only capture must not write refreshed stat data to the source index');
    await f.final();
  } finally { await f.close(); }
});

for (const shutdown of [false, true]) test(`live Hub tracks an in-flight native capture through janitor ticks and shutdown=${shutdown}`, async () => {
  const f = await fixture(); const originalPath = process.env.PATH;
  const git = sh(f.repo, 'which', ['git']); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const marker = join(f.root, 'capturing');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "check-ref-format" ]; then touch '${marker}'; sleep 1; fi\nexec '${git}' "$@"\n`, { mode: 0o700 });
  try {
    f.commit('correct\n'); process.env.PATH = `${bin}:${originalPath}`;
    const pending = f.submit();
    const outcome = pending.then(task => ({ task, error: null }), (error: Error) => ({ task: null, error }));
    await until(() => existsSync(marker), Boolean, 3000, 'capture spanning multiple janitor ticks');
    await assert.rejects(f.submit(), /still in progress/);
    if (shutdown) {
      await f.hub.stop();
      assert.ok((await outcome).error);
      assert.notEqual(f.hub.coord.getTask(f.task.id)!.status, 'ready');
      assert.equal(f.hub.coord.runsFor(f.task.id).some(run => ['running', 'cleanup_failed'].includes(run.status)), false);
    } else {
      assert.equal((await outcome).error, null);
      assert.equal((await f.final()).status, 'done', 'janitor must not reap an in-process capture as an orphan');
    }
  } finally { process.env.PATH = originalPath; await f.close(); }
});

test('pause-now lets verification finish without relaunching its coding agent', { timeout: 20_000 }, async () => {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' }, cleanup: { auto: false }, disk: { minFreeGb: 0 } });
  const hub = new Hub({ db: openDb(join(box.home, 'pause.db')), token: 'pause-owner', machineId: 'm-pause', includeMock: true, port: 0, host: '127.0.0.1', tickMs: 100, quiet: true });
  try {
    const api = fleetClient(await hub.start(), hub.token); const project = await hub.coord.registerProject(box.repo);
    const task = hub.coord.addTasks(project.id, [{ title: 'Finish checks once', agent: 'mock', prompt: '@mock write result.txt correct', verify: ['node -e "setTimeout(()=>{},900)"'] }], 'pause fixture').created[0]!;
    await until(() => hub.coord.getTask(task.id)!.status, status => status === 'verifying', 10_000, 'running verification');
    await api['fleet.pause']({ projectId: project.id, stopRunning: true });
    await until(() => hub.coord.getTask(task.id)!.status, status => ['ready', 'done', 'needs_human'].includes(status), 10_000, 'checks finishing while paused');
    assert.ok(['ready', 'done'].includes(hub.coord.getTask(task.id)!.status));
    assert.equal(hub.coord.runsFor(task.id).filter(run => run.role === 'implement').length, 1);
    await api['fleet.resume']({ projectId: project.id });
    assert.equal(hub.coord.runsFor(task.id).filter(run => run.role === 'implement').length, 1);
  } finally { await hub.stop(); hub.coord.db.close(); }
});
