import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { warmStart, lockHash, refreshDeps } from '../src/warmstart.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Integrator } from '../src/integrator.ts';
import { openDb } from '../src/db.ts';
import type { Project } from '../src/types.ts';
import { WorkerLoop } from '../src/worker.ts';
import { Semaphore } from '../src/runner.ts';
import type { Client } from '../src/api.ts';
import { sandbox, sh, until } from './helpers.ts';

function fixture(lock = true) {
  const box = sandbox();
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  if (lock) writeFileSync(join(box.repo, 'package-lock.json'), 'tracked-lock');
  mkdirSync(join(box.repo, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(box.repo, 'node_modules/pkg/index.js'), Buffer.alloc(512 * 1024, 1));
  sh(box.repo, 'git', ['add', '-A']); sh(box.repo, 'git', ['commit', '-qm', 'dependencies']);
  const worktree = join(box.root, 'worktrees', 'project', 'task');
  sh(box.repo, 'git', ['worktree', 'add', '-qb', 'task', worktree]);
  const config = loadConfig();
  const worker = new WorkerLoop({ client: {} as Client, machineId: 'fixture', repos: () => ({}), agents: () => [],
    localConfig: () => config, verifySlots: new Semaphore(1) });
  return { ...box, worktree, config, worker };
}

test('untracked agent worktrees, scratch locks and unreadable directories do not block tracked-lock reuse', async () => {
  const box = fixture();
  for (const rel of ['.claude/worktrees/agent', 'scratch', 'submodule']) {
    mkdirSync(join(box.repo, rel), { recursive: true });
    writeFileSync(join(box.repo, rel, 'package-lock.json'), 'untracked-lock');
  }
  const unreadable = join(box.repo, 'unrelated-output'); mkdirSync(unreadable); chmodSync(unreadable, 0);
  try {
    assert.equal(await lockHash(box.repo), await lockHash(box.worktree));
    const result = await warmStart(box.repo, box.worktree, box.config);
    assert.equal(result.source, box.repo);
    assert.equal(result.cloned.length, 1);
  } finally { chmodSync(unreadable, 0o755); }
});

test('configured shared directories are excluded even if they contain tracked lockfiles', async () => {
  const box = fixture();
  mkdirSync(join(box.repo, 'custom-deps'), { recursive: true });
  writeFileSync(join(box.repo, 'custom-deps/package-lock.json'), 'source');
  sh(box.repo, 'git', ['add', 'custom-deps/package-lock.json']);
  sh(box.repo, 'git', ['commit', '-qm', 'shared cache fixture']);
  sh(box.worktree, 'git', ['merge', '--ff-only', 'main']);
  writeFileSync(join(box.worktree, 'custom-deps/package-lock.json'), 'different');
  const config = resolveConfig([{ worktree: { shareDirs: ['node_modules', 'custom-deps'] } }]);
  const result = await warmStart(box.repo, box.worktree, config);
  assert.equal(result.source, box.repo);
  assert.equal(result.cloned.length, 1);
});

test('a lockless merge worktree keeps dependencies on repeated prepares with default setup', async () => {
  const box = fixture(false);
  const first = await refreshDeps(box.repo, box.worktree, box.config, null, []);
  assert.equal(first?.source, box.repo);
  assert.equal(first.stale, true, 'unverified reuse must be reported');
  const installed = join(box.worktree, 'node_modules/pkg/index.js');
  assert.equal(existsSync(installed), true);
  const before = readFileSync(installed);
  const second = await refreshDeps(box.repo, box.worktree, box.config, '', []);
  assert.equal(second, null);
  assert.deepEqual(readFileSync(installed), before);
});

test('an untouched recorded clone is free and an in-place nested rewrite is charged', async () => {
  const box = fixture();
  const result = await warmStart(box.repo, box.worktree, box.config);
  assert.equal(result.cloned.length, 1);
  if (result.cloned[0]!.method === 'cp') {
    assert.ok((await box.worker.disk()).worktreesGb >= 512 * 1024 / 1e9, 'plain copies are charged');
    return;
  }
  assert.ok((await box.worker.disk()).worktreesGb < 128 * 1024 / 1e9, 'untouched clone must not consume the quota');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok((await box.worker.disk()).worktreesGb < 128 * 1024 / 1e9, 'delayed clone-creation events must not invalidate the proof');
  writeFileSync(join(box.worktree, 'node_modules/pkg/index.js'), Buffer.alloc(768 * 1024, 2));
  await until(() => box.worker.disk(), disk => disk.worktreesGb >= 768 * 1024 / 1e9, 3000, 'rewritten clone to be charged');
});

test('the integrator records a lockless reuse warning and preserves merge dependencies across prepares', async () => {
  const box = fixture(false);
  const db = openDb(':memory:');
  const coord = new Coordinator(db);
  const integrator = new Integrator(coord, new Semaphore(1));
  try {
    const project = await coord.registerProject(box.repo);
    const prepare = () => (integrator as unknown as {
      prepareDeps(project: Project, path: string, config: typeof box.config, prefer: string[]): Promise<void>;
    }).prepareDeps(project, box.worktree, box.config, []);
    await prepare();
    const installed = join(box.worktree, 'node_modules/pkg/index.js');
    assert.ok(existsSync(installed));
    assert.ok(coord.eventsSince(0).some(event => event.kind === 'integration.deps_unverified' && /npm ci/.test(event.message)));
    assert.equal(coord.getMeta(`deps:${project.id}`), '');
    await prepare();
    assert.ok(existsSync(installed));
    assert.equal(coord.eventsSince(0).filter(event => event.kind === 'integration.deps_unverified').length, 1);
  } finally { await integrator.stop(); db.close(); }
});
