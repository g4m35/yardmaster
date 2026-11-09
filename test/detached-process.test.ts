import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isAlive, runOwnedProcess, startOwnedProcess, terminateRecordedProcess } from '../src/proc.ts';
import { terminateMarkedProcesses } from '../src/process-ownership.ts';
import { tempDir } from './helpers.ts';

const dir = tempDir('ym-detached-');
const home = join(dir, 'home');
process.env.YARDMASTER_HOME = home;
const childScript = join(dir, 'child.mjs');
const leaderScript = join(dir, 'leader.mjs');
const controllerScript = join(dir, 'controller.mjs');
writeFileSync(childScript, `import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{});writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
writeFileSync(leaderScript, `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
const [script,file,mode]=process.argv.slice(2);const c=spawn(process.execPath,[script,file],{detached:true,stdio:'ignore'});c.unref();
const t=setInterval(()=>{if(existsSync(file)){clearInterval(t);if(mode==='exit')process.exit(0);else setInterval(()=>{},1000);}},10);`);
writeFileSync(controllerScript, `import {writeFileSync} from 'node:fs';
import {startOwnedProcess} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/proc.ts')).href)};
const [leader,child,pidfile,identity]=process.argv.slice(2);
const run=startOwnedProcess(process.execPath,[leader,child,pidfile,'hang'],{cwd:${JSON.stringify(dir)},env:process.env,onSpawn:p=>writeFileSync(identity,JSON.stringify({pid:p.pid,startedAt:p.startedAt}))});
await run.done;`);

let serial = 0;
const files = () => ({ pid: join(dir, `${++serial}.pid`), identity: join(dir, `${serial}.identity`) });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function ready(file: string): Promise<number> {
  for (let i = 0; i < 500; i++) {
    if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
    await wait(10);
  }
  throw new Error(`Fixture did not become ready: ${file}`);
}
const receipt = (pid: number) => join(home, 'process-owners', `${pid}.json`);
const children: ChildProcess[] = [];
after(async () => {
  await Promise.all(children.map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    return exited;
  }));
  // Only exact audit-owned PIDs with a matching fixture command may be cleaned up.
  const pids = readdirSync(dir).flatMap(file => {
    if (file.endsWith('.pid')) return [Number(readFileSync(join(dir, file), 'utf8'))];
    if (file.endsWith('.identity')) return [JSON.parse(readFileSync(join(dir, file), 'utf8')).pid as number];
    return [];
  });
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    let cmd: string;
    try { cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); } catch { continue; }
    assert.ok(cmd.includes(dir), 'cleanup never targets an unrelated command');
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && isAlive(pid); i++) await wait(10);
    assert.equal(isAlive(pid), false, 'exact fixture PID stopped');
  }
});

for (const mode of ['exit', 'abort'] as const) test(`${mode} reaps a detached TERM-resistant descendant and retires its receipt`, async () => {
  const f = files(); const ac = new AbortController();
  const run = startOwnedProcess(process.execPath, [leaderScript, childScript, f.pid, mode], {
    cwd: dir, env: process.env, signal: ac.signal, termGraceMs: 100, killWaitMs: 2000,
  });
  const escaped = await ready(f.pid);
  if (mode === 'abort') ac.abort('fixture cancellation');
  const result = await run.done;
  assert.equal(result.end, mode === 'abort' ? 'aborted' : 'exit');
  assert.equal(result.reaped, true);
  assert.equal(isAlive(escaped), false);
  assert.equal(result.reap.signal, 'SIGKILL', 'TERM-resistant detached child required escalation');
  assert.equal(existsSync(receipt(result.pid!)), false, 'receipt only removed after cleanup proof');
});

test('restart recovery uses the private receipt after the original controller dies and preserves unrelated work', async () => {
  const f = files(), unrelatedFile = files().pid;
  const unrelated = spawn(process.execPath, [childScript, unrelatedFile], { stdio: 'ignore' }); children.push(unrelated);
  const unrelatedPid = await ready(unrelatedFile);
  const controller = spawn(process.execPath, [controllerScript, leaderScript, childScript, f.pid, f.identity], { env: process.env, stdio: 'ignore' }); children.push(controller);
  const controllerExit = new Promise<void>(resolve => controller.once('exit', () => resolve()));
  const escaped = await ready(f.pid);
  for (let i = 0; i < 500 && !existsSync(f.identity); i++) await wait(10);
  assert.ok(existsSync(f.identity));
  const id = JSON.parse(readFileSync(f.identity, 'utf8')) as { pid: number; startedAt: number };
  assert.ok(id.startedAt);
  assert.ok(existsSync(receipt(id.pid)));
  controller.kill('SIGKILL'); await controllerExit;
  assert.equal(isAlive(escaped), true);
  const stale = await terminateRecordedProcess({ ...id, startedAt: id.startedAt - 3_600_000 }, { graceMs: 100 });
  assert.equal(stale.status, 'unverified', 'mismatched historical identity is never borrowed');
  assert.equal(isAlive(id.pid), true);
  assert.equal(isAlive(escaped), true);
  const result = await terminateRecordedProcess(id, { graceMs: 100, killWaitMs: 2000 });
  assert.equal(result.status, 'terminated');
  assert.equal(isAlive(id.pid), false);
  assert.equal(isAlive(escaped), false);
  assert.equal(isAlive(unrelatedPid), true, 'same-user unrelated process was not signaled');
  assert.equal(existsSync(receipt(id.pid)), false);
  assert.deepEqual(await terminateRecordedProcess(id), { status: 'exited' }, 'acknowledgment is replay-safe');
});

test('unavailable environment inspection keeps an explicit hold and receipt until a supported retry', async () => {
  const f = files(), fake = join(dir, 'fake-bin'); mkdirSync(fake);
  writeFileSync(join(fake, 'ps'), '#!/bin/sh\nprintf "inspection unavailable\\n"\n'); chmodSync(join(fake, 'ps'), 0o755);
  const originalPath = process.env.PATH;
  let result: Awaited<ReturnType<typeof runOwnedProcess>>;
  try {
    process.env.PATH = fake;
    result = await runOwnedProcess(process.execPath, [leaderScript, childScript, f.pid, 'exit'], { cwd: dir, env: process.env, termGraceMs: 100 });
  } finally { process.env.PATH = originalPath; }
  const escaped = await ready(f.pid);
  assert.equal(result.reaped, false);
  assert.equal(result.reap.status, 'unverified');
  assert.match(result.reap.reason!, /inspection|ownership/i);
  assert.equal(existsSync(receipt(result.pid!)), true);
  assert.equal(isAlive(escaped), true, 'missing identity evidence cannot authorize a signal');
  const recovered = await terminateRecordedProcess({ pid: result.pid!, startedAt: result.startedAt }, { graceMs: 100, killWaitMs: 2000 });
  assert.equal(recovered.status, 'terminated');
  assert.equal(isAlive(escaped), false);
  assert.equal(existsSync(receipt(result.pid!)), false);
});

test('a fast leader with delayed PID inspection retains the actual pre-spawn time for detached cleanup', async () => {
  const f = files(), fake = join(dir, 'delayed-ps-bin'); mkdirSync(fake);
  const ps = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  writeFileSync(join(fake, 'ps'), `#!/bin/sh\nif [ "$1" = "-o" ] && [ "$2" = "lstart=" ]; then /bin/sleep 3; fi\nexec "${ps}" "$@"\n`);
  chmodSync(join(fake, 'ps'), 0o755);
  const originalPath = process.env.PATH;
  const before = Date.now(); let recordedLaunch: number | undefined;
  let result: Awaited<ReturnType<typeof runOwnedProcess>>;
  try {
    process.env.PATH = fake;
    result = await runOwnedProcess(process.execPath, [leaderScript, childScript, f.pid, 'exit'], {
      cwd: dir, env: process.env, termGraceMs: 100, killWaitMs: 2000,
      onSpawn: info => { recordedLaunch = JSON.parse(readFileSync(receipt(info.pid), 'utf8')).launchedAt; },
    });
  } finally { process.env.PATH = originalPath; }
  const escaped = await ready(f.pid);
  assert.equal(result.startedAt, null, 'the leader exited before the delayed PID lookup');
  assert.ok(recordedLaunch! >= before && recordedLaunch! < before + 1000, 'receipt time comes from before spawn, not delayed registration');
  assert.equal(result.reaped, true);
  assert.equal(isAlive(escaped), false, 'birth filtering cannot omit a child older than receipt registration');
});

test('concurrent quiet cleanup shares queued work but still takes two distinct fresh censuses', async () => {
  const fake = join(dir, 'census-count-bin'), calls = join(dir, 'census-calls.txt'); mkdirSync(fake);
  const ps = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  const quotedCalls = `'${calls.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(fake, 'ps'), `#!/bin/sh\nif [ "$1" = "-U" ]; then printf 'census\\n' >> ${quotedCalls}; fi\nexec "${ps}" "$@"\n`);
  chmodSync(join(fake, 'ps'), 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fake;
    const results = await Promise.all(Array.from({ length: 4 }, () => terminateMarkedProcesses({
      pid: 123456, startedAt: null, marker: randomUUID(), uid: process.getuid!(), launchedAt: Date.now(),
    })));
    assert.ok(results.every(result => result.status === 'exited'));
    const count = readFileSync(calls, 'utf8').trim().split('\n').length;
    // The first synchronous wave shares one census. Environment lookup completions can place
    // the four second observations in separate event-loop turns, requiring additional fresh work.
    assert.ok(count >= 2 && count <= 5, `two fresh observations per caller, with queued sharing; saw ${count} censuses`);
  } finally { process.env.PATH = originalPath; }
});
