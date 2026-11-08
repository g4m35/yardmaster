import { spawn } from 'node:child_process';

const args = ['--test', '--test-concurrency=3', '--test-timeout=180000', 'test/**/*.test.ts'];
console.log(JSON.stringify({ kind: 'test-invocation', node: process.version, platform: process.platform,
  command: [process.execPath, ...args], forceExit: false, startedAt: new Date().toISOString() }));
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  console.log(JSON.stringify({ kind: 'test-completion', code, signal, endedAt: new Date().toISOString() }));
  process.exitCode = code ?? 1;
});
