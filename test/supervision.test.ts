import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { StaleAttemptError } from '../src/coordinator.ts';
import { planCleanup, runCleanup, diskReport } from '../src/janitor.ts';
import { killGroup } from '../src/proc.ts';
import { activityLogPath } from '../src/api.ts';
import type { Task } from '../src/types.ts';

/** Supervision, disk management, and regressions for the issues found in review. */

let hub: Hub | null = null;
after(async () => {
  await hub?.stop();
});

async function startHub(globalConfig: Record<string, unknown> = {}, projectConfig: Record<string, unknown> = {}, opts: { autostart?: boolean } = {}) {
  await hub?.stop();
  const box = sandbox(globalConfig);
  writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], ...projectConfig }));
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-qm', 'config']);
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok', machineId: `m-hub-${Date.now()}`, port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  const project = await hub.coord.registerProject(box.repo);
  if (opts.autostart !== false) await hub.start();
  const h = hub;
  const add = (tasks: Parameters<Hub['coord']['addTasks']>[1]) => h.coord.addTasks(project.id, tasks, 'test').created;
  const get = (id: string) => h.coord.getTask(id)!;
  const wait = (id: string, pred: (t: Task) => boolean, label: string, ms = 30_000) => until(() => get(id), pred, ms, label);
  const onIntegration = (path: string) => {
    try {
      return sh(box.repo, 'git', ['show', `yardmaster/integration:${path}`]);
    } catch {
      return null;
    }
  };
  return { ...box, hub: h, project, add, get, wait, onIntegration };
}

const settled = (t: Task) => ['done', 'needs_human', 'failed', 'canceled'].includes(t.status);

test('canceling during verification keeps the work out of the integration branch', async () => {
  const s = await startHub({}, { verify: ['node check.mjs', 'node -e "setTimeout(() => {}, 2500)"'] });
  const [t] = s.add([{ title: 'Add the pricing table', prompt: '@mock write pricing.js export const p = 1', agent: 'mock' }]);
  await s.wait(t!.id, (x) => x.status === 'verifying', 'verifying');
  s.hub.coord.control(t!.id, 'cancel', 'test');
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(s.get(t!.id).status, 'canceled', 'the finishing attempt did not overwrite the cancel');
  assert.equal(s.onIntegration('pricing.js'), null, 'canceled work never merged');
});

test('a stale attempt cannot write over a newer one', async () => {
  const s = await startHub({}, {}, { autostart: false });
  const [t] = s.add([{ title: 'Refactor the logger', prompt: 'x', agent: 'mock' }]);
  const claim = s.hub.coord.claimNext({ machineId: 'm-laptop', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!;
  const owner = { generation: claim.task.generation, attempt: claim.task.attempts, assignee: claim.task.assignee! };
  // This fixture never attached/launched a run. Its machine can explicitly return that allowance.
  s.hub.coord.abandonUnlaunchedClaim(t!.id, claim.task.generation, 'm-laptop');
  // The laptop goes to sleep; its lease expires and another machine takes the task.
  s.hub.coord.updateTask(t!.id, { status: 'queued', assignee: null, machine_id: null, lease_until: null, attempts: 0 });
  s.hub.coord.claimNext({ machineId: 'm-desktop', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} });
  assert.throws(() => s.hub.coord.updateTaskIfOwner(t!.id, owner, { status: 'ready' }), StaleAttemptError);
  assert.equal(s.get(t!.id).assignee, 'machine:m-desktop');
  // And its upload is refused by the hub.
  await s.hub.start();
  const res = await fetch(`${s.hub.url}/api/tasks/${t!.id}/bundle?branch=yardmaster/${t!.id}&machine=m-laptop&head=${'a'.repeat(40)}`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-length': '1' }, body: 'x' });
  assert.equal(res.status, 409);
});

test('commits made on a detached HEAD are adopted, not lost', async () => {
  const s = await startHub();
  const [t] = s.add([{ title: 'Write the CSV exporter', prompt: '@mock git checkout -q --detach\n@mock write export.js export const csv = 1\n@mock git add -A\n@mock git -c user.name=a -c user.email=a@a commit -qm wip', agent: 'mock' }]);
  const final = await s.wait(t!.id, settled, 'settled');
  assert.equal(final.status, 'done', final.attention ?? '');
  assert.equal(s.onIntegration('export.js'), 'export const csv = 1');
});

test('a hand edit in the integration worktree is never reset', async () => {
  const s = await startHub();
  const [first] = s.add([{ title: 'Create the base module', prompt: '@mock write base.js one', agent: 'mock' }]);
  await s.wait(first!.id, (x) => x.status === 'done', 'first merged');
  const integration = join(s.root, 'worktrees', `repo-${s.project.id.slice(2, 8)}`, '_integration');
  writeFileSync(join(integration, 'base.js'), 'my manual fix in progress\n');
  const [second] = s.add([{ title: 'Add the second module', prompt: '@mock write second.js two', agent: 'mock' }]);
  await s.wait(second!.id, (x) => x.status === 'ready', 'second ready');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(s.get(second!.id).status, 'ready', 'merging waits while a person is working there');
  assert.equal(sh(integration, 'cat', ['base.js']), 'my manual fix in progress');
  assert.ok(s.hub.coord.eventsSince(0, null, 300).some((e) => e.kind === 'integration.manual'));
});

test('pause stops new work; pause --now parks running agents with their work saved', async () => {
  const s = await startHub();
  s.hub.coord.setPaused(null, true, 'test');
  const [t] = s.add([{ title: 'Build the search index', prompt: '@mock write idx.js part1\n@mock unless-prompt RESUMEDNOTE sleep 30000\n@mock write idx2.js part2', agent: 'mock' }]);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.get(t!.id).status, 'queued');
  assert.match(s.hub.coord.blocker(s.get(t!.id))!, /Paused/);
  s.hub.coord.setPaused(null, false, 'test');
  await s.wait(t!.id, (x) => x.status === 'running', 'running');
  await until(() => existsSync(join(s.get(t!.id).worktree ?? '/nope', 'idx.js')), (v) => v, 10_000, 'part1 written');
  await s.hub.client['fleet.pause']({ projectId: null, stopRunning: true, by: 'test' });
  const parked = await s.wait(t!.id, (x) => x.status === 'queued', 'parked');
  assert.equal(parked.attempts, 0, 'pausing does not use up an attempt');
  assert.ok(sh(s.repo, 'git', ['log', '--oneline', `yardmaster/${t!.id}`]).includes('partial work'), `partial work was committed: ${JSON.stringify(s.hub.coord.eventsSince(0, s.project.id, 100).filter(event => event.task_id === t!.id))}`);
  // Resume with guidance so the mock skips the long sleep this time.
  s.hub.coord.control(t!.id, 'redirect', 'test', 'RESUMEDNOTE: finish up');
  await s.hub.client['fleet.resume']({ projectId: null, by: 'test' });
  const done = await s.wait(t!.id, settled, 'done after resume');
  assert.equal(done.status, 'done', done.attention ?? '');
  assert.equal(s.onIntegration('idx2.js'), 'part2');
});

test('redirecting a running agent restarts it with the guidance and keeps its work', async () => {
  const s = await startHub();
  const [t] = s.add([{ title: 'Implement the importer', prompt: '@mock write started.js 1\n@mock unless-prompt GUIDANCE42 sleep 30000\n@mock write result.js ok', agent: 'mock' }]);
  await until(() => existsSync(join(s.get(t!.id).worktree ?? '/nope', 'started.js')), (v) => v, 15_000, 'started');
  s.hub.coord.control(t!.id, 'redirect', 'test', 'GUIDANCE42: skip the slow path');
  const done = await s.wait(t!.id, settled, 'done');
  assert.equal(done.status, 'done', done.attention ?? '');
  assert.equal(done.attempts, 1, 'a redirect is not a failed attempt');
  assert.ok(s.onIntegration('started.js') && s.onIntegration('result.js'));
  assert.ok(s.hub.coord.runsFor(t!.id).some((r) => r.stop_reason === 'redirected'));
});

test('the supervisor explains stalls, frees abandoned reservations, flags slow agents and budget burn', async () => {
  const s = await startHub({ supervision: { queueStallMinutes: 0.001, slowProgressMinutes: 0.01, idleLockMinutes: 0.001 }, budget: { perTaskUsd: 0.7, dailyUsd: 1 } });
  const [noAgent] = s.add([{ title: 'Port to the new framework', prompt: 'x', agent: 'aider' }]);
  // A session reserved a file and vanished; a task needs that file.
  s.hub.coord.claimLocks(s.project.id, 'session:ghost', ['shared/config.js'], 'editing', 30);
  const [blocked] = s.add([{ title: 'Tune the shared config', prompt: '@mock write shared/config.js tuned', files: ['shared/config.js'], agent: 'mock', budgetUsd: 0.1 }]);
  const [slow] = s.add([{ title: 'Investigate memory usage', prompt: '@mock cost 0.6\n@mock sleep 8000\n@mock write mem.js x', agent: 'mock' }]);
  // Wait for each condition rather than a fixed delay: CI machines vary a lot in speed.
  const warnings = await until(
    () => s.hub.supervisor.check().map((w) => w.message).join('\n'),
    (w) => /no online machine has aider/.test(w) && /Investigate memory usage" has run .* without changing any files/.test(w) && /budget runs out around/.test(w),
    20_000,
    'all three supervisor warnings',
  );
  assert.match(warnings, /Port to the new framework" is ready but hasn't started: no online machine has aider/);
  assert.ok(s.hub.coord.eventsSince(0, null, 300).some((e) => e.kind === 'supervisor.released'), 'abandoned reservation released');
  const b = await s.wait(blocked!.id, settled, 'blocked task done');
  assert.equal(b.status, 'done');
  assert.ok(noAgent && slow);
});

test('low disk holds new work instead of filling the drive', async () => {
  const s = await startHub({ disk: { minFreeGb: 1e9 } });
  const [t] = s.add([{ title: 'Generate thumbnails', prompt: '@mock write thumbs.js x', agent: 'mock' }]);
  await until(() => s.hub.coord.eventsSince(0, null, 300).find((e) => e.kind === 'machine.disk'), (e) => !!e, 10_000, 'disk warning');
  assert.equal(s.get(t!.id).status, 'queued');
});

test('cleanup trims build output from kept worktrees but never their real work', async () => {
  const s = await startHub({ retry: { maxAttempts: 1, backoffSeconds: 0 } });
  const [t] = s.add([{ title: 'Add the payments page', prompt: "@mock write node_modules/dep/index.js x\n@mock write pay.js BROKEN", agent: 'mock' }]);
  // check.mjs looks for the joined marker; write the real failure marker literally.
  const final = await s.wait(t!.id, settled, 'settled');
  assert.ok(['failed', 'needs_human'].includes(final.status), final.status);
  const wt = final.worktree!;
  mkdirSync(join(wt, 'node_modules', 'big'), { recursive: true });
  writeFileSync(join(wt, 'node_modules', 'big', 'blob.bin'), Buffer.alloc(2_000_000));
  writeFileSync(join(wt, 'notes.txt'), 'uncommitted notes from the agent');
  const report = await diskReport(s.hub.coord, s.project.id);
  assert.ok(report.worktrees.some((w) => w.taskId === t!.id && w.bytes > 1e6));
  const plan = await planCleanup(s.hub.coord, s.project.id);
  const art = plan.remove.find((i) => i.kind === 'artifacts');
  assert.ok(art && art.target === join(wt, 'node_modules'), JSON.stringify(plan, null, 1));
  assert.ok(!plan.remove.some((i) => i.kind === 'worktree' && i.target === wt), 'the worktree itself is kept');
  await runCleanup(s.hub.coord, plan);
  assert.ok(!existsSync(join(wt, 'node_modules')));
  assert.ok(existsSync(join(wt, 'notes.txt')), 'uncommitted work survives');
  assert.ok(existsSync(join(wt, 'pay.js')));
});

test('hardening: run columns are whitelisted, ids validated, dangerous pids refused', async () => {
  const s = await startHub({}, {}, { autostart: false });
  const [t] = s.add([{ title: 'Some task here', prompt: 'x', agent: 'mock' }]);
  const claim = s.hub.coord.claimNext({ machineId: 'm', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!;
  const run = s.hub.coord.startRun(claim.task, 'm', 'mock', null, '/tmp/x');
  assert.throws(() => s.hub.coord.updateRun(run.id, { ['status = 1, pid' as 'pid']: 1 }), /Cannot update run column/);
  assert.throws(() => activityLogPath('../../etc/passwd'), /bad run id/);
  assert.equal(killGroup(1), false);
  assert.equal(killGroup(process.pid), false);
  await assert.rejects(s.hub.client['run.log']({ runId: '../x', lines: ['a'] }), /not a run id/);
});
