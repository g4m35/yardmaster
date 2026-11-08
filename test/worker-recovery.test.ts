import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { WorkerJournal } from '../src/worker-journal.ts';
import { WorkerLoop, type BranchTransport } from '../src/worker.ts';
import { Semaphore } from '../src/runner.ts';
import { Integrator } from '../src/integrator.ts';
import { loadConfig } from '../src/config.ts';
import { groupAlive, processStartTime, terminateOwnedGroup } from '../src/proc.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture() {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' }, cleanup: { auto: false, deleteMergedBranches: false } });
  const coord = new Coordinator(openDb(join(box.home, 'recovery.db')));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  const task = coord.addTasks(project.id, [{ title: 'Recover remote work safely', prompt: '@mock write result.txt correct', agent: 'mock' }], 'test').created[0]!;
  const claimed = coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  const owner = { generation: claimed.generation, assignee: claimed.assignee! };
  const worker = (transport: BranchTransport, api = client) => new WorkerLoop({ client: api, machineId: 'm-worker', repos: () => ({ [project.id]: box.repo }), agents: () => ['mock'], localConfig: () => loadConfig(), verifySlots: new Semaphore(1), transport });
  return { ...box, coord, project, client, task: claimed, owner, worker };
}
const noopTransport: BranchTransport = { async fetchBase() {}, async uploadBranch(task) { return { head: task.head_sha! }; } };

async function sleeper() {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  return child;
}

test('remote restart reaps recorded TERM-resistant orphan before its first claim and clears run hold', async () => {
  const s = await fixture();
  const child = await sleeper();
  try {
    const journal = new WorkerJournal('m-worker');
    const api = journal.wrap(s.client);
    const runId = await api['run.start']({ taskId: s.task.id, machineId: 'm-worker', agent: 'mock', logPath: '', owner: s.owner });
    const startedAt = await processStartTime(child.pid!);
    await api['run.update']({ runId, owner: s.owner, patch: { phase: 'agent', pid: child.pid, proc_started: startedAt } });
    s.coord.updateRun(runId, { status: 'cleanup_failed' });
    let claims = 0;
    const client = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'worker.claim') return async () => { claims++; assert.equal(groupAlive(child.pid!), false); assert.equal(s.coord.getRun(runId)!.status, 'stopped'); return null; };
      return target[key];
    } });
    await s.worker(noopTransport, client).tick();
    assert.equal(claims, 1);
    assert.equal(groupAlive(child.pid!), false);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
  } finally { await terminateOwnedGroup(child.pid!, { graceMs: 5 }); s.coord.db.close(); }
});

for (const identity of ['unknown', 'recycled']) test(`${identity} process identity is held locally, never killed or offered in a new claim`, async () => {
  const s = await fixture();
  const child = await sleeper();
  try {
    const journal = new WorkerJournal('m-worker');
    journal.runs['r-unknown'] = { runId: 'r-unknown', taskId: s.task.id, owner: s.owner, worktree: null, pid: child.pid!, startedAt: identity === 'unknown' ? null : (await processStartTime(child.pid!))! - 60_000 };
    journal.save();
    let excluded: string[] = [];
    const client = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'worker.claim') return async (params: Parameters<Client['worker.claim']>[0]) => { excluded = params.activeTaskIds ?? []; return null; };
      return target[key];
    } });
    await s.worker(noopTransport, client).tick();
    assert.ok(excluded.includes(s.task.id));
    assert.equal(groupAlive(child.pid!), true);
    assert.ok(new WorkerJournal('m-worker').runs['r-unknown']);
  } finally { await terminateOwnedGroup(child.pid!, { graceMs: 5 }); s.coord.db.close(); }
});

test('journal writes PID before registration RPC and retains spawning uncertainty', async () => {
  const s = await fixture();
  try {
    let runId = '';
    const journal = new WorkerJournal('m-worker');
    const client = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'run.update') return async (p: Parameters<Client['run.update']>[0]) => {
        assert.equal(new WorkerJournal('m-worker').runs[p.runId]!.pid, 456789);
        throw new Error('offline');
      };
      return target[key];
    } });
    const api = journal.wrap(client);
    runId = await api['run.start']({ taskId: s.task.id, machineId: 'm-worker', agent: 'mock', logPath: '', owner: s.owner });
    await assert.rejects(api['run.update']({ runId, owner: s.owner, patch: { pid: 456789, proc_started: Date.now() } }), /offline/);
    const restart = new WorkerJournal('m-worker');
    restart.runs[runId]!.pid = null; restart.runs[runId]!.phase = 'agent:spawning'; restart.save();
    assert.ok((await restart.recover(s.client)).has(s.task.id));
    const file = join(s.home, sh(s.home, 'ls', []).split('\n').find(n => n.startsWith('worker-'))!);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { s.coord.db.close(); }
});

test('final sequenced usage survives restart and replays exactly once before exit acknowledgment', async () => {
  const s = await fixture();
  try {
    const journal = new WorkerJournal('m-worker');
    let fail = true;
    const client = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'run.usage') return async (p: Parameters<Client['run.usage']>[0]) => { if (fail) throw new Error('network'); return target[key](p); };
      return target[key];
    } });
    const api = journal.wrap(client);
    const runId = await api['run.start']({ taskId: s.task.id, machineId: 'm-worker', agent: 'mock', logPath: '', owner: s.owner });
    const usage = { costUsd: 0.5, tokensIn: 100, tokensOut: 20, provenance: 'actual' as const, cacheReadTokens: 10, cacheWriteTokens: null };
    await api['run.usage']({ runId, taskId: s.task.id, owner: s.owner, sequence: 1, usage: { ...usage, costUsd: 0.2 } });
    await api['run.usage']({ runId, taskId: s.task.id, owner: s.owner, sequence: 2, usage });
    await assert.rejects(api['run.exit']({ runId, taskId: s.task.id, owner: s.owner, reaped: true }), /network/);
    fail = false;
    assert.equal((await new WorkerJournal('m-worker').recover(s.client)).size, 0);
    await s.client['run.usage']({ runId, taskId: s.task.id, owner: s.owner, sequence: 2, usage });
    assert.equal(s.coord.getTask(s.task.id)!.cost_usd, 0.5);
    assert.equal(s.coord.getRun(runId)!.usage_seq, 2);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
  } finally { s.coord.db.close(); }
});

async function readyArtifact(s: Awaited<ReturnType<typeof fixture>>) {
  const base = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
  const path = join(s.root, 'worktrees', `repo-${s.project.id.slice(2, 8)}`, s.task.id);
  mkdirSync(join(path, '..'), { recursive: true });
  sh(s.repo, 'git', ['worktree', 'add', '-qb', s.task.branch!, path, base]);
  writeFileSync(join(path, 'result.txt'), 'accepted');
  sh(path, 'git', ['add', '-A']); sh(path, 'git', ['commit', '-qm', 'accepted']);
  const head = sh(path, 'git', ['rev-parse', 'HEAD']);
  const journal = new WorkerJournal('m-worker');
  const api = journal.wrap(s.client, { repo: s.repo, branch: s.task.branch!, base });
  await api['task.update']({ id: s.task.id, owner: s.owner, patch: { status: 'ready', head_sha: head, base_sha: base, worktree: path, ready_at: Date.now(), lease_until: null } });
  return { path, head, base };
}

test('ready artifact is durable before ready RPC; transient upload retries across restart without rerunning agent', async () => {
  const s = await fixture();
  try {
    const { head } = await readyArtifact(s);
    let calls = 0;
    const transport: BranchTransport = { async fetchBase() {}, async uploadBranch(task) { calls++; assert.equal(task.head_sha, head); if (calls === 1) throw new Error('temporary network failure'); return { head }; } };
    await s.worker(transport).recoverLocal();
    assert.equal(s.coord.getTask(s.task.id)!.status, 'ready');
    const saved = new WorkerJournal('m-worker');
    assert.equal(saved.artifacts[s.task.id]!.failures, 1);
    saved.artifacts[s.task.id]!.retryAt = 0; saved.save();
    await s.worker(transport).recoverLocal();
    assert.equal(calls, 2);
    assert.equal(new WorkerJournal('m-worker').artifacts[s.task.id]!.uploaded, true);
    assert.equal(s.coord.runsFor(s.task.id).length, 0);
  } finally { s.coord.db.close(); }
});

test('canceling during upload aborts within heartbeat while another claim still renews', async () => {
  const s = await fixture();
  try {
    await readyArtifact(s);
    const second = s.coord.addTasks(s.project.id, [{ title: 'Unrelated current task', prompt: '@mock write other.txt correct', agent: 'mock' }], 'test').created[0]!;
    const claim = s.coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {}, activeTaskIds: [s.task.id] })!.task;
    assert.equal(claim.id, second.id);
    let signal: AbortSignal | undefined;
    const worker = s.worker({ async fetchBase() {}, async uploadBranch(_task, _repo, _branch, _base, incoming) { signal = incoming; await new Promise((_resolve, reject) => incoming!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return { head: '' }; } });
    worker.active.set(second.id, { task: claim, agent: 'mock' });
    const recovering = worker.recoverLocal();
    await until(() => !!signal, Boolean);
    s.coord.control(s.task.id, 'cancel', 'test');
    await worker.heartbeat();
    await recovering;
    assert.equal(signal!.aborted, true);
    assert.ok(s.coord.getTask(second.id)!.lease_until! > Date.now());
  } finally { s.coord.db.close(); }
});

for (const newCommit of [false, true]) test(`real single merge cleanup ${newCommit ? 'preserves later local commit' : 'removes accepted worker artifact'}`, async () => {
  const s = await fixture();
  const integrator = new Integrator(s.coord, new Semaphore(1));
  try {
    const { head, path } = await readyArtifact(s);
    assert.equal(await integrator.step(s.project.id), true);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'done');
    assert.notEqual(s.coord.getTask(s.task.id)!.head_sha, head, 'real single merge records a merge commit');
    assert.equal(existsSync(path), true, 'remote artifact exists before worker tidy');
    if (newCommit) {
      writeFileSync(join(path, 'later.txt'), 'preserve');
      sh(path, 'git', ['add', '-A']); sh(path, 'git', ['commit', '-qm', 'later local work']);
    }
    await s.worker(noopTransport).tidyLocal();
    assert.equal(existsSync(path), newCommit);
  } finally { await integrator.stop(); s.coord.db.close(); }
});

test('upload retry budget is bounded and never invokes a new agent', async () => {
  const s = await fixture();
  try {
    await readyArtifact(s);
    let calls = 0;
    const transport: BranchTransport = { async fetchBase() {}, async uploadBranch() { calls++; throw new Error('offline'); } };
    for (let i = 0; i < 7; i++) {
      const journal = new WorkerJournal('m-worker'); journal.artifacts[s.task.id]!.retryAt = 0; journal.save();
      await s.worker(transport).recoverLocal();
    }
    assert.equal(calls, 6);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'needs_human');
    assert.equal(s.coord.runsFor(s.task.id).length, 0);
  } finally { s.coord.db.close(); }
});

test('replacement generation retires stale pending upload without blocking a later claim', async () => {
  const s = await fixture();
  try {
    await readyArtifact(s);
    s.coord.control(s.task.id, 'cancel', 'test');
    s.coord.control(s.task.id, 'retry', 'test');
    const replacement = s.coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!.task;
    assert.ok(replacement.generation > s.task.generation);
    let calls = 0;
    await s.worker({ async fetchBase() {}, async uploadBranch() { calls++; throw new Error('must not upload canceled branch'); } }).recoverLocal();
    assert.equal(calls, 0);
    assert.equal(new WorkerJournal('m-worker').artifacts[s.task.id]!.retired, true);
  } finally { s.coord.db.close(); }
});

test('real remote mock attempt journals and uploads its ready artifact', async () => {
  const s = await fixture();
  try {
    // Return the preexisting claim once, so the real runner traverses every journal wrapper.
    const original = await s.client['task.get']({ id: s.task.id });
    let claimed = false;
    const client = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'worker.claim') return async () => {
        if (claimed) return null; claimed = true;
        return { task: original.task, project: s.project, config: loadConfig(), route: { agent: 'mock', model: null }, startPoint: sh(s.repo, 'git', ['rev-parse', 'HEAD']) };
      };
      return target[key];
    } });
    let uploads = 0;
    const worker = s.worker({ async fetchBase() {}, async uploadBranch(task) { uploads++; assert.equal(new WorkerJournal('m-worker').artifacts[task.id]!.head, task.head_sha); return { head: task.head_sha! }; } }, client);
    await worker.tick();
    await until(() => uploads, value => value === 1);
    await worker.drain();
    assert.equal(s.coord.getTask(s.task.id)!.status, 'ready');
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
  } finally { s.coord.db.close(); }
});

test('explicit owner attestation retires the matching spawning intent while task status alone cannot', async () => {
  const s = await fixture();
  try {
    const journal = new WorkerJournal('m-worker');
    const api = journal.wrap(s.client);
    const runId = await api['run.start']({ taskId: s.task.id, machineId: 'm-worker', agent: 'mock', logPath: '', owner: s.owner });
    await api['run.update']({ runId, owner: s.owner, patch: { phase: 'agent:spawning' } });
    s.coord.updateRun(runId, { status: 'stopped', pid: null, stop_reason: 'ordinary stop' });
    assert.ok((await new WorkerJournal('m-worker').recover(s.client)).has(s.task.id));
    s.coord.updateRun(runId, { stop_reason: 'Owner you attested stopped: manually inspected process table' });
    assert.equal((await new WorkerJournal('m-worker').recover(s.client)).size, 0);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
  } finally { s.coord.db.close(); }
});
