import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { warmStart, lockHash, refreshDeps, clonesAreFree } from '../src/warmstart.ts';
import { WorkerLoop } from '../src/worker.ts';
import { scanDeps } from '../src/devdeps.ts';
import { Semaphore } from '../src/runner.ts';
import type { Client } from '../src/api.ts';
import { invalidateSize } from '../src/disk.ts';
import { sandbox, sh } from './helpers.ts';

function dependencyFixture(nested = false) {
  const box = sandbox();
  const rel = nested ? 'packages/tool' : '';
  mkdirSync(join(box.repo, rel, 'node_modules'), { recursive: true });
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(box.repo, 'package-lock.json'), 'root-lock');
  if (nested) writeFileSync(join(box.repo, rel, 'package-lock.json'), 'nested-lock');
  writeFileSync(join(box.repo, rel, 'node_modules', 'installed'), 'installed');
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-qm', 'lockfiles']);
  const worktree = join(box.root, 'worktrees', 'task');
  sh(box.repo, 'git', ['worktree', 'add', '-q', '-b', 'task', worktree]);
  return { ...box, worktree, rel };
}

test('disk accounting includes newly installed and rewritten dependency trees on clone-capable disks', async () => {
  const box = sandbox();
  const root = join(box.root, 'worktrees');
  const deps = join(root, 'project', 'task', 'node_modules');
  mkdirSync(deps, { recursive: true });
  writeFileSync(join(deps, 'fresh'), Buffer.alloc(256 * 1024, 1));
  const bin = join(box.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cp'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'cp'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const worker = new WorkerLoop({ client: {} as Client, machineId: 'fixture', repos: () => ({}), agents: () => [],
    localConfig: () => loadConfig(), verifySlots: new Semaphore(1) });
  try {
    assert.equal(await clonesAreFree(root), true, 'fixture forces clone support on either CI filesystem');
    assert.ok((await worker.disk()).worktreesGb >= 256 * 1024 / 1e9);
    writeFileSync(join(deps, 'fresh'), Buffer.alloc(512 * 1024, 2));
    invalidateSize(root);
    assert.ok((await worker.disk()).worktreesGb >= 512 * 1024 / 1e9);
  } finally { process.env.PATH = oldPath; }
});

test('warm start rejects stale root locks with an accurate skip note', async () => {
  const box = dependencyFixture();
  writeFileSync(join(box.worktree, 'package-lock.json'), 'updated-lock');
  const result = await warmStart(box.repo, box.worktree, loadConfig());
  assert.equal(result.source, null);
  assert.equal(result.stale, true);
  assert.deepEqual(result.cloned, []);
  assert.match(result.skipped[0]!.why, /dependencies were not reused/);
  assert.equal(existsSync(join(box.worktree, 'node_modules')), false);
});

for (const change of ['changed', 'added', 'removed'] as const) test(`warm start rejects ${change} nested independent lockfiles`, async () => {
  const box = dependencyFixture(change !== 'added');
  mkdirSync(join(box.worktree, 'packages/tool'), { recursive: true });
  const lock = join(box.worktree, 'packages/tool/package-lock.json');
  if (change === 'removed') rmSync(lock);
  else writeFileSync(lock, 'different-lock');
  assert.notEqual(lockHash(box.repo), lockHash(box.worktree));
  const result = await warmStart(box.repo, box.worktree, loadConfig());
  assert.equal(result.source, null);
  assert.equal(result.stale, true);
  assert.deepEqual(result.cloned, []);
});

test('matching nested installs are reused and refresh notices nested lock changes', async () => {
  const box = dependencyFixture(true);
  const config = loadConfig();
  const result = await warmStart(box.repo, box.worktree, config);
  assert.equal(result.stale, false);
  assert.equal(result.source, box.repo);
  assert.deepEqual(result.cloned.map(dir => dir.rel), ['packages/tool/node_modules']);
  const known = lockHash(box.worktree);
  assert.equal(await refreshDeps(box.repo, box.worktree, config, known, []), null);
  writeFileSync(join(box.worktree, 'packages/tool/package-lock.json'), 'changed');
  const refreshed = await refreshDeps(box.repo, box.worktree, config, known, []);
  assert.equal(refreshed?.stale, true);
  assert.equal(existsSync(join(box.worktree, 'packages/tool/node_modules')), false);
});

test('disk accounting still counts dependencies after warm-start and an in-place package rewrite', async () => {
  const box = dependencyFixture();
  const config = loadConfig();
  await warmStart(box.repo, box.worktree, config);
  const deps = join(box.worktree, 'node_modules');
  writeFileSync(join(deps, 'installed'), Buffer.alloc(512 * 1024, 3));
  const worker = new WorkerLoop({ client: {} as Client, machineId: 'fixture', repos: () => ({}), agents: () => [],
    localConfig: () => config, verifySlots: new Semaphore(1) });
  assert.ok((await worker.disk()).worktreesGb >= 512 * 1024 / 1e9);
});

test('warm start skips dependencies with no lockfiles instead of guessing compatibility', async () => {
  const box = dependencyFixture();
  rmSync(join(box.repo, 'package-lock.json'));
  rmSync(join(box.worktree, 'package-lock.json'));
  const result = await warmStart(box.repo, box.worktree, loadConfig());
  assert.equal(result.source, null);
  assert.equal(result.stale, true);
  assert.deepEqual(result.cloned, []);
});

test('migration 14 upgrades a v13 database without data loss and removes the global completion sort', () => {
  const box = sandbox();
  const path = join(box.root, 'migration.db');
  let db = openDb(path);
  db.exec("DROP INDEX tasks_status_finished; UPDATE meta SET value = '13' WHERE key = 'schema_version'; INSERT INTO projects VALUES ('preserved', 'Existing', '/repo', 'main', 1)");
  db.close();
  db = openDb(path);
  try {
    assert.equal(db.prepare("SELECT name FROM projects WHERE id = 'preserved'").get()?.name, 'Existing');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, '14');
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status = ? ORDER BY finished_at DESC LIMIT ?').all('done', 10);
    assert.match(JSON.stringify(plan), /tasks_status_finished/);
    assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
  } finally { db.close(); }
});

test('nested symlink lockfiles participate in compatibility checks', async () => {
  const box = dependencyFixture(true);
  for (const root of [box.repo, box.worktree]) {
    rmSync(join(root, 'packages/tool/package-lock.json'));
    writeFileSync(join(root, 'lock-snapshot'), root === box.repo ? 'old' : 'new');
    symlinkSync('../../lock-snapshot', join(root, 'packages/tool/package-lock.json'));
  }
  assert.notEqual(lockHash(box.repo), lockHash(box.worktree));
  const result = await warmStart(box.repo, box.worktree, loadConfig());
  assert.equal(result.source, null);
  assert.deepEqual(result.cloned, []);
});

test('an unreadable candidate never yields a partial matching fingerprint or aborts disk scanning', async t => {
  if (process.getuid?.() === 0) { t.skip('root bypasses directory permissions'); return; }
  const box = dependencyFixture();
  const unreadable = join(box.repo, 'unrelated-output');
  mkdirSync(unreadable);
  chmodSync(unreadable, 0);
  try {
    assert.equal(lockHash(box.repo), '');
    assert.notEqual(lockHash(box.repo), lockHash(box.worktree));
    const result = await warmStart(box.repo, box.worktree, loadConfig());
    assert.equal(result.source, null);
    assert.deepEqual(result.cloned, []);
    const scan = await scanDeps([box.repo]);
    assert.equal(scan.dirs.length, 1);
    assert.equal(scan.dirs[0]!.lock, '');
    assert.deepEqual(scan.identical, []);
  } finally { chmodSync(unreadable, 0o755); }
});
