import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { planCleanup, runCleanup } from '../src/janitor.ts';
import { isAlive } from '../src/proc.ts';
import type { Task } from '../src/types.ts';

/**
 * Realistic multi-agent scenarios against real git repositories, using the deterministic mock agent.
 * Each test gets its own home directory, database, hub, and repo.
 */

const hubs: Hub[] = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

async function startHub(globalConfig: Record<string, unknown> = {}, projectConfig: Record<string, unknown> = {}) {
  // Tests share process.env, so only one hub may be alive at a time.
  while (hubs.length) await hubs.pop()!.stop();
  const box = sandbox(globalConfig);
  if (Object.keys(projectConfig).length) {
    writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], ...projectConfig }));
    sh(box.repo, 'git', ['commit', '-qam', 'config']);
  }
  const hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'test-token', machineId: `m-hub-${Date.now()}`, port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  hubs.push(hub);
  await hub.start();
  const project = await hub.coord.registerProject(box.repo);
  const add = (tasks: Parameters<Hub['coord']['addTasks']>[1]) => hub.coord.addTasks(project.id, tasks, 'test');
  const get = (id: string) => hub.coord.getTask(id)!;
  const settle = (ids: string[], timeout = 40_000) =>
    until(() => ids.map(get), (ts) => ts.every((t) => ['done', 'needs_human', 'failed', 'canceled'].includes(t.status)), timeout, `tasks ${ids.join(',')} to settle`);
  return { ...box, hub, project, add, get, settle };
}

function fileOnIntegration(repo: string, path: string): string | null {
  try {
    return sh(repo, 'git', ['show', `yardmaster/integration:${path}`]);
  } catch {
    return null;
  }
}

function overlapped(a: { started_at: number; ended_at: number | null }, b: { started_at: number; ended_at: number | null }) {
  return a.started_at < (b.ended_at ?? Infinity) && b.started_at < (a.ended_at ?? Infinity);
}

test('parallel work, file-scope waits, dependencies, and safe integration', async () => {
  const s = await startHub();
  const mainBefore = sh(s.repo, 'git', ['rev-parse', 'main']);
  const { created } = s.add([
    { key: 'a', title: 'Build module A', prompt: '@mock write src/a/index.js export const a = 1\n@mock sleep 600', files: ['src/a/**'], agent: 'mock' },
    { key: 'b', title: 'Build module B', prompt: '@mock write src/b/index.js export const b = 2\n@mock sleep 600', files: ['src/b/**'], agent: 'mock' },
    { key: 'c', title: 'Extend module A with helpers', prompt: '@mock write src/a/extra.js export const extra = 3', files: ['src/a/**'], agent: 'mock' },
    { key: 'd', title: 'Wire A and B together', prompt: '@mock write src/d.js import "./a/index.js"; import "./b/index.js";', files: ['src/d.js'], after: ['a', 'b'], agent: 'mock' },
  ]);
  assert.equal(created.length, 4);
  const [a, b, c, d] = created.map((t) => t.id) as [string, string, string, string];
  const tasks = await s.settle([a, b, c, d]);
  assert.deepEqual(tasks.map((t) => t.status), ['done', 'done', 'done', 'done'], JSON.stringify(tasks.map((t) => [t.title, t.status, t.attention])));

  const run = (id: string) => s.hub.coord.runsFor(id)[0]!;
  assert.ok(overlapped(run(a), run(b)), 'independent tasks ran at the same time');
  assert.ok(!overlapped(run(a), run(c)), 'tasks with overlapping files never ran at the same time');
  assert.ok(run(d).started_at >= Math.max(s.get(a).finished_at!, s.get(b).finished_at!), 'dependent task waited for both prerequisites to merge');

  for (const f of ['src/a/index.js', 'src/b/index.js', 'src/a/extra.js', 'src/d.js']) assert.ok(fileOnIntegration(s.repo, f), `${f} merged`);
  assert.equal(sh(s.repo, 'git', ['rev-parse', 'main']), mainBefore, "the user's branch was never touched");
  assert.equal(sh(s.repo, 'git', ['status', '--porcelain']), '', "the user's working tree is clean");
  assert.equal(sh(s.repo, 'git', ['branch', '--show-current']), 'main');
  for (const id of [a, b, c, d]) assert.equal(s.get(id).worktree, null, 'merged worktrees are cleaned up');
});

test('a looping agent is stopped, escalated once, then handed to a human', async () => {
  const s = await startHub({ watchdog: { repeatThreshold: 4 } });
  const [t] = s.add([{ title: 'Investigate config loading', prompt: '@mock loop', agent: 'mock', tier: 'cheap' }]).created;
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'needs_human');
  assert.equal(final!.attempts, 2, 'stopped after the same failure twice, not after max attempts');
  assert.equal(final!.tier, 'standard', 'escalated to a stronger model for the second attempt');
  assert.match(final!.attention!, /same way 2 times/);
  for (const r of s.hub.coord.runsFor(t!.id)) {
    assert.equal(r.stop_reason, 'loop');
    assert.ok(!isAlive(r.pid), 'agent process was killed');
  }
});

test('the same verification failure stops early instead of burning all attempts', async () => {
  const s = await startHub({ retry: { maxAttempts: 5, backoffSeconds: 0 } });
  const [t] = s.add([{ title: 'Add feature flag', prompt: '@mock write flags.js BROKEN', agent: 'mock' }]).created;
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'needs_human');
  assert.equal(final!.attempts, 2);
  assert.match(final!.last_error!, /BROKEN found in flags.js/);
});

test('a failed check is retried with the failure as context and then succeeds', async () => {
  const s = await startHub();
  const [t] = s.add([{ title: 'Write the parser', prompt: '@mock attempt 1 write parser.js BROKEN\n@mock attempt 2 write parser.js export const parse = (x) => x;', agent: 'mock', tier: 'cheap' }]).created;
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'done');
  assert.equal(final!.attempts, 2);
  assert.equal(final!.tier, 'cheap', 'a first failure is retried by the same (cheaper) model, which now sees the error');
  assert.equal(fileOnIntegration(s.repo, 'parser.js'), 'export const parse = (x) => x;');
});

test('a second, different failure escalates to a stronger model', async () => {
  const s = await startHub();
  const marker = 'BRO' + 'KEN';
  const [t] = s.add([{ title: 'Write the lexer', prompt: `@mock attempt 1 write lexer.js ${marker}\n@mock attempt 2 write lexer.js ok\n@mock attempt 2 write tokens.js ${marker}\n@mock attempt 3 write tokens.js ok`, agent: 'mock', tier: 'cheap' }]).created;
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'done', final!.attention ?? '');
  assert.equal(final!.attempts, 3);
  assert.equal(final!.tier, 'standard');
});

test('an agent that changes nothing is not accepted as done', async () => {
  const s = await startHub({ retry: { maxAttempts: 2, backoffSeconds: 0 } });
  const [t, r] = s.add([
    { title: 'Implement caching layer', prompt: 'nothing here', agent: 'mock' },
    { title: 'Review the error handling', prompt: 'read only', agent: 'mock', allowNoChanges: true },
  ]).created;
  const [ft, fr] = await s.settle([t!.id, r!.id]);
  assert.equal(ft!.status, 'needs_human');
  assert.match(ft!.last_error!, /no files changed/);
  assert.equal(fr!.status, 'done', 'review tasks may legitimately change nothing');
});

test('merge conflicts are sent back to the agent with the newer work merged in', async () => {
  const s = await startHub({ liveOverlapCheck: false });
  const { created } = s.add([
    // File names without extensions are invisible to scope inference, so both tasks run in parallel and collide at merge time.
    { title: 'Set greeting to hello', prompt: '@mock write GREETING hello', agent: 'mock', priority: 2 },
    { title: 'Set the greeting text to hi there', prompt: '@mock sleep 400\n@mock attempt 1 write GREETING hi\n@mock attempt 2 write GREETING hello and hi', agent: 'mock' },
  ]);
  const [first, second] = await s.settle(created.map((t) => t.id));
  assert.equal(first!.status, 'done');
  assert.equal(second!.status, 'done', JSON.stringify(second));
  assert.equal(second!.conflict_rounds, 1);
  assert.equal(fileOnIntegration(s.repo, 'GREETING'), 'hello and hi');
});

test('two tasks that start editing the same file are serialized at edit time', async () => {
  const s = await startHub();
  const { created } = s.add([
    { title: 'Rewrite the shared config loader', prompt: '@mock write SHARED export const v = "a"\n@mock sleep 2500', agent: 'mock', priority: 1 },
    { title: 'Add environment overrides to config', prompt: '@mock sleep 200\n@mock write SHARED export const v = "b"\n@mock sleep 2500', agent: 'mock' },
  ]);
  const [first, second] = await s.settle(created.map((t) => t.id), 60_000);
  if (process.env.YM_DEBUG) console.log(JSON.stringify([first, second].map((t) => [t!.status, t!.attention, t!.attempts]), null, 1), s.hub.coord.eventsSince(0, null, 100).map((e) => `${e.task_id} ${e.kind} ${e.message}`).join('\n'));
  assert.equal(first!.status, 'done');
  assert.equal(second!.status, 'done');
  const events = s.hub.coord.eventsSince(0, null, 500, second!.id);
  assert.ok(events.some((e) => e.kind === 'task.preempted'), 'second task was paused when it touched the same file');
  assert.equal(second!.conflict_rounds, 0, 'no merge-time conflict happened');
  assert.equal(fileOnIntegration(s.repo, 'SHARED'), 'export const v = "b"');
});

test('file names in a plain-language request become a scope that prevents collisions', async () => {
  const s = await startHub({ liveOverlapCheck: false });
  const { created } = s.add([
    { title: 'Update the intro in notes.md', prompt: '@mock write notes.md intro\n@mock sleep 500', agent: 'mock' },
    { title: 'Add a FAQ section to notes.md', prompt: '@mock write notes.md faq', agent: 'mock' },
  ]);
  assert.deepEqual(created[0]!.scope, ['notes.md']);
  const [a, b] = await s.settle(created.map((t) => t.id));
  assert.equal(a!.status, 'done');
  assert.equal(b!.status, 'done');
  assert.equal(b!.conflict_rounds, 0);
  assert.ok(!overlapped(s.hub.coord.runsFor(a!.id)[0]!, s.hub.coord.runsFor(b!.id)[0]!));
});

test('duplicates are skipped and dependency cycles rejected', async () => {
  const s = await startHub();
  s.hub.worker.stopAll('shutdown', 'test');
  const first = s.add([{ title: 'Add dark mode toggle to settings page', agent: 'mock' }]);
  const again = s.add([{ title: 'add a dark-mode toggle to the settings page', agent: 'mock' }]);
  assert.equal(again.created.length, 0);
  assert.equal(again.duplicates[0]!.existing, first.created[0]!.id);
  const x = s.add([{ title: 'Task x thing one', agent: 'mock' }]).created[0]!;
  assert.throws(() => s.add([{ key: 'y', title: 'Task y thing two', after: [x.id, 'z'] }, { key: 'z', title: 'Task z thing three', after: ['y'] }]), /wait on each other forever/);
});

test('budgets stop runaway spend', async () => {
  const s = await startHub({ budget: { perTaskUsd: 0.5, dailyUsd: 100 } });
  const [t] = s.add([{ title: 'Expensive exploration', prompt: '@mock cost 0.3\n@mock cost 0.3\n@mock write x.js ok\n@mock sleep 2000', agent: 'mock' }]).created;
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'needs_human');
  assert.match(final!.attention!, /budget/);
});

test('a dependency failing blocks its dependents with an explanation instead of waiting forever', async () => {
  const s = await startHub({ retry: { maxAttempts: 1, backoffSeconds: 0 } });
  const { created } = s.add([
    { key: 'base', title: 'Create base schema', prompt: '@mock fail cannot connect', agent: 'mock' },
    { title: 'Seed data on top of the schema', prompt: '@mock write seed.js x', after: ['base'], agent: 'mock' },
  ]);
  const [base, seed] = await s.settle(created.map((t) => t.id));
  assert.equal(base!.status, 'failed');
  assert.equal(seed!.status, 'needs_human');
  assert.match(seed!.attention!, /depends on/);
});

test('approval mode holds verified work until a person approves it', async () => {
  const s = await startHub({}, { integration: { requireApproval: true } });
  const [t] = s.add([{ title: 'Change the logo text', prompt: '@mock write logo.txt NEW', agent: 'mock' }]).created;
  const ready = await until(() => s.get(t!.id), (x) => x.status === 'ready', 20_000, 'ready');
  assert.match(ready.attention!, /approval/);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.get(t!.id).status, 'ready', 'not merged without approval');
  s.hub.coord.control(t!.id, 'approve', 'test');
  const done = await until(() => s.get(t!.id), (x: Task) => x.status === 'done', 20_000, 'done');
  assert.equal(done.status, 'done');
});

test('cleanup never deletes unmerged or user-owned work', async () => {
  const s = await startHub();
  const { created } = s.add([
    { title: 'Merged work item', prompt: '@mock write m.txt merged', agent: 'mock' },
    { title: 'Long running experiment', prompt: '@mock write exp.txt experimental\n@mock sleep 60000', agent: 'mock' },
  ]);
  const [merged, exp] = created as [Task, Task];
  await until(() => s.get(merged.id), (t) => t.status === 'done', 20_000, 'merged');
  await until(() => s.get(exp.id), (t) => t.status === 'running' && !!t.worktree, 20_000, 'experiment running');
  await until(() => existsSync(join(s.get(exp.id).worktree!, 'exp.txt')), (v) => v, 10_000, 'experiment wrote a file');
  s.hub.coord.control(exp.id, 'cancel', 'test');
  await until(() => s.hub.coord.latestRun(exp.id)!, (r) => r.status !== 'running', 15_000, 'experiment stopped');

  // A worktree the user made by hand, and a branch with a yardmaster-looking name nobody knows about.
  const userWt = join(s.root, 'my-own-worktree');
  sh(s.repo, 'git', ['worktree', 'add', '-q', '-b', 'feature/mine', userWt]);
  writeFileSync(join(userWt, 'wip.txt'), 'uncommitted user work');
  sh(s.repo, 'git', ['branch', 'yardmaster/t-unknown']);

  const plan = await planCleanup(s.hub.coord, s.project.id);
  const removed = plan.remove.map((i) => i.target);
  assert.ok(!removed.some((t) => t.includes('my-own-worktree')), 'user worktree is not a candidate');
  assert.ok(!removed.includes('feature/mine'));
  assert.ok(!removed.includes('yardmaster/t-unknown'), 'unknown branches are kept');
  const keptExp = plan.keep.find((i) => i.target.endsWith(exp.id) || i.target === `yardmaster/${exp.id}`);
  assert.ok(keptExp, `canceled task with unmerged commits is kept: ${JSON.stringify(plan, null, 1)}`);
  await runCleanup(s.hub.coord, plan);
  assert.ok(existsSync(join(userWt, 'wip.txt')));
  assert.equal(readFileSync(join(userWt, 'wip.txt'), 'utf8'), 'uncommitted user work');
  assert.ok(sh(s.repo, 'git', ['branch', '--list', `yardmaster/${exp.id}`]).length > 0, 'unmerged branch survives');
});

test('merging works on a machine where git has no name or email configured', async () => {
  const prev = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
  // Simulate a fresh machine: no identity anywhere, and git not allowed to guess one from the hostname
  // (macOS git guesses, Linux git usually can't; useConfigOnly makes every OS behave like the strict case).
  const gitconfig = join(tempDir('ym-gitcfg-'), 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tuseConfigOnly = true\n');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    const s = await startHub();
    sh(s.repo, 'git', ['config', '--unset', 'user.name']);
    sh(s.repo, 'git', ['config', '--unset', 'user.email']);
    const { created } = s.add([
      { title: 'Add the first page', prompt: '@mock write one.js 1', agent: 'mock' },
      { title: 'Add the second page', prompt: '@mock write two.js 2', agent: 'mock' },
    ]);
    const final = await s.settle(created.map((t) => t.id));
    assert.deepEqual(final.map((t) => t.status), ['done', 'done'], JSON.stringify(final.map((t) => t.attention)));
    assert.equal(fileOnIntegration(s.repo, 'two.js'), '2');
  } finally {
    if (prev.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev.g;
    if (prev.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prev.n;
  }
});

test('a second hub on the same home is refused before it touches anything, and the first keeps its agents', async () => {
  const s = await startHub();
  const { created } = s.add([{ title: 'Long task', prompt: '@mock sleep 60000', agent: 'mock' }]);
  const running = await until(() => s.get(created[0]!.id), (t) => t.status === 'running', 20_000, 'task to start');
  // The run row (and its pid) can land a moment after the task flips to running.
  const run = await until(() => s.hub.coord.latestRun(running.id), (r) => !!r?.pid, 10_000, 'agent pid');
  const pid = run!.pid!;
  const second = new Hub({ db: openDb(join(s.home, 'y.db')), token: 'test-token', machineId: s.hub.machineId, port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  await assert.rejects(second.start(), /already running/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(s.get(running.id).status, 'running', 'the first hub\'s task was not recovered');
  assert.equal(s.hub.coord.latestRun(running.id)!.id, run!.id, 'no new run was started');
  assert.ok(isAlive(pid), 'the agent is still alive');
  s.hub.coord.updateTask(running.id, { control: 'cancel' });
});

test('a worker can still report a failed upload on a task it owns that is already ready, but not after losing it', async () => {
  const s = await startHub();
  const { created } = s.add([{ title: 'Owned task', prompt: '@mock write x.txt x', agent: 'mock' }]);
  const id = created[0]!.id;
  s.hub.coord.updateTask(id, { status: 'ready', assignee: 'machine:m-laptop', attempts: 1 });
  const owner = { attempt: 1, assignee: 'machine:m-laptop' };
  assert.throws(() => s.hub.coord.updateTaskIfOwner(id, owner, { attention: 'x' }), /stale|superseded|no longer/i);
  assert.equal(s.hub.coord.updateTaskIfOwner(id, { ...owner, statuses: ['running', 'verifying', 'ready'] }, { status: 'needs_human', attention: 'upload failed' }).status, 'needs_human');
  s.hub.coord.updateTask(id, { status: 'running', assignee: 'machine:other', attempts: 2 });
  assert.throws(() => s.hub.coord.updateTaskIfOwner(id, { ...owner, statuses: ['running', 'verifying', 'ready'] }, { status: 'needs_human' }));
});
