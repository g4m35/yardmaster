import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { fleetClient } from '../src/fleet-client.ts';
import { Hub } from '../src/hub.ts';
import { PairingStore, authorizeWorkerRpc } from '../src/pairing.ts';
import { groupAlive, processStartTime, terminateOwnedGroup, terminateRecordedProcess } from '../src/proc.ts';
import { Semaphore } from '../src/runner.ts';
import { loadConfig } from '../src/config.ts';
import { httpTransport } from '../src/transport.ts';
import { WorkerJournal, type JournalArtifact, type JournalRun } from '../src/worker-journal.ts';
import { WorkerLoop } from '../src/worker.ts';
import { sandbox, sh, until } from './helpers.ts';

const machineId = 'm-shared-worker';
const hubUrl = 'http://fixture.local';
const owner = { generation: 1, assignee: `machine:${machineId}` };
const pendingRun = (suffix: string): JournalRun => ({ runId: `r-${suffix}`, taskId: `t-${suffix}`, owner, worktree: null, pid: null, startedAt: null, phase: 'prepare', idlePhase: 'prepare',
  usage: { runId: `r-${suffix}`, taskId: `t-${suffix}`, owner, sequence: 1, usage: { costUsd: 0.1, tokensIn: 10, tokensOut: 1, provenance: 'actual', cacheReadTokens: null, cacheWriteTokens: null } } });
const pendingArtifact = (suffix: string): JournalArtifact => ({ taskId: `t-${suffix}`, generation: 1, assignee: owner.assignee, repo: `/fixture/${suffix}`, branch: `yardmaster/t-${suffix}`, base: 'a'.repeat(40), head: 'b'.repeat(40), uploaded: false, failures: 1, retryAt: 0 });

function secondRepo(root: string): string {
  const repo = join(root, 'second-repo');
  mkdirSync(repo);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.name', 'Test User']);
  sh(repo, 'git', ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'README.md'), '# second generated fixture\n');
  writeFileSync(join(repo, 'yardmaster.json'), JSON.stringify({ verify: ['node -e "process.exit(0)"'] }));
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);
  return repo;
}

async function fixture() {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null }, cleanup: { auto: false } });
  const coord = new Coordinator(openDb(join(box.home, 'channels.db')));
  const projects = [await coord.registerProject(box.repo), await coord.registerProject(secondRepo(box.root))];
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  const journals: WorkerJournal[] = [];
  const journal = (projectIds = [projects[0]!.id], hub = hubUrl) => {
    const value = new WorkerJournal(machineId, { hub, projectIds }); journals.push(value); return value;
  };
  return { ...box, coord, projects, client, journal, close() { for (const value of journals) value.release(); coord.db.close(); rmSync(box.root, { recursive: true, force: true }); } };
}

test('canonical hub and project set share one exclusive writer and reload after handoff', async () => {
  const f = await fixture();
  try {
    const ids = f.projects.map(project => project.id);
    const first = f.journal(ids, 'HTTP://LOCALHOST:80/');
    const constructedBeforeWrite = f.journal([ids[1]!, ids[0]!, ids[1]!], 'http://localhost');
    await first.acquire();
    await assert.rejects(constructedBeforeWrite.acquire(), /already has a live writer/);
    const run = pendingRun('canonical'); const artifact = pendingArtifact('canonical');
    first.runs[run.runId] = run; first.artifacts[artifact.taskId] = artifact; first.save(); first.release();
    await constructedBeforeWrite.acquire();
    assert.deepEqual(constructedBeforeWrite.runs, { [run.runId]: run }, 'acquisition reloads writes made after construction');
    assert.deepEqual(constructedBeforeWrite.artifacts, { [artifact.taskId]: artifact });
    const next = pendingRun('next');
    constructedBeforeWrite.runs[next.runId] = next; constructedBeforeWrite.save(); constructedBeforeWrite.release();
    const restart = f.journal(ids, 'http://localhost/');
    await restart.acquire();
    assert.deepEqual(Object.keys(restart.runs).sort(), [run.runId, next.runId].sort());
    assert.throws(() => first.save(), /exclusive channel writer/);
    assert.throws(() => restart.assertScope([ids[0]!]), /Restart the worker/);
  } finally { f.close(); }
});

test('same-machine distinct project and distinct hub channels retain independent pending state', async () => {
  const f = await fixture();
  try {
    const channels = [
      { projectIds: [f.projects[0]!.id], hub: hubUrl },
      { projectIds: [f.projects[1]!.id], hub: hubUrl },
      { projectIds: [f.projects[0]!.id], hub: 'http://other-fixture.local' },
    ];
    const writers = channels.map(channel => f.journal(channel.projectIds, channel.hub));
    await Promise.all(writers.map(writer => writer.acquire()));
    for (const [index, writer] of writers.entries()) {
      const run = pendingRun(`channel${index}`); const artifact = pendingArtifact(`channel${index}`);
      writer.runs[run.runId] = run; writer.artifacts[artifact.taskId] = artifact; writer.save();
    }
    for (const writer of writers) writer.release();
    for (const [index, channel] of channels.entries()) {
      const restart = f.journal(channel.projectIds, channel.hub); await restart.acquire();
      const run = pendingRun(`channel${index}`); const artifact = pendingArtifact(`channel${index}`);
      assert.deepEqual(restart.runs, { [run.runId]: run });
      assert.deepEqual(restart.artifacts, { [artifact.taskId]: artifact });
      assert.equal(restart.artifacts[artifact.taskId]!.uploaded, false);
    }
  } finally { f.close(); }
});

test('two project journals replay only their own pending usage after restart', async () => {
  const f = await fixture();
  try {
    const saved = [];
    const offline = new Proxy(f.client, { get(target, key: keyof Client) {
      if (key === 'run.usage') return async () => { throw new Error('fixture disconnected'); };
      return target[key];
    } });
    for (const [index, project] of f.projects.entries()) {
      const task = f.coord.addTasks(project.id, [{ title: `Channel ${index} usage`, agent: 'mock' }], 'test').created[0]!;
      const claim = f.coord.claimNext({ machineId, agents: ['mock'], repos: { [project.id]: project.root }, runningByAgent: {} })!.task;
      assert.equal(claim.id, task.id);
      const own = { generation: claim.generation, assignee: claim.assignee! };
      const journal = f.journal([project.id]); const api = journal.wrap(offline);
      const runId = await api['run.start']({ taskId: claim.id, machineId, agent: 'mock', logPath: '', owner: own });
      await api['run.usage']({ runId, taskId: claim.id, owner: own, sequence: 1, usage: { costUsd: index + 0.25, tokensIn: 100, tokensOut: 10, provenance: 'actual', cacheReadTokens: null, cacheWriteTokens: null } });
      await assert.rejects(api['run.exit']({ runId, taskId: claim.id, owner: own, reaped: true }), /disconnected/);
      saved.push({ project, claim, runId }); journal.release();
    }
    const calls: string[] = [];
    const online = new Proxy(f.client, { get(target, key: keyof Client) {
      if (key === 'run.usage') return async (params: Parameters<Client['run.usage']>[0]) => { calls.push(params.taskId); return target[key](params); };
      return target[key];
    } });
    for (const [index, { project, claim, runId }] of saved.entries()) {
      const restart = f.journal([project.id]);
      assert.equal((await restart.recover(online)).size, 0);
      assert.deepEqual(restart.runs, {});
      assert.equal(f.coord.getTask(claim.id)!.cost_usd, index + 0.25);
      assert.equal(f.coord.getRun(runId)!.usage_seq, 1);
      assert.equal(f.coord.getRun(runId)!.status, 'stopped');
      assert.deepEqual(calls, saved.slice(0, index + 1).map(value => value.claim.id));
    }
  } finally { f.close(); }
});

test('restarted project channels replay only their own accepted pending upload', async () => {
  const f = await fixture(); const workers: WorkerLoop[] = [];
  try {
    const saved = [];
    for (const [index, project] of f.projects.entries()) {
      f.coord.addTasks(project.id, [{ title: `Channel ${index} accepted output`, agent: 'mock' }], 'test');
      const claim = f.coord.claimNext({ machineId, agents: ['mock'], repos: { [project.id]: project.root }, runningByAgent: {} })!.task;
      const base = sh(project.root, 'git', ['rev-parse', 'HEAD']);
      const worktree = join(f.root, 'worktrees', `${project.name}-${project.id.slice(2, 8)}`, claim.id);
      mkdirSync(join(worktree, '..'), { recursive: true });
      sh(project.root, 'git', ['worktree', 'add', '-qb', claim.branch!, worktree, base]);
      writeFileSync(join(worktree, 'result.txt'), `channel ${index}\n`);
      sh(worktree, 'git', ['add', '-A']); sh(worktree, 'git', ['commit', '-qm', 'accepted fixture output']);
      const head = sh(worktree, 'git', ['rev-parse', 'HEAD']);
      const own = { generation: claim.generation, assignee: claim.assignee! };
      const journal = f.journal([project.id]);
      const api = journal.wrap(f.client, { repo: project.root, branch: claim.branch!, base });
      const runId = await api['run.start']({ taskId: claim.id, machineId, agent: 'mock', logPath: '', owner: own });
      await api['run.update']({ runId, owner: own, patch: { status: 'succeeded', pid: null, phase: 'prepare' } });
      await api['run.exit']({ runId, taskId: claim.id, owner: own, reaped: true, noLaunchPhase: 'prepare' });
      await api['task.update']({ id: claim.id, owner: own, patch: { status: 'ready', head_sha: head, base_sha: base, worktree, ready_at: Date.now(), lease_until: null } });
      assert.equal(journal.artifacts[claim.id]!.uploaded, false); journal.release();
      saved.push({ project, claim, head });
    }
    const uploads: string[] = [];
    for (const [index, { project, claim, head }] of saved.entries()) {
      const worker = new WorkerLoop({ hub: hubUrl, client: f.client, machineId, repos: () => ({ [project.id]: project.root }), agents: () => ['mock'], localConfig: () => loadConfig(), verifySlots: new Semaphore(1), transport: {
        async fetchBase() { throw new Error('accepted commit already exists locally'); },
        async uploadBranch(task, repo, branch) {
          uploads.push(task.id);
          assert.equal(task.project_id, project.id); assert.equal(repo, project.root);
          assert.equal(sh(repo, 'git', ['rev-parse', branch]), head);
          return { head };
        },
      } });
      workers.push(worker); await worker.recoverLocal();
      assert.deepEqual(uploads, saved.slice(0, index + 1).map(value => value.claim.id));
      const snapshot = f.journal([project.id]);
      assert.equal(snapshot.artifacts[claim.id]!.uploaded, true);
      assert.deepEqual(snapshot.runs, {});
      assert.equal(f.coord.runsFor(claim.id).length, 1, 'upload replay never launches a coding attempt');
      if (index === 0) assert.equal(f.journal([saved[1]!.project.id]).artifacts[saved[1]!.claim.id]!.uploaded, false);
    }
  } finally {
    for (const worker of workers) worker.stopAll('shutdown', 'upload fixture finished');
    await Promise.all(workers.map(worker => worker.drain()));
    f.close();
  }
});

test('scope-denied recovery holds an exact known sleeper identity without signaling it', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data');
    const task = f.coord.addTasks(f.projects[0]!.id, [{ title: 'Owned sibling sleeper', agent: 'mock' }], 'test').created[0]!;
    const claim = f.coord.claimNext({ machineId, agents: ['mock'], repos: { [f.projects[0]!.id]: f.repo }, runningByAgent: {} })!.task;
    assert.equal(claim.id, task.id);
    const run = f.coord.startRun(claim, machineId, 'mock', null, '');
    const startedAt = await processStartTime(child.pid!); assert.ok(startedAt);
    f.coord.updateRun(run.id, { phase: 'agent', pid: child.pid!, proc_started: startedAt });
    const journal = f.journal([f.projects[1]!.id]); await journal.acquire();
    // A foreign/corrupt record must remain held even when it names a real owned process exactly.
    journal.runs[run.id] = { runId: run.id, taskId: claim.id, owner: { generation: claim.generation, assignee: claim.assignee! }, worktree: null, pid: child.pid!, startedAt, phase: 'agent' };
    journal.save();
    const store = new PairingStore(f.coord.db, { ownerId: 'personal' });
    const invitation = store.createInvitation({ kind: 'owner', ownerId: 'personal' }, { projectId: f.projects[1]!.id });
    const paired = store.redeemInvitation(invitation.code, machineId);
    let denied = 0;
    const scoped = new Proxy(f.client, { get(target, key: keyof Client) { return async (params: unknown) => {
      try { authorizeWorkerRpc(f.coord, paired.identity, key, params); } catch (error) { denied++; throw error; }
      return (target[key] as (params: unknown) => Promise<unknown>)(params);
    }; } });
    assert.deepEqual(await journal.recover(scoped), new Set([claim.id]));
    assert.equal(denied, 1);
    assert.equal(groupAlive(child.pid!), true);
    assert.equal(await processStartTime(child.pid!), startedAt);
    assert.equal(child.signalCode, null);
    assert.equal(journal.runs[run.id]!.pid, child.pid);
    assert.equal(f.coord.getRun(run.id)!.status, 'running');
  } finally { await terminateOwnedGroup(child.pid!, { graceMs: 20 }); f.close(); }
});

test('real paired HTTP same-machine project channels keep both live mock agents through sibling startup and ticks', { timeout: 30_000 }, async () => {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, worktree: { warmStart: 'off' }, disk: { minFreeGb: 0, maxWorktreesGb: null }, cleanup: { auto: false } });
  const hub = new Hub({ db: openDb(join(box.home, 'live-channels.db')), token: 'fixture-owner', machineId: 'm-hub', host: '127.0.0.1', port: 0, includeMock: false, tickMs: 150, quiet: true });
  const workers: WorkerLoop[] = [];
  const identities: { pid: number; startedAt: number }[] = [];
  try {
    const url = await hub.start();
    const projects = [await hub.coord.registerProject(box.repo), await hub.coord.registerProject(secondRepo(box.root))];
    const admin = fleetClient(url, hub.token);
    const tasks = projects.map((project, index) => hub.coord.addTasks(project.id, [{ title: `Live channel ${index}`, prompt: '@mock sleep 20000', agent: 'mock' }], 'test').created[0]!);
    const clients: Client[] = [];
    for (const [index, project] of projects.entries()) {
      const invitation = await admin['fleet.invite']({ projectId: project.id });
      const response = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invitation.code, machineId }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const { result: paired } = await response.json() as { result: { token: string; identity: { machineId: string; projectId: string } } };
      assert.equal(paired.identity.machineId, machineId); assert.equal(paired.identity.projectId, project.id);
      const client = fleetClient(url, paired.token); clients.push(client);
      await assert.rejects(client['task.get']({ id: tasks[1 - index]!.id }), /denied/);
      const worker = new WorkerLoop({ hub: url, client, machineId, repos: () => ({ [project.id]: project.root }), agents: () => ['mock'], localConfig: () => loadConfig(), verifySlots: new Semaphore(1), transport: httpTransport(url, paired.token, machineId) });
      workers.push(worker);
      await worker.heartbeat(); await worker.tick();
      const live = await until(() => hub.coord.latestRun(tasks[index]!.id), run => !!run?.pid && run.phase === 'agent', 10_000, `channel ${index} mock agent PID`);
      assert.ok(live?.pid); assert.ok(live.proc_started);
      identities.push({ pid: live.pid, startedAt: live.proc_started });
      for (const identity of identities) assert.equal(groupAlive(identity.pid), true, 'sibling startup never reaps an active channel');
    }
    for (const worker of workers) { await worker.heartbeat(); await worker.tick(); }
    for (const [index, identity] of identities.entries()) {
      assert.equal(groupAlive(identity.pid), true);
      assert.equal(await processStartTime(identity.pid), identity.startedAt);
      assert.equal(hub.coord.latestRun(tasks[index]!.id)!.status, 'running');
      const persisted = new WorkerJournal(machineId, { hub: url, projectIds: [projects[index]!.id] });
      assert.deepEqual(Object.values(persisted.runs).map(run => run.taskId), [tasks[index]!.id]);
      assert.equal(Object.values(persisted.runs)[0]!.pid, identity.pid);
    }
  } finally {
    for (const worker of workers) worker.stopAll('shutdown', 'channel fixture finished');
    await Promise.all(workers.map(worker => worker.drain()));
    for (const identity of identities) { await terminateRecordedProcess(identity, { graceMs: 20 }); assert.equal(groupAlive(identity.pid), false); }
    await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true });
  }
});

for (const scenario of ['active', 'foreign-project', 'foreign-run', 'owned-stopped'] as const) {
  test(`legacy journal adoption preserves original bytes: ${scenario}`, async () => {
    const f = await fixture();
    try {
      const project = f.projects[0]!;
      f.coord.addTasks(project.id, [{ title: 'Legacy identity', agent: 'mock' }], 'test');
      const claim = f.coord.claimNext({ machineId, agents: ['mock'], repos: { [project.id]: project.root }, runningByAgent: {} })!.task;
      const run = f.coord.startRun(claim, machineId, 'mock', null, '');
      if (scenario !== 'active') f.coord.confirmRunExit(run.id, claim.id, { generation: claim.generation, assignee: claim.assignee! });
      if (scenario !== 'active') f.coord.updateTask(claim.id, { status: 'needs_human', lease_until: null });
      const record = { ...pendingRun('legacy'), runId: scenario === 'foreign-run' ? 'r-foreignhub' : run.id, taskId: claim.id, owner: { generation: claim.generation, assignee: claim.assignee! } };
      const artifact = { ...pendingArtifact('legacy'), taskId: claim.id };
      const legacy = join(f.home, `worker-${createHash('sha256').update(machineId).digest('hex').slice(0, 20)}.json`);
      const bytes = JSON.stringify({ version: 1, machineId, runs: { [record.runId]: record }, artifacts: { [claim.id]: artifact } }, null, 2) + '\n';
      writeFileSync(legacy, bytes);
      const readonly = new WorkerJournal(machineId);
      assert.throws(() => readonly.save(), /exclusive channel writer/);
      await assert.rejects(readonly.acquire(f.client), /read-only/);
      const journal = f.journal([scenario === 'foreign-project' ? f.projects[1]!.id : project.id]);
      await assert.rejects(journal.acquire(f.client), /Legacy journal preserved/);
      assert.equal(readFileSync(legacy, 'utf8'), bytes);
      if (scenario === 'owned-stopped') {
        await journal.acquire(f.client, { adoptLegacy: true });
        assert.equal(existsSync(legacy), false);
        const receipts = readdirSync(f.home).filter(name => name.startsWith(legacy.split('/').pop()! + '.adopted-'));
        assert.equal(receipts.length, 1);
        assert.equal(readFileSync(join(f.home, receipts[0]!), 'utf8'), bytes);
        assert.deepEqual(journal.runs, { [record.runId]: record });
        assert.deepEqual(journal.artifacts, { [claim.id]: artifact });
      } else {
        await assert.rejects(journal.acquire(f.client, { adoptLegacy: true }), scenario === 'active' ? /lease is still active/ : scenario === 'foreign-project' ? /another project/ : /not confirmed by this hub/);
        assert.equal(readFileSync(legacy, 'utf8'), bytes);
        assert.deepEqual(readdirSync(f.home).filter(name => name.includes('.adopted-')), []);
      }
    } finally { f.close(); }
  });
}
