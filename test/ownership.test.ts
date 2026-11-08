import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openDb, SCHEMA_VERSION } from '../src/db.ts';
import { Coordinator, StaleAttemptError } from '../src/coordinator.ts';
import { buildMethods, localClient, type Client } from '../src/api.ts';
import { recover } from '../src/janitor.ts';
import { WorkerLoop } from '../src/worker.ts';
import { runAttempt, Semaphore } from '../src/runner.ts';
import { loadConfig } from '../src/config.ts';
import { httpTransport } from '../src/transport.ts';
import { sandbox, sh } from './helpers.ts';
import type { Task } from '../src/types.ts';

async function fixture() {
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' } });
  const dbFile = join(box.home, 'ownership.db');
  const coord = new Coordinator(openDb(dbFile));
  const project = await coord.registerProject(box.repo);
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  const add = (title = 'Implement unique ownership') => coord.addTasks(project.id, [{ title, prompt: '@mock write result.txt correct', agent: 'mock' }], 'test').created[0]!;
  const claim = (machine = 'm-A') => coord.claimNext({ machineId: machine, agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  return { ...box, dbFile, coord, project, client, add, claim };
}
const ownerOf = (task: Task) => ({ generation: task.generation, attempt: task.attempts, assignee: task.assignee! });

for (const sequence of [['m-A', 'm-A', 'm-A'], ['m-A', 'm-B', 'm-A']]) {
  test(`recovery never recycles ownership across ${sequence.join(' → ')}`, async () => {
    const s = await fixture();
    try {
      const task = s.add();
      const previous: { task: Task; runId: string }[] = [];
      for (const machine of sequence) {
        const current = s.claim(machine);
        const owner = ownerOf(current);
        assert.equal(current.attempts, 1, 'recovery refunds charged retries');
        const runId = await s.client['run.start']({ taskId: task.id, machineId: machine, agent: 'mock', logPath: '', owner });
        assert.equal(s.coord.getRun(runId)!.generation, current.generation);
        await s.client['task.update']({ id: task.id, owner, patch: { summary: 'current owner' } });
        assert.equal(s.coord.renewLease(task.id, machine, current.generation), true);
        await s.client['task.touched']({ taskId: task.id, runId, files: ['current.ts'], owner });
        await s.client['run.update']({ runId, owner, patch: { last_activity: 'current owner' } });
        for (const stale of previous) {
          const old = ownerOf(stale.task);
          await assert.rejects(s.client['task.update']({ id: task.id, owner: old, patch: { status: 'ready', summary: 'stale' } }), StaleAttemptError);
          assert.equal(s.coord.renewLease(task.id, stale.task.machine_id!, old.generation), false);
          await assert.rejects(s.client['run.start']({ taskId: task.id, machineId: stale.task.machine_id!, agent: 'mock', logPath: '', owner: old }), StaleAttemptError);
          await assert.rejects(s.client['task.touched']({ taskId: task.id, runId: stale.runId, files: ['stale.ts'], owner: old }), StaleAttemptError);
          await assert.rejects(s.client['run.update']({ runId: stale.runId, owner: old, patch: { pid: 123, touched: ['stale.ts'] } }), StaleAttemptError);
          await assert.rejects(s.client['run.log']({ runId: stale.runId, owner: old, lines: ['stale'] }), StaleAttemptError);
          await assert.rejects(s.client['task.usage']({ id: task.id, runId: stale.runId, owner: old, costUsd: 1, tokensIn: 1, tokensOut: 1 }), StaleAttemptError);
          // A current owner cannot use a previous generation's run either.
          await assert.rejects(s.client['task.touched']({ taskId: task.id, runId: stale.runId, files: ['stale.ts'], owner }), StaleAttemptError);
        }
        if (previous.length) assert.equal(current.generation, previous.length + 1, 'claim identity increases independently');
        assert.equal(s.coord.getTask(task.id)!.summary, 'current owner');
        assert.deepEqual(s.coord.getRun(runId)!.touched, ['current.ts']);
        previous.push({ task: current, runId });
        // No child was launched in this fixture. Report that proof before allowing a replacement;
        // a vanished remote worker alone no longer implies that its process exited.
        await s.client['run.exit']({ runId, taskId: task.id, owner, reaped: true });
        s.coord.updateTask(task.id, { lease_until: Date.now() - 1 });
        await recover(s.coord, 'm-hub', new Set());
        assert.equal(s.coord.getTask(task.id)!.status, 'queued');
      }
    } finally { s.coord.db.close(); }
  });
}

test('legacy workers fail clearly, administrative writes are explicit, and expired claims cannot renew', async () => {
  const s = await fixture();
  try {
    const t = s.add();
    const claim = s.claim();
    await assert.rejects(s.client['task.update']({ id: t.id, patch: { status: 'done' } }), /valid claim generation.*Upgrade/);
    await assert.rejects(s.client['task.update']({ id: t.id, owner: { attempt: claim.attempts, assignee: claim.assignee! }, patch: { status: 'done' } }), /valid claim generation/);
    await assert.rejects(s.client['run.start']({ taskId: t.id, machineId: 'm-A', agent: 'mock', logPath: '' }), /valid claim generation/);
    await assert.rejects(s.client['machine.heartbeat']({ id: 'm-A', name: 'old worker', info: {}, running: [{ taskId: t.id }] }), /valid claim generation/);
    await assert.rejects(s.client['task.usage']({ id: t.id, costUsd: 1, tokensIn: 1, tokensOut: 1 }), /valid claim generation.*Upgrade/);
    assert.equal(s.coord.renewLease(t.id, 'm-A'), false);
    await s.client['task.adminUpdate']({ id: t.id, patch: { summary: 'explicit admin' } });
    assert.equal(s.coord.getTask(t.id)!.summary, 'explicit admin');
    await assert.rejects(s.client['task.update']({ id: t.id, owner: ownerOf(claim), patch: { generation: 0 } }), /Cannot update task column generation/);
    s.coord.updateTask(t.id, { lease_until: Date.now() - 1 });
    assert.equal(s.coord.renewLease(t.id, 'm-A', claim.generation), false);
    await assert.rejects(s.client['task.update']({ id: t.id, owner: ownerOf(claim), patch: { summary: 'expired' } }), StaleAttemptError);
    await assert.rejects(s.client['run.start']({ taskId: t.id, machineId: 'm-A', agent: 'mock', logPath: '', owner: ownerOf(claim) }), StaleAttemptError);
  } finally { s.coord.db.close(); }
});

test('interactive completion requires the live session generation and never revives cancellation', async () => {
  const s = await fixture();
  try {
    const task = s.coord.addTasks(s.project.id, [{ title: 'Implement scoped ownership', agent: 'mock', files: ['src/**'] }], 'test').created[0]!;
    const sessionId = 'session:interactive';
    const first = s.coord.claimForSession(sessionId, s.project.id, task.id)!;
    s.coord.claimLocks(s.project.id, sessionId, ['src/**'], 'interactive work', 30);
    s.coord.control(task.id, 'cancel', 'test');
    await assert.rejects(s.client['session.finish']({ sessionId, taskId: task.id, generation: first.generation, summary: 'late' }), StaleAttemptError);
    assert.equal(s.coord.getTask(task.id)!.status, 'canceled');
    assert.equal(s.coord.activeLocks(s.project.id).length, 1);
    s.coord.control(task.id, 'retry', 'test');
    const second = s.coord.claimForSession(sessionId, s.project.id, task.id)!;
    assert.ok(second.generation > first.generation);
    assert.equal(s.coord.renewSessionLease(task.id, sessionId, first.generation), false);
    assert.deepEqual(await s.client['session.heartbeat']({ sessionId, claims: [{ taskId: task.id, generation: second.generation }] }), [{ taskId: task.id, renewed: true }]);
    await assert.rejects(s.client['session.finish']({ sessionId, taskId: task.id, generation: first.generation, summary: 'stale same session' }), StaleAttemptError);
    await assert.rejects(s.client['session.finish']({ sessionId, taskId: task.id, summary: 'legacy' }), /valid claim generation/);
    s.coord.updateTask(task.id, { lease_until: Date.now() - 1 });
    s.coord.registerSession('interactive', 'mock', s.project.id, s.repo, null);
    assert.ok(s.coord.getTask(task.id)!.lease_until! < Date.now(), 'registration cannot revive or renew a task claim');
    assert.equal(s.coord.renewSessionLease(task.id, sessionId, second.generation), false);
    await assert.rejects(s.client['session.finish']({ sessionId, taskId: task.id, generation: second.generation, summary: 'expired' }), StaleAttemptError);
    s.coord.updateTask(task.id, { lease_until: Date.now() + 60_000 });
    const done = await s.client['session.finish']({ sessionId, taskId: task.id, generation: second.generation, summary: 'valid' });
    assert.equal(done.status, 'done');
    assert.equal(s.coord.activeLocks(s.project.id).length, 0);
  } finally { s.coord.db.close(); }
});

test('finishing one session task preserves another claim and unrelated manual reservations', async () => {
  const s = await fixture();
  try {
    const session = 'session:multi';
    const tasks = s.coord.addTasks(s.project.id, [
      { title: 'Change component alpha', agent: 'mock', files: ['alpha/**'] },
      { title: 'Change component beta', agent: 'mock', files: ['beta/**'] },
    ], 'test').created;
    const a = s.coord.claimForSession(session, s.project.id, tasks[0]!.id)!;
    s.coord.claimForSession(session, s.project.id, tasks[1]!.id);
    s.coord.claimLocks(s.project.id, session, ['alpha/**', 'beta/**', 'manual/**'], 'session work', 30);
    s.coord.finishForSession(session, a.id, 'complete', 'done', undefined, a.generation);
    assert.deepEqual(s.coord.activeLocks(s.project.id).map(lock => lock.pattern).sort(), ['beta/**', 'manual/**']);
  } finally { s.coord.db.close(); }
});

test('interactive branch handoff requires registered local source and never accepts an unverified artifact', async () => {
  const s = await fixture();
  try {
    const task = s.add();
    const claim = s.coord.claimForSession('session:branch', s.project.id, task.id)!;
    const branch = `yardmaster/${task.id}`;
    sh(s.repo, 'git', ['branch', branch]);
    await assert.rejects(s.client['session.finish']({ sessionId: claim.assignee!, taskId: task.id, generation: claim.generation, summary: 'done', branch }), /Register this native session/);
    const current = s.coord.getTask(task.id)!;
    assert.equal(current.status, 'running');
    assert.equal(current.head_sha, null);
    assert.equal(current.ready_at, null);
  } finally { s.coord.db.close(); }
});

test('bundle acceptance checks reject stale identity before and after an awaited import', async () => {
  const s = await fixture();
  try {
    const task = s.add();
    const old = s.claim();
    const head = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
    s.coord.updateTask(task.id, { status: 'ready', head_sha: head });
    assert.equal(s.coord.assertBundleOwner(task.id, 'm-A', old.generation, head, old.branch!).generation, old.generation);
    // Receipt/import yields; the owner cancels and reclaims on exactly the same machine.
    await Promise.resolve();
    s.coord.control(task.id, 'cancel', 'test');
    s.coord.control(task.id, 'retry', 'test');
    const fresh = s.claim();
    s.coord.updateTask(task.id, { status: 'ready', head_sha: head });
    assert.throws(() => s.coord.assertBundleOwner(task.id, 'm-A', old.generation, head, old.branch!), StaleAttemptError);
    assert.throws(() => s.coord.assertBundleOwner(task.id, 'm-A', 0, head, old.branch!), /valid claim generation/);
    assert.throws(() => s.coord.assertBundleOwner(task.id, 'm-A', fresh.generation, 'a'.repeat(40), fresh.branch!), /accepted branch and commit/);
    assert.equal(s.coord.assertBundleOwner(task.id, 'm-A', fresh.generation, head, fresh.branch!).head_sha, head);
  } finally { s.coord.db.close(); }
});

test('transport sends original generation and requires acknowledgment of the exact accepted SHA', async () => {
  const s = await fixture();
  const requests: URL[] = [];
  let acknowledged = 'a'.repeat(40);
  const server = createServer(async (req, res) => {
    requests.push(new URL(req.url!, 'http://localhost'));
    for await (const _ of req) { /* drain bundle */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { head: acknowledged } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const t = s.add();
    const claim = s.claim();
    const head = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
    sh(s.repo, 'git', ['branch', claim.branch!]);
    const ready = s.coord.updateTask(t.id, { status: 'ready', head_sha: head });
    const transport = httpTransport(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'test', 'm-A');
    await assert.rejects(transport.uploadBranch(ready, s.repo, ready.branch!, head), /did not acknowledge/);
    assert.equal(requests[0]!.searchParams.get('generation'), String(claim.generation));
    assert.equal(requests[0]!.searchParams.get('head'), head);
    acknowledged = head;
    assert.deepEqual(await transport.uploadBranch(ready, s.repo, ready.branch!, head), { head });
    await assert.rejects(transport.uploadBranch({ ...ready, head_sha: 'b'.repeat(40) }, s.repo, ready.branch!, head), /moved since verification/);
    assert.equal(requests.length, 2, 'moved branch never uploads');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    s.coord.db.close();
  }
});

test('schema upgrade preserves existing task/run rows and allocates fresh identity after reclaim', async () => {
  const s = await fixture();
  const task = s.add();
  const claim = s.claim();
  const run = s.coord.startRun(claim, 'm-A', 'mock', null, '/fixture/log');
  // Upgrade an actual released schema fixture, independently of however many migrations this branch adds.
  const saved = ['projects', 'tasks', 'runs'].map((table) => ({ table, rows: s.coord.db.prepare(`SELECT * FROM ${table}`).all() }));
  for (const row of s.coord.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) s.coord.db.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
  s.coord.db.exec(readFileSync(new URL('./fixtures/schema-v5.sql', import.meta.url), 'utf8'));
  for (const { table, rows } of saved) {
    const columns = s.coord.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
    for (const row of rows) s.coord.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((c) => row[c] as string | number | null));
  }
  s.coord.db.close();
  const db = openDb(s.dbFile);
  try {
    const coord = new Coordinator(db);
    assert.equal(coord.getTask(task.id)!.generation, 0);
    assert.equal(coord.getRun(run.id)!.generation, 0);
    assert.equal(coord.getTask(task.id)!.attempts, 1);
    assert.equal(coord.getRun(run.id)!.log_path, '/fixture/log');
    assert.equal(coord.renewLease(task.id, 'm-A'), false);
    // The released-schema live run migrates with a budget hold. An administrative requeue cannot
    // discard that hold: this fixture launched no child, so trusted recovery can prove it exited.
    coord.confirmRecoveredRunExit(run.id, { status: 'exited', reason: 'Fixture never launched a process.' });
    coord.updateTask(task.id, { status: 'queued', assignee: null, machine_id: null, attempts: 0 });
    const fresh = coord.claimNext({ machineId: 'm-A', agents: ['mock'], repos: { [s.project.id]: s.repo }, runningByAgent: {} })!.task;
    assert.equal(fresh.generation, 1);
    assert.throws(() => coord.startRun({ ...claim, generation: 0 }, 'm-A', 'mock', null, ''), /valid claim generation/);
  } finally { db.close(); }
  const reopened = openDb(s.dbFile);
  try { assert.equal(new Coordinator(reopened).getTask(task.id)!.generation, 1); }
  finally { reopened.close(); }
});

for (const scenario of ['unchanged', 'attached commit', 'detached commit', 'detached accepted', 'locked', 'dirty', 'active', 'retry during peek', 'commit during peek']) {
  test(`remote tidy preserves work: ${scenario}`, async () => {
    const s = await fixture();
    try {
      const task = s.add();
      const claim = s.claim();
      const head = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
      const path = join(s.root, 'worktrees', `repo-${s.project.id.slice(2, 8)}`, task.id);
      mkdirSync(join(path, '..'), { recursive: true });
      sh(s.repo, 'git', ['worktree', 'add', '-q', '-b', claim.branch!, path, head]);
      s.coord.updateTask(task.id, { status: 'done', head_sha: head });
      const commit = () => {
        writeFileSync(join(path, 'unique.txt'), 'must survive');
        sh(path, 'git', ['add', 'unique.txt']);
        sh(path, 'git', ['commit', '-qm', 'new unmerged work']);
      };
      if (scenario.startsWith('detached')) sh(path, 'git', ['checkout', '-q', '--detach']);
      if (scenario === 'attached commit' || scenario === 'detached commit') commit();
      if (scenario === 'locked') sh(s.repo, 'git', ['worktree', 'lock', path]);
      if (scenario === 'dirty') writeFileSync(join(path, 'notes.txt'), 'uncommitted');
      let peeks = 0;
      const client = new Proxy(s.client, { get(target, key: keyof Client) {
        if (key !== 'task.peek') return target[key];
        return async (p: Parameters<Client['task.peek']>[0]) => {
          peeks++;
          if (peeks === 2 && scenario === 'retry during peek') s.coord.control(task.id, 'retry', 'test');
          if (peeks === 2 && scenario === 'commit during peek') commit();
          return target['task.peek'](p);
        };
      } });
      const worker = new WorkerLoop({ hub: 'http://fixture.local', client, machineId: 'm-A', repos: () => ({ [s.project.id]: s.repo }), agents: () => ['mock'],
        localConfig: () => loadConfig(), verifySlots: new Semaphore(1), transport: { async fetchBase() {}, async uploadBranch() { return { head }; } } });
      if (scenario === 'active') worker.active.set(task.id, { task: claim, agent: 'mock' });
      await worker.tidyLocal();
      worker.stopAll('shutdown', 'fixture done'); worker.active.clear(); await worker.drain();
      assert.equal(existsSync(path), scenario !== 'unchanged');
      if (scenario !== 'unchanged') assert.equal(sh(path, 'git', ['rev-parse', '--show-toplevel']), path);
    } finally { s.coord.db.close(); }
  });
}

test('a canceled claim never launches the runner even with effort routing disabled', async () => {
  const s = await fixture();
  try {
    const task = s.add();
    const claim = s.claim();
    const startPoint = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
    s.coord.control(task.id, 'cancel', 'test');
    const result = await runAttempt({ api: s.client, machineId: 'm-A', task: claim, project: s.project, repoPath: s.repo,
      agent: 'mock', model: null, config: loadConfig(), startPoint, verifySlots: new Semaphore(1) });
    assert.equal(result.status, 'superseded');
    assert.equal(s.coord.latestRun(task.id), null);
    assert.equal(s.coord.getTask(task.id)!.worktree, null);
  } finally { s.coord.db.close(); }
});
