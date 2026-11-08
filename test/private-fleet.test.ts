import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, dispatch } from '../src/api.ts';
import { PairingStore, migrationDDL, authorizeWorkerRpc, authorizeWorkerBaseBundle, authorizeWorkerUpload,
  type OwnerIdentity, type WorkerIdentity } from '../src/pairing.ts';
import { sandbox } from './helpers.ts';

const owner: OwnerIdentity = { kind: 'owner', ownerId: 'personal-owner' };
function fixture() {
  const box = sandbox(); const file = join(box.home, 'fleet.db'); const db = openDb(file);
  // Isolated fixture only. Production must append the DDL to the versioned migrations.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fleet_credentials'").get()) db.exec(migrationDDL);
  for (const p of ['p-one', 'p-two']) db.prepare('INSERT INTO projects (id, name, root, base_branch, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(p, p, box.repo, 'main', Date.now());
  const coord = new Coordinator(db);
  const a = coord.addTasks('p-one', [{ title: 'Own project task', agent: 'mock' }, { title: 'Another project scoped read', agent: 'mock' }], 'fixture').created;
  const b = coord.addTasks('p-two', [{ title: 'Other private project', agent: 'mock' }], 'fixture').created[0]!;
  coord.updateTask(a[0]!.id, { status: 'running', machine_id: 'm-one', assignee: 'machine:m-one', lease_until: Date.now() + 60_000 });
  fakedGeneration(db, a[0]!.id, 1);
  const t = coord.getTask(a[0]!.id)!;
  const run = coord.startRun(t, 'm-one', 'mock', 'fixture-model', '');
  const store = new PairingStore(db, { ownerId: owner.ownerId });
  const invite = store.createInvitation(owner, { projectId: 'p-one' });
  const paired = store.redeemInvitation(invite.code, 'm-one');
  return { db, file, box, coord, store, invite, ...paired, task: t, sibling: a[1]!, other: b, run,
    claim: { generation: 1, assignee: 'machine:m-one' } };
}

/** Fixture-only recovery/reclaim injection. Runtime generation allocation belongs exclusively to claims. */
function fakedGeneration(db: Db, taskId: string, generation: number): void {
  db.prepare('UPDATE tasks SET generation = ? WHERE id = ?').run(generation, taskId);
}

test('pairing is owner-created, project-scoped, high entropy and stores only hashes', () => {
  const f = fixture();
  try {
    const second = f.store.createInvitation(owner, { projectId: 'p-one' });
    assert.match(second.code, /^ymi_[A-Za-z0-9_-]{43}$/);
    assert.match(f.token, /^ymw_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(second.code, f.invite.code);
    assert.notEqual(f.token, f.invite.code);
    assert.deepEqual(f.store.authenticate(f.token), f.identity);
    assert.equal(f.identity.kind, 'worker'); assert.equal(f.identity.projectId, 'p-one');
    const raw = JSON.stringify([...f.db.prepare('SELECT * FROM fleet_credentials').all(), ...f.db.prepare('SELECT * FROM fleet_invitations').all()]);
    for (const secret of [f.token, f.invite.code, second.code]) assert.ok(!raw.includes(secret));
    const metadata = JSON.stringify([f.store.listCredentials(owner), f.store.listInvitations(owner)]);
    assert.ok(!/hash|ymi_|ymw_/.test(metadata));
    assert.throws(() => f.store.createInvitation({ kind: 'owner', ownerId: 'stranger' }, { projectId: 'p-one' }));
    assert.throws(() => f.store.createInvitation(f.identity as unknown as OwnerIdentity, { projectId: 'p-one' }));
    assert.throws(() => f.store.createInvitation(owner, { projectId: 'missing' }));
    assert.throws(() => f.store.createInvitation(owner, { projectId: 'p-one', ttlMs: Infinity }));
    assert.throws(() => f.store.createInvitation(owner, { projectId: 'p-one', credentialTtlMs: 0 }));
    assert.throws(() => f.store.redeemInvitation(second.code, '')); // Does not consume the valid code.
    assert.equal(f.store.redeemInvitation(second.code, 'm-two').identity.machineId, 'm-two');
    assert.equal(f.store.authenticate('administrative-token'), null);
    assert.equal(f.store.authenticate('x'.repeat(1_000_000)), null);
    assert.throws(() => f.store.listCredentials(owner, 501));
  } finally { f.db.close(); }
});

test('redemption is exactly once across independent connections and a database restart', () => {
  const f = fixture(); let secondDb: Db | null = null;
  try {
    secondDb = openDb(f.file);
    const store2 = new PairingStore(secondDb, { ownerId: owner.ownerId });
    assert.throws(() => store2.redeemInvitation(f.invite.code, 'm-attacker'));
    assert.deepEqual(store2.authenticate(f.token), f.identity);
    secondDb.close(); secondDb = null;
    f.db.close();
    secondDb = openDb(f.file);
    const restarted = new PairingStore(secondDb, { ownerId: owner.ownerId });
    assert.deepEqual(restarted.authenticate(f.token), f.identity);
    assert.throws(() => restarted.redeemInvitation(f.invite.code, 'm-one'));
    assert.equal(restarted.listCredentials(owner).length, 1);
    assert.equal(restarted.revokeCredential(owner, f.identity.credentialId), true);
    secondDb.close(); secondDb = openDb(f.file);
    assert.equal(new PairingStore(secondDb, { ownerId: owner.ownerId }).authenticate(f.token), null);
  } finally { secondDb?.close(); if (f.db.isOpen) f.db.close(); }
});

test('invitation/token expiry and revocation reject the boundary timestamp and replay', () => {
  const f = fixture();
  try {
    let now = Date.now();
    const store = new PairingStore(f.db, { ownerId: owner.ownerId, now: () => now });
    const expires = store.createInvitation(owner, { projectId: 'p-one', ttlMs: 1000 });
    now += 1000;
    assert.throws(() => store.redeemInvitation(expires.code, 'm-two'));
    const invitation = store.createInvitation(owner, { projectId: 'p-one', credentialTtlMs: 1000 });
    const paired = store.redeemInvitation(invitation.code, 'm-two');
    assert.ok(store.authenticate(paired.token));
    now += 1000; assert.equal(store.authenticate(paired.token), null);
    const revoked = store.createInvitation(owner, { projectId: 'p-one' });
    assert.equal(store.revokeInvitation(owner, revoked.invitation.id), true);
    assert.throws(() => store.redeemInvitation(revoked.code, 'm-two'));
    assert.throws(() => store.revokeCredential({ kind: 'owner', ownerId: 'stranger' }, f.identity.credentialId));
    assert.equal(store.revokeCredential(owner, f.identity.credentialId), true);
    assert.equal(store.revokeCredential(owner, f.identity.credentialId), false);
    assert.equal(store.authenticate(f.token), null);
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.peek', { id: f.task.id }));
    assert.throws(() => authorizeWorkerBaseBundle(f.coord, f.identity, 'p-one'));
  } finally { f.db.close(); }
});

test('worker reads stay inside the project; administrative and unknown methods fail closed', async () => {
  const f = fixture();
  try {
    const methods = buildMethods(f.coord, { machineId: 'm-hub' });
    authorizeWorkerRpc(f.coord, f.identity, 'task.list', { projectId: 'p-one' });
    const result = await dispatch(methods, 'task.list', { projectId: 'p-one' }) as { project_id: string }[];
    assert.ok(result.length >= 2); assert.ok(result.every(t => t.project_id === 'p-one'));
    authorizeWorkerRpc(f.coord, f.identity, 'task.get', { id: f.sibling.id });
    for (const [method, params] of [
      ['task.list', {}], ['task.list', { projectId: null }], ['task.list', { projectId: 'p-two' }],
      ['task.get', { id: f.other.id }], ['task.peek', { id: 'missing' }],
      ['task.wait', { ids: [f.task.id, f.other.id] }], ['events.since', { projectId: 'p-one', taskId: f.other.id }],
      ['task.adminUpdate', { id: f.task.id, patch: {} }], ['task.control', { id: f.task.id, action: 'cancel' }],
      ['project.register', { cwd: f.box.repo }], ['project.resolve', { projectId: 'p-one' }], ['project.list', {}],
      ['fleet.pause', { projectId: 'p-one' }], ['fleet.resume', {}], ['token.create', {}], ['pairing.create', {}],
      ['machine.list', {}], ['board.status', { projectId: 'p-one' }], ['clean.run', {}], ['spend.record', {}],
      ['constructor', {}], ['toString', {}], ['future.method', {}],
    ] as [string, unknown][]) assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, method, params), method);
    for (const identity of [undefined, { ...f.identity, kind: 'owner' }, { ...f.identity, machineId: 'm-two' },
      { ...f.identity, projectId: 'p-two' }, { ...f.identity, ownerId: 'stranger' }, { ...f.identity, expiresAt: Infinity }]) {
      assert.throws(() => authorizeWorkerRpc(f.coord, identity as WorkerIdentity, 'task.peek', { id: f.task.id }));
    }
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.peek', { id: f.task.id, payload: 'x'.repeat(100_001) }));
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.peek', Object.create({ id: f.task.id })));
    f.db.prepare('UPDATE fleet_credentials SET expires_at = ? WHERE id = ?').run(Date.now() - 1, f.identity.credentialId);
    assert.throws(() => authorizeWorkerRpc(f.coord, { ...f.identity, expiresAt: Date.now() - 1 }, 'task.peek', { id: f.task.id }));
  } finally { f.db.close(); }
});

test('worker claims and heartbeats bind the paired machine and only its scoped project', () => {
  const f = fixture();
  try {
    const claim = { machineId: 'm-one', agents: ['mock'], repos: { 'p-one': f.box.repo } };
    authorizeWorkerRpc(f.coord, f.identity, 'worker.claim', claim);
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'worker.claim', { ...claim, machineId: 'm-two' }));
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'worker.claim', { ...claim, repos: { 'p-one': f.box.repo, 'p-two': f.box.repo } }));
    const heartbeat = { id: 'm-one', name: 'laptop', info: { repos: { 'p-one': f.box.repo } }, running: [{ taskId: f.task.id, generation: 1, runId: f.run.id }] };
    authorizeWorkerRpc(f.coord, f.identity, 'machine.heartbeat', heartbeat);
    for (const bad of [{ ...heartbeat, id: 'm-two' }, { ...heartbeat, running: [{ taskId: f.task.id }] },
      { ...heartbeat, running: [{ taskId: f.other.id, generation: 1 }] },
      { ...heartbeat, info: { repos: { 'p-two': '/private' } } },
      { ...heartbeat, info: { repos: {}, is_hub: true } }]) {
      assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'machine.heartbeat', bad));
    }
  } finally { f.db.close(); }
});

test('expanded task reads fail closed on owner-created cross-project relationships', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO deps (task_id, depends_on) VALUES (?, ?)').run(f.sibling.id, f.other.id);
    for (const method of ['task.get', 'task.context']) {
      assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, method, { id: f.sibling.id }));
    }
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.wait', { ids: [f.sibling.id] }));
    authorizeWorkerRpc(f.coord, f.identity, 'task.peek', { id: f.sibling.id });
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.update', {
      id: f.task.id, owner: f.claim, patch: { wait_for: f.other.id },
    }));
    f.db.prepare('DELETE FROM deps').run();
    f.coord.updateTask(f.sibling.id, { wait_for: f.other.id });
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.get', { id: f.sibling.id }));
  } finally { f.db.close(); }
});

test('lifecycle writes require a current generation, assignee, task and run on the bound machine', async () => {
  const f = fixture();
  try {
    const good = { id: f.task.id, owner: f.claim, patch: { summary: 'scoped worker update' } };
    authorizeWorkerRpc(f.coord, f.identity, 'task.update', good);
    await dispatch(buildMethods(f.coord, { machineId: 'm-hub' }), 'task.update', good);
    assert.equal(f.coord.getTask(f.task.id)!.summary, 'scoped worker update');
    for (const bad of [{ ...good, owner: undefined }, { ...good, owner: { assignee: 'machine:m-one' } },
      { ...good, owner: { generation: 0, assignee: 'machine:m-one' } },
      { ...good, owner: { generation: 2, assignee: 'machine:m-one' } },
      { ...good, owner: { generation: 1, assignee: 'machine:m-two' } },
      { ...good, id: f.sibling.id }, { ...good, id: f.other.id },
      { ...good, patch: { generation: 2 } }, { ...good, patch: { approved: true } },
      { ...good, patch: { project_id: 'p-two' } }, { ...good, patch: { assignee: 'machine:m-two' } },
      { ...good, patch: { machine_id: 'm-two' } }, { ...good, patch: { status: 'done' } },
      { ...good, owner: { ...f.claim, statuses: ['canceled'] } }]) {
      assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.update', bad));
    }
    const usage = { id: f.task.id, runId: f.run.id, owner: f.claim, costUsd: 1, tokensIn: 2, tokensOut: 3 };
    authorizeWorkerRpc(f.coord, f.identity, 'task.usage', usage);
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.usage', { ...usage, id: f.sibling.id }));
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.usage', { ...usage, runId: 'r-missing' }));
    authorizeWorkerRpc(f.coord, f.identity, 'run.update', { runId: f.run.id, owner: f.claim, patch: { pid: 123, proc_started: Date.now() } });
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'run.update', { runId: f.run.id, owner: f.claim, patch: { machine_id: 'm-two' } }));
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'run.start', { taskId: f.task.id, machineId: 'm-two', owner: f.claim }));
    f.coord.updateTask(f.task.id, { lease_until: Date.now() - 1 });
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.update', good));
    f.coord.updateTask(f.task.id, { lease_until: Date.now() + 60_000 });
    fakedGeneration(f.db, f.task.id, 2);
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'run.log', { runId: f.run.id, owner: { ...f.claim, generation: 2 }, lines: [] }));
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'task.update', good));
    fakedGeneration(f.db, f.task.id, 1);
    f.coord.updateTask(f.task.id, { status: 'canceled' });
    authorizeWorkerRpc(f.coord, f.identity, 'run.update', { runId: f.run.id, owner: f.claim, patch: { status: 'stopped' } });
  } finally { f.db.close(); }
});

test('stale paired heartbeat entries do not prevent healthy claim renewal', async () => {
  const f = fixture();
  try {
    f.coord.updateTask(f.sibling.id, { status: 'running', machine_id: 'm-one', assignee: 'machine:m-one', lease_until: Date.now() + 1000 });
    fakedGeneration(f.db, f.sibling.id, 1);
    f.coord.control(f.task.id, 'cancel', 'test');
    const request = { id: 'm-one', name: 'worker', info: { repos: { 'p-one': f.box.repo } },
      running: [{ taskId: f.task.id, generation: 1 }, { taskId: f.sibling.id, generation: 1 }] };
    authorizeWorkerRpc(f.coord, f.identity, 'machine.heartbeat', request);
    const result = await dispatch(buildMethods(f.coord, { machineId: 'm-hub' }), 'machine.heartbeat', request) as { controls: { taskId: string; renewed: boolean }[] };
    assert.equal(result.controls.find(c => c.taskId === f.task.id)!.renewed, false);
    assert.equal(result.controls.find(c => c.taskId === f.sibling.id)!.renewed, true);
    assert.ok(f.coord.getTask(f.sibling.id)!.lease_until! > Date.now() + 30_000);
    for (const method of ['run.update', 'run.log']) {
      const params = { runId: f.run.id, owner: f.claim, patch: { status: 'stopped' }, lines: ['cancel acknowledged'] };
      authorizeWorkerRpc(f.coord, f.identity, method, params);
      await dispatch(buildMethods(f.coord, { machineId: 'm-hub' }), method, params);
    }
  } finally { f.db.close(); }
});

test('historical run usage has only its recorded run identity; it grants no stale lifecycle rights', () => {
  const f = fixture();
  try {
    fakedGeneration(f.db, f.task.id, 2);
    f.coord.updateTask(f.task.id, { machine_id: 'm-two', assignee: 'machine:m-two', status: 'running' });
    const usage = { runId: f.run.id, taskId: f.task.id, owner: f.claim };
    authorizeWorkerRpc(f.coord, f.identity, 'run.usage', usage);
    for (const bad of [{ ...usage, owner: undefined }, { ...usage, owner: { ...f.claim, generation: 2 } },
      { ...usage, taskId: f.other.id }, { ...usage, runId: 'r-missing' }, { ...usage, owner: { generation: 1, assignee: 'machine:m-two' } }]) {
      assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'run.usage', bad));
    }
    for (const method of ['run.update', 'run.log', 'task.touched', 'lesson.outcome']) {
      assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, method, { ...usage, patch: {} }));
    }
    f.db.prepare('UPDATE runs SET machine_id = ? WHERE id = ?').run('m-two', f.run.id);
    assert.throws(() => authorizeWorkerRpc(f.coord, f.identity, 'run.usage', usage));
  } finally { f.db.close(); }
});

test('base bundle scope and upload machine, generation, branch and accepted SHA are checked', () => {
  const f = fixture();
  try {
    authorizeWorkerBaseBundle(f.coord, f.identity, 'p-one');
    assert.throws(() => authorizeWorkerBaseBundle(f.coord, f.identity, 'p-two'));
    const head = 'a'.repeat(40); const branch = 'yardmaster/task';
    f.coord.updateTask(f.task.id, { status: 'ready', head_sha: head, branch });
    const upload = { taskId: f.task.id, machineId: 'm-one', generation: 1, head, branch };
    authorizeWorkerUpload(f.coord, f.identity, upload);
    for (const bad of [{ ...upload, taskId: f.other.id }, { ...upload, machineId: 'm-two' }, { ...upload, generation: 2 },
      { ...upload, generation: NaN }, { ...upload, head: 'b'.repeat(40) }, { ...upload, branch: 'other' }]) {
      assert.throws(() => authorizeWorkerUpload(f.coord, f.identity, bad));
    }
    f.store.revokeCredential(owner, f.identity.credentialId);
    assert.throws(() => authorizeWorkerUpload(f.coord, f.identity, upload));
  } finally { f.db.close(); }
});

test('PairingStore construction never migrates an unmigrated database', () => {
  const db = openDb(':memory:');
  try {
    // Parent integration may already have appended this migration by the time these tests run.
    db.exec('DROP TABLE IF EXISTS fleet_credentials; DROP TABLE IF EXISTS fleet_invitations');
    db.exec('PRAGMA query_only = ON');
    const store = new PairingStore(db, { ownerId: owner.ownerId });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fleet_credentials'").get(), undefined);
    assert.throws(() => store.listCredentials(owner), /no such table/);
  } finally { db.close(); }
});
