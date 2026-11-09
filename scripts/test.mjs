import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let source = { head: null, trackedTreeClean: false, untrackedSource: [] };
try {
  source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedTreeClean: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() === '',
    untrackedSource: execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'src', 'test', 'scripts'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) };
} catch { /* A source tarball may have no Git metadata; report the missing binding. */ }

const args = ['--test', '--test-concurrency=3', '--test-timeout=180000', 'test/**/*.test.ts'];
console.log(JSON.stringify({ kind: 'test-invocation', node: process.version, platform: process.platform,
  command: [process.execPath, ...args], source, forceExit: false, startedAt: new Date().toISOString() }));
// Tests that exercise low-level launch helpers still need a synthetic home before their own fixture setup.
const testHome = mkdtempSync(join(tmpdir(), 'ym-suite-'));
const cleanup = () => rmSync(testHome, { recursive: true, force: true });
const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env,
  YARDMASTER_HOME: testHome, YARDMASTER_HUB: '', YARDMASTER_TOKEN: '' } });
child.on('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  cleanup();
  console.log(JSON.stringify({ kind: 'test-completion', code, signal, endedAt: new Date().toISOString() }));
  process.exitCode = code ?? 1;
});
