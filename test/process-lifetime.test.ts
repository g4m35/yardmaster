import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { groupAlive, isAlive, killGroup, processStartTime, runOwnedProcess, runShell, startOwnedProcess, terminateRecordedProcess } from '../src/proc.ts';
import { runOneShot } from '../src/oneshot.ts';
import { resolveConfig } from '../src/config.ts';

/**
 * Owned-process lifetime: every path (normal exit, abort, timeout, registration failure, spawn failure) must leave no
 * process from the run alive when the call resolves. Fixtures are plain Node scripts in a disposable directory; no
 * installed agent CLI is ever started.
 */

const dir = tempDir('ym-proc-');
const node = process.execPath;
const fixture = join(dir, 'proc.mjs');
writeFileSync(fixture, `
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
const [mode, a, b, ms] = process.argv.slice(2);
const self = process.argv[1];
const record = (file, pid = process.pid) => { writeFileSync(file + '.tmp', String(pid)); renameSync(file + '.tmp', file); };
const hang = () => setInterval(() => {}, 1000);
const child = (childMode, file, stdio) => spawn(process.execPath, [self, childMode, file], { stdio });
const whenExists = (file, fn) => { const t = setInterval(() => { if (existsSync(file)) { clearInterval(t); fn(); } }, 10); };
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const usage = () => line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1000, output_tokens: 100 } } });
switch (mode) {
  case 'sleep': record(a); hang(); break;
  case 'stubborn': process.on('SIGTERM', () => {}); record(a); hang(); break;
  case 'bg': child('sleep', b, 'ignore'); whenExists(b, () => { record(a); process.exit(0); }); break;
  case 'stubborn-bg': child('stubborn', b, 'ignore'); whenExists(b, () => { record(a); process.exit(0); }); break;
  case 'holder': child('sleep', b, ['ignore', 'inherit', 'inherit']); whenExists(b, () => { record(a); process.exit(0); }); break;
  case 'leader-exits': child('sleep', b, 'ignore'); whenExists(b, () => { record(a); setTimeout(() => process.exit(0), Number(ms)); }); break;
  case 'claude-hang': usage(); record(a); hang(); break;
  case 'claude-stubborn': process.on('SIGTERM', () => {}); usage(); record(a); hang(); break;
  case 'claude-holder':
    child('sleep', b, ['ignore', 'inherit', 'inherit']);
    whenExists(b, () => { line({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, usage: {} }); record(a); process.exit(0); });
    break;
  default: process.exit(2);
}
`);
// The claude adapter's arguments are ignored; the wrapper keeps the pid (exec) so the fixture is the group leader.
const agent = join(dir, 'agent.sh');
writeFileSync(agent, `#!/bin/sh\nexec "${node}" "${fixture}" "$FIXTURE_MODE" "$FIXTURE_A" "$FIXTURE_B"\n`);
chmodSync(agent, 0o755);
const config = resolveConfig([{ agents: { claude: { enabled: true, command: agent } } }]);

let n = 0;
const files = (count: number) => Array.from({ length: count }, () => join(dir, `p${++n}.pid`));
const pidIn = (file: string) => Number(readFileSync(file, 'utf8'));

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pidWhenReady = (file: string) => waitFor(() => existsSync(file) && pidIn(file));

/** Only fixture processes from this run, by exact pid and command line; never a pattern kill. */
after(() => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pid'))) {
    const pid = pidIn(join(dir, f));
    if (!isAlive(pid)) continue;
    let cmd = '';
    try {
      cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (cmd.includes(dir)) process.kill(pid, 'SIGKILL');
  }
});

const q = (s: string) => `"${s}"`;

test('runShell reaps a background child left behind by a check that exits 0', async () => {
  const [a, b] = files(2);
  const r = await runShell(`${q(node)} ${q(fixture)} bg ${q(a!)} ${q(b!)}`, { cwd: dir, timeoutMs: 10_000, termGraceMs: 500 });
  assert.equal(r.code, 0);
  assert.equal(r.reaped, true);
  assert.equal(r.reap.status, 'terminated', 'the leftover child was stopped');
  assert.equal(isAlive(pidIn(b!)), false, 'no background process outlives the check');
});

test('a descendant holding the output pipes does not hold the run open, and is reaped', async () => {
  const [a, b] = files(2);
  const t0 = Date.now();
  const r = await runOwnedProcess(node, [fixture, 'holder', a!, b!], { cwd: dir, env: process.env, exitGraceMs: 300, termGraceMs: 500 });
  assert.equal(r.end, 'exit');
  assert.equal(r.code, 0);
  assert.equal(r.pipeHeld, true);
  assert.equal(r.reaped, true);
  assert.ok(Date.now() - t0 < 2500, `returned after the exit grace, not a timeout (${Date.now() - t0} ms)`);
  assert.equal(isAlive(pidIn(b!)), false);
});

test('abort stops a responsive command with SIGTERM before resolving', async () => {
  const [a] = files(1);
  const ac = new AbortController();
  const p = runShell(`${q(node)} ${q(fixture)} sleep ${q(a!)}`, { cwd: dir, timeoutMs: 10_000, signal: ac.signal });
  const pid = await pidWhenReady(a!);
  ac.abort('stop requested');
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.code, 130);
  assert.match(r.stdout, /stop requested/);
  assert.equal(r.reap.signal, 'SIGTERM');
  assert.equal(r.reaped, true);
  assert.equal(isAlive(pid), false);
  assert.equal(groupAlive(r.pid!), false);
});

test('abort escalates to SIGKILL for a TERM-resistant process', async () => {
  const [a] = files(1);
  const ac = new AbortController();
  const proc = startOwnedProcess(node, [fixture, 'stubborn', a!], { cwd: dir, env: process.env, signal: ac.signal, termGraceMs: 300, killWaitMs: 2000 });
  const pid = await pidWhenReady(a!);
  ac.abort();
  const r = await proc.done;
  assert.equal(r.end, 'aborted');
  assert.equal(r.reap.status, 'terminated');
  assert.equal(r.reap.signal, 'SIGKILL');
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(isAlive(pid), false);
});

test('a TERM-resistant descendant of a normally exiting leader is killed before the run resolves', async () => {
  const [a, b] = files(2);
  const r = await runOwnedProcess(node, [fixture, 'stubborn-bg', a!, b!], { cwd: dir, env: process.env, termGraceMs: 300 });
  assert.equal(r.end, 'exit');
  assert.equal(r.reap.signal, 'SIGKILL');
  assert.equal(r.reaped, true);
  assert.equal(isAlive(pidIn(b!)), false);
});

test('timeout is reported as a timeout and stops the group', async () => {
  const [a] = files(1);
  const r = await runShell(`${q(node)} ${q(fixture)} sleep ${q(a!)}`, { cwd: dir, timeoutMs: 400, termGraceMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  assert.equal(r.reaped, true);
  assert.equal(isAlive(pidIn(a!)), false);
});

test('onSpawn registers pid and start identity inside the guarded lifetime', async () => {
  const seen: { pid: number; startedAt: number | null }[] = [];
  const r = await runOwnedProcess(node, ['-e', 'setTimeout(() => {}, 200)'], {
    cwd: dir, env: process.env,
    onSpawn: async (p) => {
      seen.push({ pid: p.pid, startedAt: p.startedAt });
      assert.equal(p.pgid, p.pid);
      assert.equal(isAlive(p.pid), true, 'registered while alive');
    },
  });
  assert.equal(r.end, 'exit');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.pid, r.pid);
  assert.ok(seen[0]!.startedAt !== null && Math.abs(seen[0]!.startedAt - r.launchedAt) < 2500, 'start identity recorded');
});

test('a failed or hung registration stops the child instead of leaving it unmonitored', async () => {
  const [a, b] = files(2);
  const failed = await runOwnedProcess(node, [fixture, 'sleep', a!], {
    cwd: dir, env: process.env, termGraceMs: 500,
    onSpawn: async () => {
      await pidWhenReady(a!);
      throw new Error('simulated transport failure');
    },
  });
  assert.equal(failed.end, 'hook_failed');
  assert.match(failed.error, /simulated transport failure/);
  assert.equal(failed.reaped, true);
  assert.equal(isAlive(pidIn(a!)), false);

  const hung = await runOwnedProcess(node, [fixture, 'sleep', b!], { cwd: dir, env: process.env, hookTimeoutMs: 300, termGraceMs: 500, onSpawn: () => new Promise(() => undefined) });
  assert.equal(hung.end, 'hook_failed');
  assert.match(hung.error, /did not finish within 300 ms/);
  assert.equal(isAlive(hung.pid!), false);
});

test('an abort during a slow registration is not delayed by it', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const r = await runOwnedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: dir, env: process.env, signal: ac.signal, termGraceMs: 500,
    onSpawn: () => {
      setTimeout(() => ac.abort(), 50);
      return new Promise(() => undefined);
    },
  });
  assert.equal(r.end, 'aborted');
  assert.ok(Date.now() - t0 < 3000, 'did not wait for the 30 s hook timeout');
  assert.equal(isAlive(r.pid!), false);
});

test('spawn failures, early stdin close and pre-aborted signals resolve without throwing or spawning', async () => {
  const missing = await runOwnedProcess(join(dir, 'no-such-binary'), [], { cwd: dir, env: process.env });
  assert.equal(missing.end, 'spawn_failed');
  assert.equal(missing.pid, null);
  assert.match(missing.error, /ENOENT/);
  const badCwd = await runOwnedProcess(node, ['-e', ''], { cwd: join(dir, 'missing-dir'), env: process.env });
  assert.equal(badCwd.end, 'spawn_failed');
  const shell = await runShell('exit 7', { cwd: dir, timeoutMs: 5000 });
  assert.equal(shell.code, 7);
  // The child exits without reading 8 MB of stdin: EPIPE must not crash or change the outcome.
  const epipe = await runOwnedProcess(node, ['-e', 'process.exit(0)'], { cwd: dir, env: process.env, stdin: 'x'.repeat(8_000_000) });
  assert.equal(epipe.end, 'exit');
  assert.equal(epipe.code, 0);
  const pre = await runOwnedProcess(node, ['-e', ''], { cwd: dir, env: process.env, signal: AbortSignal.abort('already canceled') });
  assert.equal(pre.end, 'aborted');
  assert.equal(pre.pid, null);
  assert.equal(pre.error, 'already canceled');
});

/** A detached process the test owns, standing in for an agent recorded by an earlier hub process. */
async function recorded(mode: string, ...args: string[]) {
  const child = spawn(node, [fixture, mode, ...args], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const pid = await pidWhenReady(args[0]!);
  return { pid, startedAt: await processStartTime(pid), exited };
}

test('restart recovery terminates a verified responsive orphan', async () => {
  const [a] = files(1);
  const p = await recorded('sleep', a!);
  const r = await terminateRecordedProcess({ pid: p.pid, startedAt: p.startedAt }, { graceMs: 1000 });
  assert.deepEqual(r, { status: 'terminated', signal: 'SIGTERM' });
  await p.exited;
  assert.equal(isAlive(p.pid), false);
});

test('restart recovery escalates to SIGKILL for a TERM-resistant orphan and confirms exit', async () => {
  const [a] = files(1);
  const p = await recorded('stubborn', a!);
  const r = await terminateRecordedProcess({ pid: p.pid, startedAt: p.startedAt }, { graceMs: 300 });
  assert.deepEqual(r, { status: 'terminated', signal: 'SIGKILL' });
  await p.exited;
  assert.equal(groupAlive(p.pid), false);
});

test('restart recovery stops live descendants after the recorded leader exited', async () => {
  const [a, b] = files(2);
  const p = await recorded('leader-exits', a!, b!, '300');
  const descendant = pidIn(b!);
  await p.exited;
  assert.equal(isAlive(p.pid), false, 'leader gone');
  assert.equal(isAlive(descendant), true, 'descendant still running');
  const r = await terminateRecordedProcess({ pid: p.pid, startedAt: p.startedAt }, { graceMs: 1000 });
  assert.equal(r.status, 'terminated');
  assert.equal(isAlive(descendant), false);
  assert.deepEqual(await terminateRecordedProcess({ pid: p.pid, startedAt: p.startedAt }), { status: 'exited' });
});

test('restart recovery never signals a pid whose identity does not match', async () => {
  const [a, b] = files(2);
  const p = await recorded('sleep', a!);
  // Same pid, different start time: a recycled pid.
  const reused = await terminateRecordedProcess({ pid: p.pid, startedAt: p.startedAt! - 3_600_000 });
  assert.equal(reused.status, 'unverified');
  const unknown = await terminateRecordedProcess({ pid: p.pid, startedAt: null });
  assert.equal(unknown.status, 'unverified');
  assert.equal(isAlive(p.pid), true, 'left alone');

  // A live pid that does not lead a process group was not started by Yardmaster.
  const plain = spawn(node, [fixture, 'sleep', b!], { stdio: 'ignore' });
  const plainExit = new Promise<void>((r) => plain.once('exit', () => r()));
  const plainPid = await pidWhenReady(b!);
  const notLeader = await terminateRecordedProcess({ pid: plainPid, startedAt: await processStartTime(plainPid) });
  assert.equal(notLeader.status, 'unverified');
  assert.equal(killGroup(plainPid, 'SIGTERM'), false, 'killGroup does not fall back to a lone pid');
  assert.equal(isAlive(plainPid), true);

  process.kill(p.pid, 'SIGKILL');
  plain.kill('SIGKILL');
  await Promise.all([p.exited, plainExit]);
});

test('runOneShot cancel stops the CLI before resolving and keeps its metered usage', async () => {
  const [a] = files(1);
  const ac = new AbortController();
  const p = runOneShot({ agent: 'claude', config, prompt: 'x', cwd: dir, signal: ac.signal, env: { FIXTURE_MODE: 'claude-hang', FIXTURE_A: a! }, termGraceMs: 500 });
  const pid = await pidWhenReady(a!);
  ac.abort();
  const r = await p;
  assert.equal(r.status, 'canceled');
  assert.equal(r.ok, false);
  assert.equal(r.pid, pid);
  assert.equal(r.reaped, true);
  assert.equal(isAlive(pid), false);
  assert.equal(r.usage.events, 1, 'usage printed before the cancel is kept');
  assert.ok(r.costUsd > 0);
  assert.equal(r.usage.provenance, 'estimated');
});

test('runOneShot cancel escalates for a TERM-resistant CLI', async () => {
  const [a] = files(1);
  const ac = new AbortController();
  const p = runOneShot({ agent: 'claude', config, prompt: 'x', cwd: dir, signal: ac.signal, env: { FIXTURE_MODE: 'claude-stubborn', FIXTURE_A: a! }, termGraceMs: 300 });
  const pid = await pidWhenReady(a!);
  ac.abort();
  const r = await p;
  assert.equal(r.status, 'canceled');
  assert.equal(r.reap.signal, 'SIGKILL');
  assert.equal(isAlive(pid), false);
});

test('runOneShot returns after its CLI exits even when a descendant holds stdout, and reaps it', async () => {
  const [a, b] = files(2);
  const t0 = Date.now();
  const r = await runOneShot({ agent: 'claude', config, prompt: 'x', cwd: dir, exitGraceMs: 300, termGraceMs: 500, env: { FIXTURE_MODE: 'claude-holder', FIXTURE_A: a!, FIXTURE_B: b! } });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.text, 'done');
  assert.ok(Date.now() - t0 < 3000, `no wait for the 10-minute timeout (${Date.now() - t0} ms)`);
  assert.equal(r.reaped, true);
  assert.equal(isAlive(pidIn(b!)), false);
});

test('runOneShot stops a CLI whose registration fails, and reports spawn failures with usage present', async () => {
  const [a] = files(1);
  const r = await runOneShot({
    agent: 'claude', config, prompt: 'x', cwd: dir, termGraceMs: 500, env: { FIXTURE_MODE: 'claude-hang', FIXTURE_A: a! },
    hooks: { onSpawn: async () => { await pidWhenReady(a!); throw new Error('run.update failed'); } },
  });
  assert.equal(r.status, 'hook_failed');
  assert.match(r.error, /run.update failed/);
  assert.equal(isAlive(pidIn(a!)), false);
  assert.ok(r.procStartedAt !== null);

  const missing = resolveConfig([{ agents: { claude: { enabled: true, command: join(dir, 'missing-cli') } } }]);
  const s = await runOneShot({ agent: 'claude', config: missing, prompt: 'x', cwd: dir });
  assert.equal(s.status, 'spawn_failed');
  assert.equal(s.usage.provenance, 'unknown');
  assert.equal(s.model, null);
  assert.ok(s.endedAt >= s.startedAt);
});
