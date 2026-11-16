import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { cloneDependency, worktreeBytes } from '../src/dependency-disk.ts';
import { dirBytesMany, invalidateSize } from '../src/disk.ts';
import { resolveConfig } from '../src/config.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Integrator } from '../src/integrator.ts';
import { openDb } from '../src/db.ts';
import { Semaphore } from '../src/runner.ts';
import type { Project } from '../src/types.ts';
import { sandbox, sh, afterChanges } from './helpers.ts';

function command(bin: string, name: string, program: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const path = join(bin, name); fs.writeFileSync(path, '#!' + process.execPath + '\n' + program); fs.chmodSync(path, 0o755);
}

function fixture() {
  const box = sandbox(); const root = join(box.root, 'worktrees'); const source = join(box.repo, 'node_modules');
  fs.mkdirSync(source); fs.writeFileSync(join(source, 'package'), Buffer.alloc(512 * 1024, 1));
  const settled = afterChanges(source);
  const clone = async (name: string) => { await settled; return cloneDependency(source, join(root, name, 'node_modules'), async () => {
    fs.cpSync(source, join(root, name, 'node_modules'), { recursive: true });
    return { ok: true, method: 'cp-reflink', ms: 0 };
  }); };
  return { ...box, root, source, clone };
}

test('unchanged tracked manifests preserve lockless integration dependencies and setup markers', async () => {
  const box = sandbox(); fs.writeFileSync(join(box.repo, 'package.json'), '{"version":"1"}');
  sh(box.repo, 'git', ['add', 'package.json']); sh(box.repo, 'git', ['commit', '-qm', 'manifest']);
  const path = join(box.root, 'merge'); sh(box.repo, 'git', ['worktree', 'add', '-qb', 'merge', path]);
  const config = resolveConfig([{ worktree: { setup: ['node -e "require(\'node:fs\').appendFileSync(\'setup-runs\', \'x\')"'] } }]);
  const db = openDb(':memory:'); const coord = new Coordinator(db); const integrator = new Integrator(coord, new Semaphore(1));
  try {
    const project = await coord.registerProject(box.repo);
    const prepare = () => (integrator as unknown as { prepareDeps(project: Project, path: string, config: typeof config, prefer: string[]): Promise<void> }).prepareDeps(project, path, config, []);
    await prepare();
    fs.mkdirSync(join(path, 'node_modules')); fs.writeFileSync(join(path, 'node_modules/retained'), 'installed');
    await prepare();
    assert.equal(fs.readFileSync(join(path, 'setup-runs'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(join(path, 'node_modules/retained'), 'utf8'), 'installed');
    fs.writeFileSync(join(path, 'package.json'), '{"version":"2"}'); await prepare();
    assert.equal(fs.readFileSync(join(path, 'setup-runs'), 'utf8'), 'xx');
  } finally { await integrator.stop(); db.close(); }
});

test('a numeric du total remains usable after a partial scan exits nonzero', async t => {
  const box = sandbox(); const paths = ['a', 'b'].map(name => join(box.root, name));
  for (const path of paths) { fs.mkdirSync(path); fs.writeFileSync(join(path, 'file'), Buffer.alloc(128 * 1024)); }
  command(join(box.root, 'bin'), 'du', "console.log('4\\ttotal');process.exit(1);");
  const previousPath = process.env.PATH; process.env.PATH = join(box.root, 'bin') + ':' + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  assert.equal(await dirBytesMany(paths), 4096);
});

test('missing du output falls back through asynchronous filesystem reads', async t => {
  const box = sandbox(); const paths = ['a', 'b'].map(name => join(box.root, name));
  for (const path of paths) { fs.mkdirSync(path); fs.writeFileSync(join(path, 'file'), Buffer.alloc(128)); }
  command(join(box.root, 'bin'), 'du', 'process.exit(1);');
  const previousPath = process.env.PATH; process.env.PATH = join(box.root, 'bin') + ':' + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  let synchronous = 0; const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (paths.includes(String(args[0]))) synchronous++;
    return readdir(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await dirBytesMany(paths), 256);
  assert.equal(await dirBytesMany([paths[0]!]), 128);
  assert.equal(synchronous, 0);
});

test('concurrent clones retain one source cohort when the source disappears', async () => {
  const box = fixture();
  await Promise.all([box.clone('a'), box.clone('b')]);
  fs.rmSync(box.source, { recursive: true }); invalidateSize(box.root);
  const bytes = await worktreeBytes(box.root, ['node_modules']);
  assert.ok(bytes >= 512 * 1024 && bytes < 768 * 1024, `one surviving install should be charged, got ${bytes}`);
});

test('source proof markers survive OS temporary-directory cleanup', async t => {
  const box = fixture(); const created: string[] = []; const mkdtemp = fsp.mkdtemp.bind(fsp);
  t.mock.method(fsp, 'mkdtemp', async (...args: Parameters<typeof fsp.mkdtemp>) => {
    const path = await mkdtemp(...args); created.push(String(path)); return path;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await box.clone('a');
  const proof = created.find(path => fs.existsSync(join(path, 'started')));
  assert.ok(proof?.startsWith(box.home + '/'), `proof must live under Yardmaster state, got ${proof}`);
});

test('healthy source monitors avoid minute-by-minute deep scans and share a ten-minute guard', async t => {
  const box = fixture(); const log = join(box.root, 'find-count');
  command(join(box.root, 'bin'), 'find', `import {appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';appendFileSync(${JSON.stringify(log)}, 'x');const r=spawnSync('/usr/bin/find',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);`);
  const previousPath = process.env.PATH; process.env.PATH = join(box.root, 'bin') + ':' + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  await box.clone('a'); await box.clone('b');
  const initial = fs.readFileSync(log, 'utf8').length; const now = Date.now();
  let time = now; t.mock.method(Date, 'now', () => time);
  for (let minute = 1; minute < 10; minute++) { time = now + minute * 60_000; invalidateSize(box.root); await worktreeBytes(box.root, ['node_modules']); }
  assert.equal(fs.readFileSync(log, 'utf8').length, initial);
  time = now + 600_001; invalidateSize(box.root); await worktreeBytes(box.root, ['node_modules']);
  assert.equal(fs.readFileSync(log, 'utf8').length, initial + 1);
});

test('source notifications at exactly the proof ctime boundary reject the exemption', async t => {
  const box = fixture(); let boundary = 0n; let marker = ''; let notify: (() => void) | undefined;
  const lstat = fsp.lstat.bind(fsp);
  t.mock.method(fsp, 'lstat', async (...args: Parameters<typeof fsp.lstat>) => {
    const st = await lstat(...args);
    if (String(args[0]).endsWith('/started') && !marker) { boundary = (st as fs.BigIntStats).mtimeNs; marker = String(args[0]); }
    if (String(args[0]) === join(box.source, 'package') && boundary) return { ...st, ctimeNs: boundary };
    return st;
  });
  t.mock.method(fs, 'watch', (path: fs.PathLike, options: fs.WatchOptions, callback: fs.WatchListener<string>) => {
    if (String(path) === box.source) notify = () => callback('change', 'package');
    const watcher = new EventEmitter();
    return Object.assign(watcher, { close() { watcher.emit('close'); }, unref() { return watcher; } });
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await cloneDependency(box.source, join(box.root, 'a/node_modules'), async () => {
    fs.cpSync(box.source, join(box.root, 'a/node_modules'), { recursive: true });
    assert.ok(fs.statSync(marker, { bigint: true }).mtimeNs < boundary, 'native find must include writes at the boundary');
    assert.ok(notify); notify(); await new Promise<void>(resolve => setImmediate(resolve));
    return { ok: true, method: 'cp-reflink', ms: 0 };
  });
  assert.ok(await worktreeBytes(box.root, ['node_modules']) >= 512 * 1024);
});
