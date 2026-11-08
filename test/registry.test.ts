import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { buildRegistry, registryMigrationDDL } from '../src/registry.ts';

const now = 1_800_000_000_000;
function fixture() {
  const db = openDb(':memory:');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs_registry_live'").get()) db.exec(registryMigrationDDL);
  for (const p of ['p-one', 'p-two']) db.prepare('INSERT INTO projects (id, name, root, base_branch, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(p, p, `/fixture/${p}`, 'main', now);
  const machine = (id: string, projects: string[], agents: string[], seen = now - 1000) => {
    const repos = Object.fromEntries(projects.map(p => [p, `/private/${p}`]));
    db.prepare('INSERT INTO machines (id, name, info, last_seen) VALUES (?, ?, ?, ?)')
      .run(id, id, JSON.stringify({ repos, agents }), seen);
  };
  const task = (id: string, projectId: string, machineId: string, options: { generation?: number; status?: string; assignee?: string } = {}) => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, fingerprint, status, tier, max_attempts, created_by,
      created_at, updated_at, machine_id, assignee, generation, lease_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, id, 'private prompt', id, options.status ?? 'running', 'standard', 3, 'fixture', now, now,
        machineId, options.assignee ?? `machine:${machineId}`, options.generation ?? 1, now + 60_000);
  };
  const run = (id: string, taskId: string, machineId: string, options: {
    role?: string; status?: string; generation?: number; started?: number; pid?: number | null; ended?: number | null;
  } = {}) => {
    db.prepare(`INSERT INTO runs (id, task_id, machine_id, generation, attempt, agent, model, pid, proc_started,
      status, started_at, ended_at, role, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId, machineId, options.generation ?? 1, 1, options.role === 'review' ? 'review-client' : 'codex', 'attested-model',
        options.pid === undefined ? 123 : options.pid, now - 10_000, options.status ?? 'running', options.started ?? now - 5000,
        options.ended ?? null, options.role ?? 'implement', 'last persisted action');
  };
  const session = (id: string, projectId: string | null, machineId: string | null, agent = 'claude', seen = now - 2000) => {
    db.prepare('INSERT INTO sessions (id, name, agent, project_id, machine_id, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, agent, projectId, machineId, seen);
  };
  return { db, machine, task, run, session };
}

test('registry distinguishes managed processes, passive sessions, stale connections and installed clients', () => {
  const f = fixture();
  try {
    f.machine('m-one', ['p-one'], ['codex', 'claude', 'gemini', 'review-client']);
    f.machine('m-old', ['p-one'], ['cursor'], now - 180_000);
    f.task('t-one', 'p-one', 'm-one'); f.run('r-one', 't-one', 'm-one');
    f.run('r-review', 't-one', 'm-one', { role: 'review' });
    f.task('t-old', 'p-one', 'm-old'); f.run('r-old', 't-old', 'm-old');
    f.session('session:live', 'p-one', 'm-one');
    f.session('session:old', 'p-one', 'm-old', 'cursor', now - 180_000);
    const registry = buildRegistry(f.db, { now });
    const entry = (id: string) => registry.entries.find(e => e.id === id)!;
    assert.equal(entry('run:r-one').state, 'managed');
    assert.equal(entry('run:r-one').pid, 123); assert.equal(entry('run:r-one').generation, 1);
    assert.equal(entry('run:r-one').model, 'attested-model');
    assert.equal(entry('run:r-one').capabilities.requestStop, true);
    assert.equal(entry('run:r-review').role, 'review'); assert.equal(entry('run:r-review').state, 'managed');
    assert.equal(entry('session:session:live').state, 'observed');
    assert.deepEqual(entry('session:session:live').capabilities, { inspect: true, requestStop: false, nativeStop: false });
    assert.equal(entry('run:r-old').state, 'stale'); assert.equal(entry('run:r-old').online, false);
    assert.equal(entry('run:r-old').capabilities.requestStop, false);
    assert.equal(entry('session:session:old').state, 'stale');
    assert.equal(entry('installed:m-one:gemini').state, 'unconnected');
    assert.equal(entry('installed:m-one:gemini').pid, null);
    assert.equal(entry('installed:m-one:gemini').capabilities.inspect, false);
    assert.ok(!registry.entries.some(e => e.id === 'installed:m-one:codex'));
    for (const e of registry.entries) {
      assert.equal(e.effort, null); assert.equal(e.phase, null);
      assert.deepEqual(e.cache, { readTokens: null, writeTokens: null });
      assert.equal(e.capabilities.nativeStop, false);
      assert.ok(!('progress' in e));
    }
    assert.equal(registry.coverage.liveRuns, 3);
  } finally { f.db.close(); }
});

test('project filtering excludes other project tasks, sessions, runs and machines including private paths', () => {
  const f = fixture();
  try {
    f.machine('m-shared', ['p-one', 'p-two'], ['codex']);
    f.machine('m-private-two', ['p-two'], ['private-client']);
    f.task('t-one', 'p-one', 'm-shared'); f.run('r-one', 't-one', 'm-shared');
    f.task('t-private-two', 'p-two', 'm-private-two'); f.run('r-private-two', 't-private-two', 'm-private-two', { role: 'review' });
    f.session('session:one', 'p-one', 'm-shared');
    f.session('session:private-two', 'p-two', 'm-private-two');
    f.session('session:unscoped', null, 'm-private-two');
    const registry = buildRegistry(f.db, { now, projectId: 'p-one' });
    assert.ok(registry.entries.length > 0);
    assert.ok(registry.entries.every(e => e.projectId === 'p-one'));
    assert.doesNotMatch(JSON.stringify(registry), /p-two|private-two|private-client|unscoped|\/private\/|private prompt/);
    const missing = buildRegistry(f.db, { now, projectId: 'p-missing' });
    assert.deepEqual(missing.entries, []);
    assert.throws(() => buildRegistry(f.db, { now, projectId: '' }));
  } finally { f.db.close(); }
});

test('live review rows remain visible even without a PID and with history/passive inventory caps', () => {
  const f = fixture();
  try {
    f.machine('m-one', ['p-one'], ['codex']); f.task('t-one', 'p-one', 'm-one');
    for (let i = 0; i < 8; i++) f.run(`r-review-${i}`, 't-one', 'm-one', { role: 'review', pid: null });
    for (let i = 0; i < 12; i++) f.run(`r-history-${i}`, 't-one', 'm-one', { status: 'succeeded', started: now - 5000 - i, ended: now - 1000 });
    for (let i = 0; i < 4; i++) f.session(`session:${i}`, 'p-one', 'm-one');
    const registry = buildRegistry(f.db, { now, projectId: 'p-one', historyLimit: 2, inventoryLimit: 1 });
    assert.equal(registry.coverage.liveRuns, 8); assert.equal(registry.coverage.recentRuns, 2);
    assert.equal(registry.coverage.sessionsTruncated, true);
    assert.equal(registry.entries.filter(e => e.role === 'review').length, 8);
    assert.equal(registry.entries.filter(e => e.source === 'run' && e.status !== 'running').length, 2);
    assert.ok(registry.entries.filter(e => e.role === 'review').every(e => e.pid === null && !e.capabilities.requestStop));
    assert.equal(buildRegistry(f.db, { now, historyLimit: 0 }).coverage.recentRuns, 0);
    assert.throws(() => buildRegistry(f.db, { historyLimit: 501 }));
    assert.throws(() => buildRegistry(f.db, { inventoryLimit: Infinity }));
  } finally { f.db.close(); }
});

test('stale generation, expired lease, missing machine and future heartbeat never promise process control', () => {
  const f = fixture();
  try {
    f.machine('m-one', ['p-one'], ['codex']);
    f.machine('m-future', ['p-one'], ['codex'], now + 1000);
    f.task('t-superseded', 'p-one', 'm-one', { generation: 2 }); f.run('r-stale', 't-superseded', 'm-one');
    f.task('t-missing', 'p-one', 'm-unknown'); f.run('r-missing', 't-missing', 'm-unknown');
    f.task('t-future', 'p-one', 'm-future'); f.run('r-future', 't-future', 'm-future');
    f.task('t-expired', 'p-one', 'm-one'); f.run('r-expired', 't-expired', 'm-one');
    f.db.prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(now, 't-expired');
    const registry = buildRegistry(f.db, { now });
    const runs = registry.entries.filter(e => e.source === 'run');
    assert.equal(runs.length, 4);
    assert.ok(runs.every(e => e.state === 'stale' && !e.capabilities.requestStop));
    assert.equal(runs.find(e => e.runId === 'r-missing')!.online, null);
    assert.equal(runs.find(e => e.runId === 'r-future')!.freshness, 'unknown');
    assert.equal(runs.find(e => e.runId === 'r-stale')!.lastSeenAt, now - 1000);
  } finally { f.db.close(); }
});

test('hooked session claims expose task and generation without acquiring destructive controls', () => {
  const f = fixture();
  try {
    f.machine('m-one', ['p-one'], ['claude']); f.session('session:one', 'p-one', 'm-one');
    f.task('t-one', 'p-one', 'm-one', { assignee: 'session:one', generation: 3 });
    f.task('t-two', 'p-one', 'm-one', { assignee: 'session:one', generation: 4 });
    const sessions = buildRegistry(f.db, { now, projectId: 'p-one' }).entries.filter(e => e.source === 'session');
    assert.deepEqual(sessions.map(e => [e.taskId, e.generation]), [['t-one', 3], ['t-two', 4]]);
    assert.ok(sessions.every(e => e.state === 'observed' && !e.capabilities.requestStop && e.pid === null && e.model === null));
  } finally { f.db.close(); }
});

test('corrupt machine info is ignored and registry reads never perform DDL or read native transcripts', () => {
  const f = fixture();
  try {
    f.machine('m-one', ['p-one'], ['codex']); f.task('t-one', 'p-one', 'm-one'); f.run('r-one', 't-one', 'm-one');
    f.db.prepare('UPDATE machines SET info = ? WHERE id = ?').run('{bad-json', 'm-one');
    f.db.exec('PRAGMA query_only = ON');
    const registry = buildRegistry(f.db, { now, projectId: 'p-one' });
    assert.equal(registry.entries.length, 1); assert.equal(registry.entries[0]!.runId, 'r-one');
    assert.ok(registry.coverage.unknownSignals.includes('unbridged native hosts'));
    // Boundaries use strict less-than: exactly staleAfterMs old is stale.
    const stale = buildRegistry(f.db, { now: now + 119_000 });
    assert.equal(stale.entries[0]!.freshness, 'stale');
  } finally { f.db.close(); }
});
