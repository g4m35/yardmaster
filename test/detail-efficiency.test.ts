import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileTail } from '../src/file-tail.ts';
import { tail } from '../src/text.ts';
import { ArtifactDiffCache, changeSince } from '../src/git.ts';
import { tempDir, sh } from './helpers.ts';

const dir = tempDir('ym-detail-');
process.env.YARDMASTER_HOME = join(dir, 'home');

test('log suffix reads retain line/tail behavior without reading history, including sparse files and UTF-8 boundaries', () => {
  const file = join(dir, 'activity.log');
  for (const text of ['', 'one', 'one\ntwo\n', 'a\n'.repeat(1000) + 'final', 'x'.repeat(300_000) + '\nlast']) {
    writeFileSync(file, text);
    for (const lines of [1, 2, 80, 2000]) assert.equal(fileTail(file, lines), tail(text, lines, 200_000));
  }
  // A sparse history makes whole-file reads fail or allocate a gigabyte; only the suffix matters.
  truncateSync(file, 1024 * 1024 * 1024);
  const suffix = fileTail(file, 80);
  assert.equal(Buffer.byteLength(suffix), 200_000);
  writeFileSync(file, '€'.repeat(100_000));
  const unicode = fileTail(file, 80);
  assert.doesNotMatch(unicode, /�/);
  assert.ok(Buffer.byteLength(unicode) <= 200_000);
  assert.equal(fileTail(join(dir, 'missing'), 80), '');
});

test('artifact cache keys exact commits, isolates mutable copies, bounds entries/bytes, and never caches failures', async () => {
  const repo = join(dir, 'repo'); mkdirSync(repo);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'file'), 'base\n');
  sh(repo, 'git', ['add', '.']); sh(repo, 'git', ['commit', '-qm', 'base']);
  const base = sh(repo, 'git', ['rev-parse', 'HEAD']);
  const heads: string[] = [];
  for (const value of ['first', 'second', 'third']) {
    writeFileSync(join(repo, 'file'), value + '\n');
    sh(repo, 'git', ['commit', '-qam', value]); heads.push(sh(repo, 'git', ['rev-parse', 'HEAD']));
  }
  const trace = join(dir, 'trace');
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  const calls = () => readFileSync(trace, 'utf8').split('\n').filter(line => /built-in: git.*diff /.test(line)).length;
  try {
    const cache = new ArtifactDiffCache(2, 4000);
    const first = await cache.read(repo, base, heads[0]!);
    assert.equal(calls(), 2);
    first.files[0]!.path = 'mutated'; first.patch = 'mutated';
    const cached = await cache.read(repo, base, heads[0]!);
    assert.equal(calls(), 2, 'a hit runs neither full rename-detecting diff');
    assert.equal(cached.files[0]!.path, 'file'); assert.match(cached.patch, /first/);
    await cache.read(repo, base, heads[1]!);
    await cache.read(repo, base, heads[2]!);
    await cache.read(repo, base, heads[0]!);
    assert.equal(calls(), 8, 'entry limit evicts the oldest artifact');
    const tiny = new ArtifactDiffCache(32, 1);
    await tiny.read(repo, base, heads[0]!); await tiny.read(repo, base, heads[0]!);
    assert.equal(calls(), 12, 'oversized entries are not retained');
    await assert.rejects(cache.read(repo, base, 'f'.repeat(40)));
    await assert.rejects(cache.read(repo, base, 'f'.repeat(40)));
    assert.equal(calls(), 14, 'failed reads are retried');
    writeFileSync(join(repo, 'file'), 'live one\n');
    assert.match((await changeSince(repo, base, null)).patch, /live one/);
    writeFileSync(join(repo, 'file'), 'live two\n');
    assert.match((await changeSince(repo, base, null)).patch, /live two/);
  } finally { if (previousTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previousTrace; }
});

test('patch streaming stops the exact child at the byte cap, rather than buffering its entire output', async () => {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const finished = join(dir, 'should-not-finish');
  const script = join(bin, 'git');
  writeFileSync(script, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
if (process.argv.includes('--numstat')) process.stdout.write('1\\t0\\tfile\\0');
else {
  process.stdout.write('header\\n' + '€'.repeat(400_000));
  setTimeout(() => { writeFileSync(${JSON.stringify(finished)}, 'completed'); }, 30_000);
}\n`);
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin + ':' + previousPath;
  try {
    const result = await changeSince(dir, 'a'.repeat(40), 'b'.repeat(40), 1000);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.patch) <= 1000);
    assert.doesNotMatch(result.patch, /�/);
    assert.equal(existsSync(finished), false, 'the producer was stopped before its delayed continuation');
  } finally { process.env.PATH = previousPath; }
});
