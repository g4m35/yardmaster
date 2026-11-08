import { execFileSync, spawn } from 'node:child_process';

let source = { head: null, trackedTreeClean: false, untrackedSource: [] };
try {
  source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedTreeClean: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() === '',
    untrackedSource: execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'src', 'test', 'scripts'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) };
} catch { /* A source tarball may have no Git metadata; report the missing binding. */ }

const args = ['--test', '--test-concurrency=3', '--test-timeout=180000', 'test/**/*.test.ts'];
console.log(JSON.stringify({ kind: 'test-invocation', node: process.version, platform: process.platform,
  command: [process.execPath, ...args], source, forceExit: false, startedAt: new Date().toISOString() }));
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  console.log(JSON.stringify({ kind: 'test-completion', code, signal, endedAt: new Date().toISOString() }));
  process.exitCode = code ?? 1;
});
