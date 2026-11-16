import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneDependency, worktreeBytes } from '../src/dependency-disk.ts';
import { warmStart, lockHash } from '../src/warmstart.ts';
import { invalidateSize } from '../src/disk.ts';
import { resolveConfig } from '../src/config.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Integrator } from '../src/integrator.ts';
import { openDb } from '../src/db.ts';
import { Semaphore } from '../src/runner.ts';
import type { Project } from '../src/types.ts';
import { sandbox, sh, until, afterChanges } from './helpers.ts';

for (const change of ['removed', 'replaced', 'rewritten'] as const) test(`clones retain one charged install when their source is ${change}`, async () => {
  const box = sandbox();
  const root = join(box.root, 'worktrees');
  const source = join(root, 'a/node_modules');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package'), Buffer.alloc(512 * 1024, 1));
  await afterChanges(source);
  for (const name of ['b', 'c']) {
    const target = join(root, name, 'node_modules');
    await cloneDependency(source, target, async () => {
      cpSync(source, target, { recursive: true }); return { ok: true, method: 'cp-reflink', ms: 0 };
    });
  }
  const initial = await worktreeBytes(root, ['node_modules']);
  assert.ok(initial >= 512 * 1024 && initial < 768 * 1024);
  if (change !== 'rewritten') rmSync(source, { recursive: true });
  else writeFileSync(join(source, 'package'), Buffer.alloc(512 * 1024, 3));
  if (change === 'replaced') {
    mkdirSync(source); writeFileSync(join(source, 'replacement'), Buffer.alloc(512 * 1024, 2));
  }
  invalidateSize(root);
  const expected = change === 'removed' ? 512 * 1024 : 1024 * 1024;
  const bytes = await until(() => worktreeBytes(root, ['node_modules']), bytes => bytes >= expected, 3000, 'a surviving clone to own the original blocks');
  assert.ok(bytes >= expected && bytes < expected + 256 * 1024, 'one unchanged orphan clone must own the old install, without charging every sibling');
});

test('changing package.json reruns setup in a lockless integration worktree', async () => {
  const box = sandbox();
  writeFileSync(join(box.repo, 'package.json'), '{"version":"1"}');
  sh(box.repo, 'git', ['add', 'package.json']); sh(box.repo, 'git', ['commit', '-qm', 'manifest']);
  const path = join(box.root, 'merge');
  sh(box.repo, 'git', ['worktree', 'add', '-qb', 'merge', path]);
  const config = resolveConfig([{ worktree: { setup: ['node -e "require(\'node:fs\').appendFileSync(\'setup-runs\', \'x\')"'] } }]);
  const db = openDb(':memory:'); const coord = new Coordinator(db); const integrator = new Integrator(coord, new Semaphore(1));
  try {
    const project = await coord.registerProject(box.repo);
    const prepare = () => (integrator as unknown as { prepareDeps(project: Project, path: string, config: typeof config, prefer: string[]): Promise<void> }).prepareDeps(project, path, config, []);
    await prepare();
    writeFileSync(join(path, 'package.json'), '{"version":"2"}');
    await prepare();
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(path, 'setup-runs'), 'utf8'), 'xx');
  } finally { await integrator.stop(); db.close(); }
});

test('a real submodule lock mismatch prevents copying its dependencies', async () => {
  const box = sandbox();
  const sub = join(box.root, 'subrepo'); mkdirSync(sub);
  sh(sub, 'git', ['init', '-qb', 'main']);
  writeFileSync(join(sub, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(sub, 'package-lock.json'), 'original-lock');
  sh(sub, 'git', ['add', '-A']); sh(sub, 'git', ['commit', '-qm', 'submodule dependency lock']);
  sh(box.repo, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sub']);
  writeFileSync(join(box.repo, 'package-lock.json'), 'same-root-lock');
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  sh(box.repo, 'git', ['add', '-A']); sh(box.repo, 'git', ['commit', '-qm', 'real submodule']);
  const path = join(box.root, 'task'); sh(box.repo, 'git', ['worktree', 'add', '-qb', 'task', path]);
  sh(path, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
  mkdirSync(join(box.repo, 'node_modules'), { recursive: true });
  writeFileSync(join(box.repo, 'node_modules/root-package'), 'installed');
  mkdirSync(join(box.repo, 'sub/node_modules'), { recursive: true });
  writeFileSync(join(box.repo, 'sub/node_modules/package'), 'installed');
  writeFileSync(join(path, 'sub/package-lock.json'), 'different-submodule-lock');
  assert.notEqual(await lockHash(box.repo), await lockHash(path));
  const result = await warmStart(box.repo, path, resolveConfig([{}]));
  assert.deepEqual(result.cloned, []);
  assert.equal(result.stale, true);
});

test('disk accounting does not add an unbounded JavaScript walk through unrelated trees', async t => {
  const box = sandbox();
  const root = join(box.root, 'worktrees');
  const deep = join(root, 'unrelated/a/b/c/d/node_modules');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'payload'), Buffer.alloc(512 * 1024, 1));
  let reads = 0;
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]).startsWith(join(root, 'unrelated'))) reads++;
    return readdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok(await worktreeBytes(root, ['node_modules']) >= 512 * 1024);
  assert.equal(reads, 0);
});

test('losing a clone exemption invalidates an earlier empty-root measurement', async () => {
  const box = sandbox();
  const root = join(box.root, 'worktrees'); mkdirSync(root);
  assert.ok(await worktreeBytes(root, ['node_modules']) < 128 * 1024);
  const source = join(box.repo, 'node_modules'); mkdirSync(source);
  writeFileSync(join(source, 'package'), Buffer.alloc(512 * 1024, 1));
  const target = join(root, 'task/node_modules');
  await cloneDependency(source, target, async () => {
    cpSync(source, target, { recursive: true }); return { ok: true, method: 'cp-reflink', ms: 0 };
  });
  assert.ok(await worktreeBytes(root, ['node_modules']) < 128 * 1024);
  writeFileSync(join(target, 'package'), Buffer.alloc(768 * 1024, 2));
  await until(() => worktreeBytes(root, ['node_modules']), bytes => bytes >= 768 * 1024, 3000, 'cached root size to include the rewritten install');
});

test('Linux monitoring uses one watch per directory and shares the source monitor', { skip: process.platform !== 'linux' }, async () => {
  const count = () => readdirSync('/proc/self/fdinfo').reduce((sum, fd) => {
    try { return sum + (readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^inotify wd:/gm) ?? []).length; }
    catch { return sum; }
  }, 0);
  const box = sandbox(); const root = join(box.root, 'worktrees');
  const source = join(root, 'a/node_modules'); mkdirSync(source, { recursive: true });
  for (let dir = 0; dir < 100; dir++) {
    const path = join(source, 'pkg' + dir); mkdirSync(path);
    for (let file = 0; file < 10; file++) writeFileSync(join(path, 'file' + file), 'fixture');
  }
  const before = count(); const rss = process.memoryUsage().rss; const start = performance.now();
  for (const name of ['b', 'c']) {
    const target = join(root, name, 'node_modules');
    await cloneDependency(source, target, async () => {
      cpSync(source, target, { recursive: true }); return { ok: true, method: 'cp-reflink', ms: 0 };
    });
  }
  const added = count() - before;
  console.log(JSON.stringify({ kind: 'dependency-monitor-cost', node: process.version, directories: 303,
    files: 3000, inotifyWatches: added, setupMs: performance.now() - start, rssDeltaBytes: process.memoryUsage().rss - rss }));
  assert.ok(added > 0 && added <= 303, 'files must not get their own watches and sibling clones must share the source monitor');
  writeFileSync(join(root, 'b/node_modules/pkg0/file0'), 'rewritten');
  await until(async () => { await worktreeBytes(root, ['node_modules']); return count() - before; }, watches => watches <= 202, 3000, 'rewritten clone monitor to close');
  rmSync(root, { recursive: true });
  await until(count, watches => watches <= before, 3000, 'all task watches to close');
});

test('a source write after its file was copied prevents a clone exemption', async () => {
  const box = sandbox();
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(box.repo, 'package-lock.json'), 'same-lock');
  mkdirSync(join(box.repo, 'node_modules')); writeFileSync(join(box.repo, 'node_modules/package'), Buffer.alloc(512 * 1024, 1));
  sh(box.repo, 'git', ['add', '-A']); sh(box.repo, 'git', ['commit', '-qm', 'copy race']);
  const root = join(box.root, 'worktrees'); const path = join(root, 'task');
  sh(box.repo, 'git', ['worktree', 'add', '-qb', 'task', path]);
  const bin = join(box.root, 'bin'); mkdirSync(bin);
  const program = '#!' + process.execPath + '\n' + `
import { cpSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [source, target] = process.argv.slice(-2);
if (statSync(source).isDirectory()) {
  cpSync(source, target, {recursive:true});
  writeFileSync(join(source, 'package'), Buffer.alloc(512 * 1024, 2));
} else copyFileSync(source, target);
console.log('0');
`;
  const { chmodSync } = await import('node:fs');
  for (const name of ['cp', 'osascript']) { const file = join(bin, name); writeFileSync(file, program); chmodSync(file, 0o755); }
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const result = await warmStart(box.repo, path, resolveConfig([{}]));
    assert.equal(result.cloned.length, 1);
    assert.equal(readFileSync(join(box.repo, 'node_modules/package'))[0], 2, 'fixture must rewrite the source during copy');
    await until(() => worktreeBytes(root, ['node_modules']), bytes => bytes >= 512 * 1024, 3000, 'copy-raced dependency to be counted');
  } finally { process.env.PATH = previous; }
});

test('a populated source submodule does not prevent reuse of matching root dependencies in a fresh worktree', async () => {
  const box = sandbox(); const sub = join(box.root, 'subrepo'); mkdirSync(sub);
  sh(sub, 'git', ['init', '-qb', 'main']); writeFileSync(join(sub, 'package-lock.json'), 'sub-lock');
  sh(sub, 'git', ['add', '-A']); sh(sub, 'git', ['commit', '-qm', 'sub-lock']);
  sh(box.repo, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sub']);
  writeFileSync(join(box.repo, 'package-lock.json'), 'root-lock'); writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  sh(box.repo, 'git', ['add', '-A']); sh(box.repo, 'git', ['commit', '-qm', 'populated source']);
  mkdirSync(join(box.repo, 'node_modules')); writeFileSync(join(box.repo, 'node_modules/package'), 'ready');
  const path = join(box.root, 'task'); sh(box.repo, 'git', ['worktree', 'add', '-qb', 'task', path]);
  const result = await warmStart(box.repo, path, resolveConfig([{}]));
  assert.equal(result.source, box.repo);
  assert.equal(result.stale, false);
  assert.deepEqual(result.cloned.map(dir => dir.rel), ['node_modules']);
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(join(path, 'sub/node_modules')), false);
});
