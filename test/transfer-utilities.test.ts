import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { WorkerJournal } from '../src/worker-journal.ts';
import { WorkerLoop, type BranchTransport } from '../src/worker.ts';
import { Semaphore } from '../src/runner.ts';
import { loadConfig } from '../src/config.ts';
import { currentProcessScopeSignal, groupAlive, processStartTime, terminateOwnedGroup } from '../src/proc.ts';
import { httpTransport } from '../src/transport.ts';
import { recordUtility, runUtilityKey, utilities } from '../src/utility-records.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture(ready = true) {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' }, cleanup: { auto: false } });
  const coord = new Coordinator(openDb(join(box.home, 'transfer.db')));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  coord.addTasks(project.id, [{ title: 'Transfer owned artifact', prompt: '@mock write result.txt correct', agent: 'mock' }], 'test');
  const task = coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  const owner = { generation: task.generation, assignee: task.assignee! };
  const base = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  let runId = '';
  if (ready) {
    sh(box.repo, 'git', ['branch', task.branch!, base]);
    const journal = new WorkerJournal('m-worker');
    const api = journal.wrap(client, { repo: box.repo, branch: task.branch!, base });
    runId = await api['run.start']({ taskId: task.id, machineId: 'm-worker', agent: 'mock', logPath: '', owner });
    await api['run.update']({ runId, owner, patch: { status: 'done', phase: 'prepare', pid: null } });
    await api['run.exit']({ runId, taskId: task.id, owner, reaped: true, noLaunchPhase: 'prepare' });
    await api['task.update']({ id: task.id, owner, patch: { status: 'ready', head_sha: base, base_sha: base, lease_until: null } });
  }
  const worker = (transport: BranchTransport, api = client) => new WorkerLoop({ client: api, machineId: 'm-worker', repos: () => ({ [project.id]: box.repo }), agents: () => ['mock'], localConfig: () => loadConfig(), verifySlots: new Semaphore(1), transport });
  return { ...box, coord, project, client, task, owner, base, runId, worker };
}

test('upload bundle orphan is reaped from its journal before retry without another model run', async () => {
  const s = await fixture();
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  try {
    const startedAt = await processStartTime(child.pid!);
    const journal = new WorkerJournal('m-worker');
    journal.runs[s.runId] = { runId: s.runId, taskId: s.task.id, owner: s.owner, worktree: null, pid: null, startedAt: null, phase: 'upload', idlePhase: 'upload', utilities: [{ token: 'orphan-bundle', command: 'git', state: 'live', pid: child.pid!, startedAt }] };
    journal.save();
    recordUtility(s.coord.db, runUtilityKey(s.runId), { action: 'intent', token: 'orphan-bundle', command: 'git' });
    recordUtility(s.coord.db, runUtilityKey(s.runId), { action: 'spawn', token: 'orphan-bundle', pid: child.pid!, startedAt });
    let uploads = 0;
    await s.worker({ async fetchBase() {}, async uploadBranch(task) { uploads++; assert.equal(groupAlive(child.pid!), false); return { head: task.head_sha! }; } }).recoverLocal();
    assert.equal(uploads, 1);
    assert.equal(groupAlive(child.pid!), false);
    assert.equal(new WorkerJournal('m-worker').artifacts[s.task.id]!.uploaded, true);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
    assert.deepEqual(utilities(s.coord.db, runUtilityKey(s.runId)), []);
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { await terminateOwnedGroup(child.pid!, { graceMs: 5 }); s.coord.db.close(); }
});

test('bundle spawn intent with unknown identity holds upload and excludes a new model claim', async () => {
  const s = await fixture();
  try {
    const journal = new WorkerJournal('m-worker');
    journal.runs[s.runId] = { runId: s.runId, taskId: s.task.id, owner: s.owner, worktree: null, pid: null, startedAt: null, phase: 'upload', idlePhase: 'upload', utilities: [{ token: 'unknown-bundle', command: 'git', state: 'spawning', pid: null, startedAt: null }] };
    journal.save();
    recordUtility(s.coord.db, runUtilityKey(s.runId), { action: 'intent', token: 'unknown-bundle', command: 'git' });
    let excluded: string[] = [];
    let uploads = 0;
    const api = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'worker.claim') return async (p: Parameters<Client['worker.claim']>[0]) => { excluded = p.activeTaskIds ?? []; return null; };
      return target[key];
    } });
    await s.worker({ async fetchBase() {}, async uploadBranch() { uploads++; throw new Error('must remain held'); } }, api).tick();
    assert.ok(excluded.includes(s.task.id));
    assert.equal(uploads, 0);
    assert.equal(s.coord.getTask(s.task.id)!.status, 'ready');
    assert.equal(new WorkerJournal('m-worker').runs[s.runId]!.utilities![0]!.state, 'spawning');
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { s.coord.db.close(); }
});

test('canceling a hung git bundle reaps the registered utility and preserves an unrelated claim', async () => {
  const s = await fixture();
  const oldPath = process.env.PATH;
  let pid = 0;
  try {
    const second = s.coord.addTasks(s.project.id, [{ title: 'Keep sibling claim alive', prompt: '@mock write other.txt correct', agent: 'mock' }], 'test').created[0]!;
    const claim = s.coord.claimNext({ machineId: 'm-worker', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {}, activeTaskIds: [s.task.id] })!.task;
    assert.equal(claim.id, second.id);
    const realGit = sh(s.repo, 'which', ['git']);
    const bin = join(s.root, 'bin'); mkdirSync(bin);
    const marker = join(s.root, 'bundle.pid');
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!${process.execPath}\nimport { execFileSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'bundle') { process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); } else { try { execFileSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }); } catch (err) { process.exit(err.status ?? 1); } }\n`);
    chmodSync(wrapper, 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    let registered = 0;
    const api = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'run.utility') return async (p: Parameters<Client['run.utility']>[0]) => {
        const token = new WorkerJournal('m-worker').runs[p.runId]!.utilities!.find(child => child.token === p.operation.token)!;
        assert.ok(token, 'journal must persist the token before any RPC');
        if (p.operation.action === 'intent') assert.equal(token.state, 'spawning');
        if (p.operation.action === 'spawn') { registered++; assert.equal(token.pid, p.operation.pid); }
        return target[key](p);
      };
      return target[key];
    } });
    const worker = s.worker(httpTransport('http://127.0.0.1:1', 'test', 'm-worker'), api);
    worker.active.set(second.id, { task: claim, agent: 'mock' });
    const pending = worker.recoverLocal();
    await until(() => existsSync(marker), Boolean);
    pid = Number(readFileSync(marker, 'utf8'));
    await until(() => Object.values(new WorkerJournal('m-worker').runs).some(run => run.utilities?.some(child => child.pid === pid)), Boolean);
    s.coord.control(s.task.id, 'cancel', 'test');
    await worker.heartbeat();
    await pending;
    assert.equal(groupAlive(pid), false);
    assert.ok(registered >= 2, 'branch check and git bundle both register their own utility');
    assert.ok(s.coord.getTask(second.id)!.lease_until! > Date.now());
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
    assert.equal(new WorkerJournal('m-worker').artifacts[s.task.id]!.failures, 0);
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { process.env.PATH = oldPath; if (pid) await terminateOwnedGroup(pid, { graceMs: 5 }); s.coord.db.close(); }
});

test('base fetch starts after durable run registration and stops with the preparing attempt', async () => {
  const s = await fixture(false);
  try {
    let claimed = false;
    let signal: AbortSignal | undefined;
    let rowId = '';
    const api = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'worker.claim') return async () => {
        if (claimed) return null; claimed = true;
        return { task: s.task, project: s.project, config: loadConfig(), route: { agent: 'mock', model: null }, startPoint: 'a'.repeat(40) };
      };
      return target[key];
    } });
    const worker = s.worker({ async fetchBase(_project, _repo, _sha, incoming) {
      signal = incoming;
      assert.ok(currentProcessScopeSignal());
      const runs = Object.values(new WorkerJournal('m-worker').runs);
      assert.equal(runs.length, 1);
      rowId = runs[0]!.runId;
      assert.ok(s.coord.getRun(rowId));
      assert.ok(runs[0]!.utilities?.some(child => child.command === 'git' && child.state === 'exited'));
      await new Promise<void>((_resolve, reject) => incoming!.addEventListener('abort', () => reject(new Error('base fetch stopped')), { once: true }));
    }, async uploadBranch() { throw new Error('must not upload'); } }, api);
    await worker.tick();
    await until(() => !!signal, Boolean);
    worker.stopAll('shutdown', 'test shutdown');
    await worker.drain();
    assert.equal(signal!.aborted, true);
    assert.equal(worker.active.size, 0);
    assert.ok(rowId);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { s.coord.db.close(); }
});

test('base HTTP body streaming is canceled by the supplied signal', async () => {
  const s = await fixture(false);
  const server = createServer((_request, response) => { response.writeHead(200); response.write('incomplete bundle'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const abort = new AbortController();
    const pending = httpTransport(`http://127.0.0.1:${address.port}`, 'test', 'm-worker').fetchBase(s.project, s.repo, s.base, abort.signal);
    await new Promise<void>(resolve => server.once('request', () => resolve()));
    abort.abort('cancel base fetch');
    await assert.rejects(pending, /cancel base fetch|aborted/i);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); s.coord.db.close(); }
});

test('upload journal survives a lost final exit acknowledgment and retries only its accepted artifact', async () => {
  const s = await fixture();
  try {
    let offline = true;
    let uploads = 0;
    const api = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'run.exit') return async (p: Parameters<Client['run.exit']>[0]) => { if (offline) throw new Error('exit acknowledgment unavailable'); return target[key](p); };
      return target[key];
    } });
    const transport: BranchTransport = { async fetchBase() {}, async uploadBranch(task) { uploads++; assert.equal(task.head_sha, s.base); return { head: task.head_sha! }; } };
    await s.worker(transport, api).recoverLocal();
    const interrupted = new WorkerJournal('m-worker');
    assert.equal(uploads, 1);
    assert.ok(interrupted.runs[s.runId]!.exit);
    assert.ok(interrupted.runs[s.runId]!.utilities!.every(child => child.state === 'exited'));
    assert.equal(interrupted.artifacts[s.task.id]!.uploaded, false);
    interrupted.artifacts[s.task.id]!.retryAt = 0; interrupted.save();
    offline = false;
    await s.worker(transport, api).recoverLocal();
    assert.equal(uploads, 2);
    assert.deepEqual(new WorkerJournal('m-worker').runs, {});
    assert.equal(new WorkerJournal('m-worker').artifacts[s.task.id]!.uploaded, true);
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { s.coord.db.close(); }
});

for (const state of ['missing', 'running'] as const) test(`${state} implementation row cannot authorize local upload utilities`, async () => {
  const s = await fixture();
  try {
    let utilityCalls = 0;
    const api = new Proxy(s.client, { get(target, key: keyof Client) {
      if (key === 'task.get') return async (p: Parameters<Client['task.get']>[0]) => {
        const detail = await target[key](p);
        return { ...detail, runs: state === 'missing' ? [] : detail.runs.map(run => ({ ...run, status: 'running' })) };
      };
      if (key === 'run.utility') return async () => { utilityCalls++; throw new Error('must not spawn'); };
      return target[key];
    } });
    await s.worker({ async fetchBase() {}, async uploadBranch() { throw new Error('must not upload'); } }, api).recoverLocal();
    const saved = new WorkerJournal('m-worker');
    assert.match(saved.artifacts[s.task.id]!.error!, /no stopped implementation process/);
    assert.equal(saved.artifacts[s.task.id]!.failures, 1);
    assert.equal(utilityCalls, 0);
    assert.deepEqual(saved.runs, {});
    assert.equal(s.coord.runsFor(s.task.id).length, 1);
  } finally { s.coord.db.close(); }
});
