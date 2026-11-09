import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { fleetClient, connectWorker } from '../src/fleet-client.ts';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import { WorkerLoop, type BranchTransport } from '../src/worker.ts';
import { WorkerJournal } from '../src/worker-journal.ts';
import { recover, planCleanup, runCleanup } from '../src/janitor.ts';
import { groupAlive, processStartTime, terminateOwnedGroup } from '../src/proc.ts';
import { listHeld } from '../src/budgets.ts';
import type { Task } from '../src/types.ts';
import type { Client } from '../src/api.ts';
import { sandbox, sh, settleTasks, until } from './helpers.ts';

/** Real HTTP, auth, scheduler, verification, journals and Git; only model inference is mocked. */
async function fleet() {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, worktree: { warmStart: 'off' },
    disk: { minFreeGb: 0, maxWorktreesGb: null }, cleanup: { auto: false, deleteMergedBranches: false } });
  const hub = new Hub({ db: openDb(join(box.home, 'fleet-e2e.db')), token: 'fixture-owner-only', machineId: 'm-hub',
    host: '127.0.0.1', port: 0, includeMock: false, tickMs: 150, quiet: true });
  const workers: WorkerLoop[] = [];
  const timers: NodeJS.Timeout[] = [];
  try {
    const url = await hub.start();
    const project = await hub.coord.registerProject(box.repo);
    const owner = fleetClient(url, hub.token);
    const machines = [];
    for (const suffix of ['a', 'b']) {
      const machineId = `m-fleet-${suffix}`;
      const repo = join(box.root, `machine-${suffix}-clone`);
      sh(box.root, 'git', ['clone', '--no-local', '-q', box.repo, repo]);
      sh(repo, 'git', ['config', 'user.name', machineId]);
      sh(repo, 'git', ['config', 'user.email', `${machineId}@example.test`]);
      // Invitation creation and unauthenticated redemption both cross the real Hub HTTP boundary.
      const invite = await owner['fleet.invite']({ projectId: project.id });
      const response = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: invite.code, machineId }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const paired = (await response.json()).result as { token: string; identity: { credentialId: string; machineId: string; projectId: string } };
      assert.match(paired.token, /^ymw_/);
      assert.equal(paired.identity.machineId, machineId);
      assert.equal(paired.identity.projectId, project.id);
      const channel = await connectWorker({ hub: url, machineId, projectIds: [project.id], token: paired.token });
      assert.equal(channel.identity.kind, 'worker');
      const local = resolveConfig([loadConfig(), { worktreeRoot: join(box.root, `machine-${suffix}-worktrees`) }]);
      const transport = httpTransport(url, paired.token, machineId);
      const journalChannel = { hub: url, projectIds: [project.id] };
      const createWorker = (transfer: BranchTransport = transport, maxParallel = 1, api = channel.client) => {
        const worker = new WorkerLoop({ hub: url, client: api, machineId, name: `machine ${suffix}`, repos: () => ({ [project.id]: repo }),
          agents: () => ['mock'], localConfig: () => resolveConfig([local, { maxParallel }]), verifySlots: new Semaphore(1), transport: transfer });
        workers.push(worker);
        return worker;
      };
      machines.push({ journalChannel, machineId, repo, token: paired.token, credentialId: paired.identity.credentialId, client: channel.client, transport, createWorker });
    }
    const pump = (worker: WorkerLoop) => {
      let pending = false;
      const timer = setInterval(() => {
        if (pending) return;
        pending = true;
        void worker.heartbeat().then(() => worker.tick()).finally(() => { pending = false; }).catch(() => undefined);
      }, 100);
      timers.push(timer);
    };
    return { ...box, hub, url, project, owner, machines, pump,
      async close() {
        if (process.env.YM_FLEET_DIAGNOSTICS) console.error(JSON.stringify({ tasks: hub.coord.listTasks(project.id).map(task => ({ id: task.id, status: task.status, attention: task.attention, error: task.last_error })), events: hub.coord.eventsSince(0, project.id, 200).slice(-15) }));
        for (const timer of timers) clearInterval(timer);
        for (const worker of workers) worker.stopAll('shutdown', 'fleet fixture finished');
        await Promise.all(workers.map(worker => worker.drain()));
        await hub.stop();
        hub.coord.db.close();
        rmSync(box.root, { recursive: true, force: true });
      } };
  } catch (err) {
    await hub.stop(); hub.coord.db.close(); rmSync(box.root, { recursive: true, force: true }); throw err;
  }
}

test('paired HTTP worker completes an unchanged report with one event and no code upload', { timeout: 30000 }, async () => {
  const f = await fleet();
  try {
    const machine = f.machines[0]!;
    let uploads = 0;
    const worker = machine.createWorker({ fetchBase: (...args) => machine.transport.fetchBase(...args),
      uploadBranch: async () => { uploads++; throw new Error('A report must never upload code.'); } });
    const task = f.hub.coord.addTasks(f.project.id, [{ title: 'Research project conventions', prompt: 'Report conventions without changing files', allowNoChanges: true, agent: 'mock' }], 'fleet report').created[0]!;
    const before = await f.hub.integrator.head(f.project.id);
    assert.ok(before, 'the fixture integration base is initialized before claiming the report');
    await worker.tick(); f.pump(worker);
    const [done] = await settleTasks(f.hub.coord, [task.id], f.root, 20000);
    assert.equal(done!.status, 'done', done!.attention ?? '');
    await worker.drain();
    const events = () => f.hub.coord.eventsSince(0, f.project.id, 100, task.id).filter(e => e.kind === 'task.done');
    assert.equal(events().length, 1);
    assert.match(events()[0]!.message, /Completed report/);
    assert.equal(uploads, 0);
    assert.equal(sh(f.repo, 'git', ['rev-parse', 'yardmaster/integration']), before);
    assert.equal(listHeld(f.hub.coord.db).length, 0, 'the report releases confirmed-exit allowance');
    const run = f.hub.coord.runsFor(task.id).find(r => r.role === 'implement')!;
    await machine.client['task.completeReport']({ taskId: task.id, runId: run.id, head: done!.head_sha!, summary: 'retry after lost response', owner: { generation: done!.generation, assignee: done!.assignee! } });
    assert.equal(events().length, 1);
  } finally { await f.close(); }
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('real paired HTTP cancellation and a live utility preserve work against a stale hub cleanup plan', { timeout: 25_000 }, async () => {
  const f = await fleet(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const machine = f.machines[0]!;
    const task = f.hub.coord.addTasks(f.project.id, [{ title: 'Keep a canceled utility checkout', agent: 'mock' }], 'cleanup fixture').created[0]!;
    let claim = await machine.client['worker.claim']({ machineId: machine.machineId, agents: ['mock'], repos: { [f.project.id]: machine.repo } }); assert.ok(claim);
    const path = join(f.root, 'worktrees', `${f.project.name}-${f.project.id.slice(2, 8)}`, task.id);
    sh(f.repo, 'git', ['worktree', 'add', '-qb', claim.task.branch!, path, claim.startPoint!]);
    await machine.client['task.update']({ id: task.id, owner: { generation: claim.task.generation, assignee: claim.task.assignee! }, patch: { worktree: path } });
    await f.owner['task.control']({ id: task.id, action: 'cancel' });
    const plan = await planCleanup(f.hub.coord, f.project.id, { sizes: false });
    assert.ok(plan.remove.some(item => item.target === path));
    await f.owner['task.control']({ id: task.id, action: 'retry' });
    claim = await machine.client['worker.claim']({ machineId: machine.machineId, agents: ['mock'], repos: { [f.project.id]: machine.repo } }); assert.ok(claim);
    const owner = { generation: claim.task.generation, assignee: claim.task.assignee! };
    const runId = await machine.client['run.start']({ taskId: task.id, machineId: machine.machineId, agent: 'mock', owner, logPath: '' });
    await machine.client['run.utility']({ runId, taskId: task.id, owner, operation: { action: 'intent', token: 'live-cleanup', command: 'git' } });
    child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { cwd: path, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout!, 'data');
    const startedAt = await processStartTime(child.pid!);
    await machine.client['run.utility']({ runId, taskId: task.id, owner, operation: { action: 'spawn', token: 'live-cleanup', pid: child.pid!, startedAt } });
    await machine.client['run.update']({ runId, owner, patch: { status: 'succeeded' } });
    await f.owner['task.control']({ id: task.id, action: 'cancel' });
    await assert.rejects(machine.client['run.exit']({ runId, taskId: task.id, owner, reaped: true }), /utilities/);
    assert.equal(groupAlive(child.pid!), true);
    const fresh = await planCleanup(f.hub.coord, f.project.id, { sizes: false });
    assert.ok(fresh.keep.some(item => item.target === path && /process|artifacts.*held/.test(item.reason)));
    const result = await runCleanup(f.hub.coord, plan);
    assert.ok(result.failed.some(item => item.item.target === path));
    assert.equal(sh(path, 'git', ['rev-parse', 'HEAD']), claim.startPoint);
    await terminateOwnedGroup(child.pid!, { graceMs: 20 });
    await machine.client['run.utility']({ runId, taskId: task.id, owner, operation: { action: 'exit', token: 'live-cleanup', pid: child.pid!, startedAt, reaped: true } });
    await machine.client['run.exit']({ runId, taskId: task.id, owner, reaped: true });
  } finally { if (child?.pid) await terminateOwnedGroup(child.pid, { graceMs: 20 }); await f.close(); }
});

test('real paired HTTP recovery survives sleep-past-lease and A to B to A ownership in every idle phase', { timeout: 45_000 }, async () => {
  const f = await fleet();
  try {
    const [a, b] = f.machines; assert.ok(a && b);
    for (const phase of ['prepare', 'route', 'collect', 'verify', 'review_wait']) {
      const task = f.hub.coord.addTasks(f.project.id, [{ title: `Recover ${phase} across machines`, agent: 'mock', files: [`${phase}/**`] }], 'fleet recovery').created[0]!;
      const generations: number[] = [];
      for (const machine of [a, b]) {
        const claim = await machine.client['worker.claim']({ machineId: machine.machineId, agents: ['mock'], repos: { [f.project.id]: machine.repo } });
        assert.equal(claim?.task.id, task.id);
        const owner = { generation: claim!.task.generation, assignee: claim!.task.assignee! };
        generations.push(owner.generation);
        const journal = new WorkerJournal(machine.machineId, machine.journalChannel); const client = journal.wrap(machine.client);
        const runId = await client['run.start']({ taskId: task.id, machineId: machine.machineId, agent: 'mock', logPath: '', owner });
        await client['run.update']({ runId, owner, patch: { phase, pid: null } });
        // A suspended machine sends no heartbeat; expire its stored lease without a 90-second test delay.
        f.hub.coord.updateTask(task.id, { lease_until: Date.now() - 1 });
        await recover(f.hub.coord, 'm-hub', new Set());
        assert.equal(f.hub.coord.getRun(runId)!.status, 'cleanup_failed');
        journal.release();
        const returningJournal = new WorkerJournal(machine.machineId, machine.journalChannel);
        assert.equal((await returningJournal.recover(machine.client)).size, 0);
        returningJournal.release();
        assert.equal(f.hub.coord.getTask(task.id)!.status, 'queued');
        assert.equal(listHeld(f.hub.coord.db).length, 0);
        await assert.rejects(client['task.update']({ id: task.id, owner, patch: { summary: 'stale owner must fail' } }));
        journal.release();
      }
      const returning = await a.client['worker.claim']({ machineId: a.machineId, agents: ['mock'], repos: { [f.project.id]: a.repo } });
      assert.equal(returning?.task.id, task.id);
      assert.ok(returning!.task.generation > generations[1]! && generations[1]! > generations[0]!);
      await f.owner['task.control']({ id: task.id, action: 'cancel' });
    }
  } finally { await f.close(); }
});

test('a real paired upload is acknowledged while the integration lock is held', { timeout: 30_000 }, async () => {
  const f = await fleet(); const unlock = latch(); let lockOperation: Promise<void> | undefined;
  try {
    const machine = f.machines[0]!;
    let uploadMs: number | null = null;
    let holding = false;
    const worker = machine.createWorker({ fetchBase: (...args) => machine.transport.fetchBase(...args),
      async uploadBranch(task, ...args) {
        const entered = latch();
        lockOperation = f.hub.integrator.withLock(f.project.id, async () => { holding = true; entered.release(); await unlock.promise; holding = false; });
        await entered.promise;
        const start = Date.now();
        try {
          const result = await machine.transport.uploadBranch(task, ...args);
          uploadMs = Date.now() - start;
          assert.equal(holding, true, 'receipt did not wait for integration verification');
          assert.ok(uploadMs < 5000, `private fixture upload took ${uploadMs} ms`);
          return result;
        } finally { unlock.release(); await lockOperation; }
      },
    });
    const task = f.hub.coord.addTasks(f.project.id, [{ title: 'Upload beside integration', prompt: '@mock write upload.txt accepted', agent: 'mock' }], 'upload latency').created[0]!;
    await worker.tick(); f.pump(worker);
    await until(() => uploadMs, ms => ms !== null, 15_000, 'upload without waiting for integration lock');
    assert.equal((await settleTasks(f.hub.coord, [task.id], f.root, 15_000))[0]!.status, 'done');
    console.log(JSON.stringify({ kind: 'upload-during-integration-lock', uploadMs, integrationLockHeldUntilReceipt: true, inference: 'mock' }));
  } finally { unlock.release(); await lockOperation; await f.close(); }
});

test('paired machines verify and integrate disjoint work, then fetch a dependency from the hub', { timeout: 60_000 }, async () => {
  const f = await fleet();
  const release = latch();
  const uploads = new Map<string, Task>();
  try {
    const [a, b] = f.machines;
    assert.ok(a && b);
    const gated = (machine: typeof a): BranchTransport => ({
      fetchBase: (...args) => machine.transport.fetchBase(...args),
      async uploadBranch(task, ...args) {
        uploads.set(task.id, task);
        await release.promise;
        return machine.transport.uploadBranch(task, ...args);
      },
    });
    const wa = a.createWorker(gated(a));
    const wb = b.createWorker(gated(b));
    const { created } = f.hub.coord.addTasks(f.project.id, [
      { key: 'foundation', title: 'Add the first machine module', prompt: '@mock write left/one.js export const one = 1', files: ['left/one.js'], agent: 'mock' },
      { title: 'Add the second machine module', prompt: '@mock write right/two.js export const two = 2', files: ['right/two.js'], agent: 'mock' },
      { title: 'Use the integrated dependency', prompt: '@mock write left/three.js export const three = 3', files: ['left/three.js'], after: ['foundation'], agent: 'mock',
        verify: ["node -e \"require('node:assert/strict').match(require('node:fs').readFileSync('left/one.js','utf8'), /one = 1/)\""] },
    ], 'fleet e2e');
    await wa.tick();
    await wb.tick();
    await until(() => uploads.size, count => count === 2, 20_000, 'both independent machines reaching verified upload');
    assert.deepEqual(created.slice(0, 2).map(task => f.hub.coord.getTask(task.id)!.status), ['ready', 'ready']);
    assert.deepEqual(new Set(created.slice(0, 2).map(task => f.hub.coord.latestRun(task.id)!.machine_id)), new Set([a.machineId, b.machineId]));
    assert.equal(f.hub.coord.getTask(created[2]!.id)!.status, 'queued', 'dependent work waits for integration');
    for (const task of uploads.values()) {
      const machine = task.machine_id === a.machineId ? a : b;
      assert.equal(sh(machine.repo, 'git', ['rev-parse', `refs/heads/${task.branch}`]), task.head_sha);
      assert.equal(new WorkerJournal(machine.machineId, machine.journalChannel).artifacts[task.id]!.head, task.head_sha);
      assert.ok(f.hub.coord.eventsSince(0, null, 100, task.id).some(event => event.kind === 'task.ready'));
    }
    release.release();
    f.pump(wa); f.pump(wb);
    const done = await settleTasks(f.hub.coord, created.map(task => task.id), f.root, 30_000);
    assert.deepEqual(done.map(task => task.status), ['done', 'done', 'done']);
    for (const [file, content] of [['left/one.js', 'one = 1'], ['right/two.js', 'two = 2'], ['left/three.js', 'three = 3']]) {
      assert.ok(sh(f.repo, 'git', ['show', `yardmaster/integration:${file}`]).includes(content!));
    }
    const dependent = f.hub.coord.getTask(created[2]!.id)!;
    const dependencyMachine = dependent.machine_id === a.machineId ? a : b;
    assert.match(sh(dependencyMachine.repo, 'git', ['for-each-ref', '--format=%(refname)', 'refs/yardmaster/hub/']), /refs\/yardmaster\/hub\/yardmaster\/integration/);
    assert.equal(sh(dependencyMachine.repo, 'git', ['show', `${dependent.base_sha}:left/one.js`]), 'export const one = 1');
    for (const machine of [a, b]) assert.equal(sh(machine.repo, 'git', ['branch', '--show-current']), 'main');
    for (const task of uploads.values()) {
      assert.equal(sh(f.repo, 'git', ['rev-parse', `refs/yardmaster/accepted/${task.id}/${task.generation}`]), task.head_sha);
      sh(f.repo, 'git', ['merge-base', '--is-ancestor', task.head_sha!, 'yardmaster/integration']);
    }

    // A second registered project is real, but its reads and bundles remain private.
    const otherRepo = join(f.root, 'other-project');
    mkdirSync(otherRepo);
    sh(otherRepo, 'git', ['init', '-q', '-b', 'main']);
    sh(otherRepo, 'git', ['commit', '--allow-empty', '-qm', 'private project root']);
    const other = await f.hub.coord.registerProject(otherRepo);
    assert.notEqual(other.id, f.project.id);
    const privateTask = f.hub.coord.addTasks(other.id, [{ title: 'Private project data', agent: 'mock' }], 'fixture').created[0]!;
    await assert.rejects(a.client['task.list']({ projectId: other.id }), /denied/i);
    await assert.rejects(a.client['task.get']({ id: privateTask.id }), /denied/i);
    const cross = await fetch(`${f.url}/api/projects/${other.id}/base-bundle`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal((await cross.json()).ok, false);
    assert.notEqual(cross.status, 200);
    assert.equal(await f.owner['fleet.revoke']({ id: a.credentialId }), true);
    await assert.rejects(a.client['task.peek']({ id: created[0]!.id }), /revoked/i);
    await assert.rejects(connectWorker({ hub: f.url, machineId: a.machineId, projectIds: [f.project.id], token: a.token }), /revoked/i);
    await assert.rejects(a.transport.fetchBase(f.project, a.repo, dependent.base_sha!), /refused/);
  } finally { release.release(); await f.close(); }
});

test('a canceled HTTP bundle aborts while its sibling renews; a replacement generation refuses that old bundle', { timeout: 45_000 }, async () => {
  const f = await fleet();
  let aborted = false;
  let uploading: Task | null = null;
  let oldBundle: Buffer | undefined;
  let uploadStarted = false;
  let canceledTaskId = '';
  let siblingTaskId = '';
  let siblingWaiting = false;
  const siblingGate = latch();
  try {
    const a = f.machines[0]!;
    const slow: BranchTransport = {
      fetchBase: (...args) => a.transport.fetchBase(...args),
      async uploadBranch(task, repo, branch, base, signal) {
        if (task.id !== canceledTaskId) return a.transport.uploadBranch(task, repo, branch, base, signal);
        uploading = task;
        const bundle = join(f.root, 'in-flight.bundle');
        sh(repo, 'git', ['bundle', 'create', bundle, `refs/heads/${branch}`, `^${base}`]);
        oldBundle = readFileSync(bundle);
        const query = new URLSearchParams({ branch, machine: a.machineId, head: task.head_sha!, generation: String(task.generation) });
        await new Promise<never>((_resolve, reject) => {
          const req = request(`${f.url}/api/tasks/${task.id}/bundle?${query}`, { method: 'POST',
            headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/octet-stream', 'content-length': oldBundle!.length } }, response => {
            response.resume(); reject(new Error(`Partial bundle unexpectedly answered ${response.statusCode}`));
          });
          const abort = () => { aborted = true; req.destroy(new Error('canceled upload')); };
          signal!.addEventListener('abort', abort, { once: true });
          req.once('error', reject);
          req.once('close', () => signal!.removeEventListener('abort', abort));
          // Begin a real Hub upload but deliberately withhold the final bytes.
          req.write(oldBundle!.subarray(0, Math.max(1, Math.floor(oldBundle!.length / 2))), () => { uploadStarted = true; });
        });
        throw new Error('Unreachable');
      },
    };
    const gatedClient = new Proxy(a.client, { get(target, key: keyof Client) {
      if (key !== 'run.update') return target[key];
      return async (params: Parameters<Client['run.update']>[0]) => {
        if (params.patch.phase === 'agent:spawning' && f.hub.coord.getRun(params.runId)?.task_id === siblingTaskId) {
          siblingWaiting = true;
          await siblingGate.promise;
        }
        return target[key](params);
      };
    } });
    const wa = a.createWorker(slow, 2, gatedClient);
    const tasks = f.hub.coord.addTasks(f.project.id, [
      { title: 'Cancel this in-flight artifact', prompt: '@mock write cancel/a.txt accepted', files: ['cancel/a.txt'], agent: 'mock' },
      { title: 'Keep sibling progress', prompt: '@mock write sibling/b.txt accepted', files: ['sibling/b.txt'], agent: 'mock' },
    ], 'fleet cancel e2e').created;
    canceledTaskId = tasks[0]!.id;
    siblingTaskId = tasks[1]!.id;
    await wa.tick();
    await until(() => uploadStarted, Boolean, 20_000, 'partial bundle reaching real Hub');
    await until(() => siblingWaiting, Boolean, 20_000, 'sibling held before coding launch');
    const sibling = f.hub.coord.getTask(tasks[1]!.id)!;
    assert.equal(sibling.status, 'running');
    assert.equal(sibling.machine_id, a.machineId);
    // A bounded gate keeps this claim active; compare actual renewal against its stored prior lease.
    const priorLease = Date.now() + 30_000;
    f.hub.coord.db.prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(priorLease, sibling.id);
    await f.owner['task.control']({ id: tasks[0]!.id, action: 'cancel', by: 'fleet test' });
    await wa.heartbeat();
    await until(() => aborted && !wa.active.has(tasks[0]!.id), Boolean, 5000, 'cancel aborting the upload');
    assert.equal(f.hub.coord.getTask(sibling.id)!.status, 'running');
    assert.ok(f.hub.coord.getTask(sibling.id)!.lease_until! > priorLease);
    siblingGate.release();
    assert.equal(f.hub.coord.getTask(tasks[0]!.id)!.status, 'canceled');
    f.pump(wa);
    assert.equal((await settleTasks(f.hub.coord, [sibling.id], f.root, 20_000))[0]!.status, 'done');
    assert.equal(sh(f.repo, 'git', ['show', 'yardmaster/integration:sibling/b.txt']), 'accepted');
    wa.stopAll('shutdown', 'replace canceled worker');
    await f.owner['task.control']({ id: tasks[0]!.id, action: 'retry', by: 'fleet test' });
    const replacement = await a.client['worker.claim']({ machineId: a.machineId, agents: ['mock'], repos: { [f.project.id]: a.repo } });
    assert.ok(replacement);
    const stale = uploading as unknown as Task;
    assert.ok(replacement.task.generation > stale.generation);
    const query = new URLSearchParams({ branch: stale.branch!, machine: a.machineId, head: stale.head_sha!, generation: String(stale.generation) });
    const response = await fetch(`${f.url}/api/tasks/${stale.id}/bundle?${query}`, { method: 'POST', headers: {
      authorization: `Bearer ${a.token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(oldBundle!) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).ok, false);
    assert.equal(f.hub.coord.getTask(stale.id)!.generation, replacement.task.generation);
    assert.equal(f.hub.coord.getMeta(`bundle:${stale.id}:${stale.generation}`), null);
    assert.equal(sh(f.repo, 'git', ['for-each-ref', '--format=%(refname)', `refs/yardmaster/accepted/${stale.id}/`]), '');
    await f.owner['task.control']({ id: stale.id, action: 'cancel', by: 'fixture cleanup' });
  } finally { siblingGate.release(); await f.close(); }
});

test('a paired worker reconnects and reuploads its durable verified branch without running the model again', { timeout: 40_000 }, async () => {
  const f = await fleet();
  try {
    const a = f.machines[0]!;
    let failures = 0;
    const worker = a.createWorker({ fetchBase: (...args) => a.transport.fetchBase(...args), async uploadBranch() { failures++; throw new Error('fixture connection lost before upload'); } });
    const task = f.hub.coord.addTasks(f.project.id, [{ title: 'Recover accepted work', prompt: '@mock write recovered.txt durable', files: ['recovered.txt'], agent: 'mock' }], 'fleet reconnect e2e').created[0]!;
    await worker.tick();
    await until(() => worker.active.size === 0 && failures > 0, Boolean, 20_000, 'durable failed upload');
    worker.stopAll('shutdown', 'simulate worker restart');
    await worker.drain();
    const before = f.hub.coord.runsFor(task.id).map(run => run.id);
    assert.equal(before.length, 1);
    const journal = new WorkerJournal(a.machineId, a.journalChannel);
    await journal.acquire(a.client);
    const artifact = journal.artifacts[task.id]!;
    assert.equal(artifact.uploaded, false);
    assert.ok(artifact.failures >= 1);
    assert.equal(sh(a.repo, 'git', ['rev-parse', artifact.branch]), artifact.head);
    artifact.retryAt = 0; journal.save(); journal.release();
    await connectWorker({ hub: f.url, machineId: a.machineId, projectIds: [f.project.id], token: a.token });
    const restarted = a.createWorker();
    await restarted.recoverLocal();
    assert.equal(new WorkerJournal(a.machineId, a.journalChannel).artifacts[task.id]!.uploaded, true);
    assert.equal((await settleTasks(f.hub.coord, [task.id], f.root, 15_000))[0]!.status, 'done');
    assert.deepEqual(f.hub.coord.runsFor(task.id).map(run => run.id), before);
    assert.equal(sh(f.repo, 'git', ['show', 'yardmaster/integration:recovered.txt']), 'durable');
  } finally { await f.close(); }
});

for (const state of ['queued', 'running'] as const) {
  test(`paired report winner cancels ${state} race rivals and releases dependencies`, { timeout: 45000 }, async () => {
    const f = await fleet();
    try {
      const [a, b] = f.machines; assert.ok(a && b);
      let uploads = 0;
      const noUpload = (machine: typeof a): BranchTransport => ({ fetchBase: (...args) => machine.transport.fetchBase(...args),
        uploadBranch: async () => { uploads++; throw new Error('Report race must not upload code.'); } });
      const wa = a.createWorker(noUpload(a));
      const before = await f.hub.integrator.head(f.project.id); assert.ok(before);
      const { created } = f.hub.coord.addTasks(f.project.id, [
        { key: 'report', title: 'Race convention reports', prompt: 'Report repository conventions without changing files', allowNoChanges: true, bestOf: 2, agent: 'mock' },
        { title: 'Read the winning convention report', prompt: 'Summarize the completed research without changing files', allowNoChanges: true, after: ['report'], agent: 'mock' },
      ], 'report race');
      const primary = created[0]!;
      const alternate = created.find(t => t.race_group === primary.race_group && t.id !== primary.id)!;
      const dependent = created.find(t => !t.race_group)!;
      assert.ok(alternate && dependent);
      f.hub.coord.updateTask(primary.id, { priority: 5, ...(state === 'running' ? { prompt: '@mock sleep 60000\nReport conventions without changing files' } : {}) });
      await wa.tick(); f.pump(wa);
      let rivalPid: number | null = null;
      let wb: WorkerLoop | undefined;
      if (state === 'running') {
        rivalPid = await until(() => f.hub.coord.latestRun(primary.id)?.pid ?? null, pid => pid !== null, 15000, 'rival coding process to be live');
        assert.ok(rivalPid && groupAlive(rivalPid));
        wb = b.createWorker(noUpload(b));
        await wb.tick(); f.pump(wb);
      }
      const winner = state === 'running' ? alternate : primary;
      const rival = state === 'running' ? primary : alternate;
      const [won, followed] = await settleTasks(f.hub.coord, [winner.id, dependent.id], f.root, 25000);
      assert.equal(won!.status, 'done', won!.attention ?? '');
      assert.equal(followed!.status, 'done', followed!.attention ?? '');
      assert.equal(f.hub.coord.getTask(rival.id)!.status, 'canceled');
      await wa.drain(); await wb?.drain();
      if (rivalPid) assert.equal(groupAlive(rivalPid), false, 'running rival is reaped before replacement work settles');
      else assert.equal(f.hub.coord.runsFor(rival.id).length, 0, 'queued rival never launches');
      const lost = () => f.hub.coord.eventsSince(0, f.project.id, 100, rival.id).filter(e => e.kind === 'race.lost');
      assert.equal(lost().length, 1);
      assert.equal(f.hub.coord.raceMembers(primary.race_group!).filter(t => t.status === 'done').length, 1);
      assert.equal(listHeld(f.hub.coord.db).length, 0);
      assert.equal(uploads, 0);
      assert.equal(sh(f.repo, 'git', ['rev-parse', 'yardmaster/integration']), before);
      const machine = state === 'running' ? b : a;
      const run = f.hub.coord.runsFor(winner.id).find(r => r.role === 'implement')!;
      await machine.client['task.completeReport']({ taskId: winner.id, runId: run.id, head: won!.head_sha!, summary: 'replay winner', owner: { generation: won!.generation, assignee: won!.assignee! } });
      assert.equal(lost().length, 1, 'completion replay does not re-cancel rivals');
      assert.equal(f.hub.coord.eventsSince(0, f.project.id, 100, winner.id).filter(e => e.kind === 'task.done').length, 1);
    } finally { await f.close(); }
  });
}
