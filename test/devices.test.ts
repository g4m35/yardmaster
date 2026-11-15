import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { resolveConfig, loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { AppleSimulatorOptionsSchema, runAppleSimulator, type DeviceRunContext } from '../src/device-provider.ts';
import { artifactSha256, deviceEvidence, fileSha256, type DeviceEvidence } from '../src/device-evidence.ts';
import { acquireLease, listLeases, reapLeases } from '../src/leases.ts';
import { chooseTarget, cleanupOwnedSimulators, compareVersions, exec, hostCleanup } from '../src/simctl.ts';
import { linuxAvailableMb, meminfoAvailableMb, memoryHold, type MemorySample } from '../src/machine-pressure.ts';
import { builtinProviders } from '../src/provider-builtins.ts';
import { planService } from '../src/providers.ts';
import { ServicesConfigSchema } from '../src/provider-contract.ts';
import { DeviceEvidenceSchema, evidenceProblem, redactText, scrubFile } from '../src/device-evidence.ts';
import { verifyArtifact } from '../src/verification.ts';
import { WorkerLoop } from '../src/worker.ts';
import { runAttempt, Semaphore } from '../src/runner.ts';
import { Hub } from '../src/hub.ts';
import { machineId } from '../src/paths.ts';
import type { Client } from '../src/api.ts';

const cli = join(import.meta.dirname, '../src/cli.ts');
/** Another session's booted simulator. Nothing in these tests may touch it. */
const FOREIGN = { udid: 'F0F0F0F0-0000-4000-8000-000000000001', name: 'iPhone 17', state: 'Booted', installed: [] as string[] };
const normal = async (): Promise<MemorySample> => ({ availableMb: 8000, pressure: 'normal', sampledAt: Date.now() });

function fakeMachine() {
  const bin = tempDir('ym-fake-xcrun-');
  copyFileSync(join(import.meta.dirname, 'fixtures/fake-xcrun.mjs'), join(bin, 'fake-xcrun.mjs'));
  writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-xcrun.mjs')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'sim-state.json'), JSON.stringify({ devices: [FOREIGN], config: {} }));
  const PATH = `${bin}:${process.env.PATH}`;
  return { bin, PATH,
    state: () => JSON.parse(readFileSync(join(bin, 'sim-state.json'), 'utf8')) as { devices: typeof FOREIGN[]; config: Record<string, string> },
    log: () => existsSync(join(bin, 'sim-log.jsonl')) ? readFileSync(join(bin, 'sim-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { t: number; args: string[] }) : [],
    fail(cmd: string) { const s = this.state(); s.config.fail = cmd; writeFileSync(join(bin, 'sim-state.json'), JSON.stringify(s)); } };
}
function assertForeignUntouched(m: ReturnType<typeof fakeMachine>) {
  assert.deepEqual(m.state().devices.find(d => d.udid === FOREIGN.udid), FOREIGN);
  assert(!m.log().some(entry => entry.args.includes(FOREIGN.udid)), 'no command ever named the foreign simulator');
}

const BUILD = `const fs=require('node:fs');fs.mkdirSync('build/Smoke.app',{recursive:true});fs.writeFileSync('build/Smoke.app/Smoke','binary for '+require('node:child_process').execSync('git rev-parse HEAD'));fs.appendFileSync(process.env.BUILD_COUNT||'/dev/null','b');`;
const SMOKE = `const fs=require('node:fs');if(!/^[0-9A-F-]{36}$/.test(process.env.YARDMASTER_DEVICE_UDID)||process.env.YARDMASTER_DEVICE_UDID===${JSON.stringify(FOREIGN.udid)})process.exit(9);fs.writeFileSync(process.env.YARDMASTER_ARTIFACT_DIR+'/smoke.txt',process.env.YARDMASTER_BUNDLE_ID);`;
// Waits until told to stop, and exits by itself if its parent disappears (so a killed holder leaves nothing behind).
const hang = (marker: string) => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},process.env.YARDMASTER_DEVICE_UDID||'held');const p=process.ppid;setInterval(()=>{if(process.ppid!==p)process.exit(0)},100);setTimeout(()=>process.exit(0),60000);`;

function appRepo(extra: Record<string, unknown> = {}) {
  const s = sandbox({ devices: { holdAtPressure: 'off', minFreeMemMb: 0, waitMinutes: 1 }, ...extra });
  writeFileSync(join(s.repo, '.gitignore'), 'build/\n');
  sh(s.repo, 'git', ['add', '-A']); sh(s.repo, 'git', ['commit', '-q', '-m', 'ignore build output']);
  return { ...s, sha: sh(s.repo, 'git', ['rev-parse', 'HEAD']) };
}
const options = (over: Record<string, unknown> = {}) => AppleSimulatorOptionsSchema.parse({ bundleId: 'dev.yardmaster.smoke',
  build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app' },
  tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', SMOKE] }], ...over });
const devices = (over: Record<string, unknown> = {}) => resolveConfig([{ devices: { minFreeMemMb: 0, waitMinutes: 1, ...over } }]).devices;
function context(s: { repo: string; home: string; sha: string }, m: ReturnType<typeof fakeMachine>, over: Partial<DeviceRunContext> = {}): DeviceRunContext {
  const evidenceDir = join(s.home, 'evidence-' + randomUUID()); mkdirSync(evidenceDir, { recursive: true });
  return { cwd: s.repo, env: { PATH: m.PATH, HOME: s.home }, evidenceDir, input: {}, requestId: randomUUID(),
    context: { sha: s.sha, projectId: 'p-one' }, devices: devices(), sampleMemory: normal, pollMs: 250, ...over };
}
const leasesNow = () => { const db = openDb(); try { return listLeases(db); } finally { db.close(); } };
const created = (m: ReturnType<typeof fakeMachine>) => m.log().filter(e => e.args[1] === 'create');

test('the simulator smoke workflow leases, installs, launches, tests and records evidence bound to the commit and artifact', async () => {
  const s = appRepo(), m = fakeMachine();
  const run = await runAppleSimulator(options(), context(s, m, { context: { sha: s.sha, projectId: 'p-one', codeChecks: 'passed' } }));
  const e = run.result.data.evidence;
  assert.equal(run.result.status, 'passed', run.result.summary);
  assert.equal(e.commit, s.sha);
  assert.deepEqual(e.status, { code: 'passed', simulator: 'passed', physical: 'untested', overall: 'passed' });
  assert.equal(e.artifact!.sha256, artifactSha256(join(s.repo, 'build/Smoke.app')));
  assert.equal(e.artifact!.source, 'built');
  assert.equal(e.device!.kind, 'simulator'); assert.equal(e.device!.model, 'iPhone 17'); assert.equal(e.device!.runtime, 'iOS 26.5');
  assert.equal(e.device!.modelIdentifier, 'iPhone18,3'); assert.equal(e.environment.xcode, 'Xcode 99.0 Build version 99A1');
  assert.deepEqual(e.checks.map(c => `${c.name}:${c.status}`), ['build:passed', 'boot:passed', 'install:passed', 'launch:passed', 'smoke:passed']);
  assert(e.files.some(f => f.kind === 'screenshot' && f.path.endsWith('launch.png')));
  assert(e.files.some(f => f.path.endsWith('smoke.txt')), 'files the test wrote are receipts too');
  assert.match(e.summary, /Physical device untested/);
  assert.equal(JSON.parse(readFileSync(join(run.result.artifacts[0]!), 'utf8')).commit, s.sha);
  // Only the simulator it created was touched, and it is gone; the lease is released.
  assert.equal(created(m).length, 1);
  assert(m.log().some(entry => entry.args[1] === 'delete' && entry.args[2] === e.device!.udid));
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid]);
  assertForeignUntouched(m);
  assert.equal(leasesNow().length, 0);
  assert.equal(e.lease!.cleanup, 'released');
  // The simulator's own processes outlive simctl; they belong to the simulator and end with its shutdown.
  assert.match(readFileSync(join(m.bin, 'sim-processes'), 'utf8'), /^\d+ true\n$/);
  assert.equal(run.execution.reaped, true);
});

test('a physical-device requirement stays untested after a simulator pass and is not accepted', async () => {
  const s = appRepo(), m = fakeMachine();
  const run = await runAppleSimulator(options(), context(s, m, { input: { requires: 'physical' } }));
  const e = run.result.data.evidence;
  assert.equal(e.status.simulator, 'passed'); assert.equal(e.status.physical, 'untested');
  assert.equal(e.status.overall, 'unknown'); assert.equal(run.result.status, 'unknown');
  assert.match(e.summary, /does not satisfy this physical-device requirement/);
});

test('tools that are missing or broken are unavailable, never a pass', async () => {
  const s = appRepo(), m = fakeMachine();
  const brokenBin = tempDir('ym-broken-maestro-');
  writeFileSync(join(brokenBin, 'maestro'), '#!/bin/sh\necho "Unable to locate a Java Runtime" >&2\nexit 1\n', { mode: 0o755 });
  const run = await runAppleSimulator(options({ tests: [
    { name: 'broken-maestro', runner: 'maestro', flow: 'flows/smoke.yaml' },
    { name: 'no-agent-device', runner: 'agent-device', command: ['agent-device-not-installed', 'snapshot'] },
  ] }), context(s, m, { env: { PATH: `${brokenBin}:${m.PATH}`, HOME: s.home } }));
  const e = run.result.data.evidence;
  assert.deepEqual(e.checks.filter(c => c.runner !== 'simctl' && c.name !== 'build').map(c => c.status), ['unavailable', 'unavailable']);
  assert.match(e.checks.find(c => c.name === 'broken-maestro')!.detail, /--version failed/);
  assert.equal(e.status.simulator, 'unknown'); assert.equal(run.result.status, 'unknown');
  assert.equal(leasesNow().length, 0); assertForeignUntouched(m);
});

test('maestro runs against the leased simulator with its UDID and a JUnit report', async () => {
  const s = appRepo(), m = fakeMachine();
  const maestroBin = tempDir('ym-maestro-'), argsFile = join(maestroBin, 'args.json');
  writeFileSync(join(maestroBin, 'maestro'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.0.0; exit 0; fi\n"${process.execPath}" -e 'const a=process.argv.slice(1);require("node:fs").writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(a));require("node:fs").writeFileSync(a[a.indexOf("--output")+1],"<testsuites/>")' -- "$@"\n`, { mode: 0o755 });
  const run = await runAppleSimulator(options({ tests: [{ name: 'flow', runner: 'maestro', flow: 'maestro/smoke.yaml' }] }), context(s, m, { env: { PATH: `${maestroBin}:${m.PATH}`, HOME: s.home } }));
  assert.equal(run.result.status, 'passed', run.result.summary);
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.deepEqual(args.slice(0, 4), ['--device', run.result.data.evidence.device!.udid, 'test', '--format']);
  assert.equal(args.at(-1), 'maestro/smoke.yaml');
  assert(run.result.data.evidence.files.some(f => f.kind === 'report' && f.path.endsWith('report.xml')));
});

test('a failing build or smoke test is a failure; a failed boot is unknown and still cleans up', async () => {
  const s = appRepo();
  let m = fakeMachine();
  const broken = await runAppleSimulator(options({ build: { command: [process.execPath, '-e', 'process.exit(3)'], app: 'build/Smoke.app' } }), context(s, m));
  assert.equal(broken.result.status, 'failed'); assert.equal(broken.result.data.evidence.status.simulator, 'not-run');
  assert.equal(created(m).length, 0, 'no simulator for an artifact that did not build');
  const failing = await runAppleSimulator(options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', 'process.exit(1)'] }] }), context(s, m));
  assert.equal(failing.result.status, 'failed'); assert.equal(failing.result.data.evidence.status.simulator, 'failed');
  m = fakeMachine(); m.fail('bootstatus');
  const boot = await runAppleSimulator(options(), context(s, m));
  assert.equal(boot.result.status, 'unknown'); assert.equal(boot.result.data.evidence.checks.find(c => c.name === 'boot')!.status, 'unknown');
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid], 'the created simulator is deleted after a failed boot');
  assert.equal(leasesNow().length, 0); assertForeignUntouched(m);
});

test('build reuse needs an exact fingerprint match and a verified stored artifact; unknown fingerprints build', async () => {
  const s = appRepo(), m = fakeMachine(), count = join(s.home, 'builds');
  const env = { PATH: m.PATH, HOME: s.home, BUILD_COUNT: count };
  const fp = (out: string) => options({ build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app', reuse: 'fingerprint', fingerprint: [process.execPath, '-e', `console.log(${JSON.stringify(out)})`] } });
  const first = await runAppleSimulator(fp('{"hash":"native-aaaa1111"}'), context(s, m, { env }));
  const second = await runAppleSimulator(fp('{"hash":"native-aaaa1111"}'), context(s, m, { env }));
  assert.equal(first.result.data.evidence.artifact!.source, 'built');
  assert.equal(second.result.data.evidence.artifact!.source, 'reused');
  assert.equal(second.result.data.evidence.artifact!.builtFromCommit, s.sha);
  assert.equal(second.result.data.evidence.artifact!.sha256, first.result.data.evidence.artifact!.sha256);
  assert.equal(second.result.status, 'passed');
  assert.equal(readFileSync(count, 'utf8'), 'b', 'the second run did not build');
  await runAppleSimulator(fp('{"hash":"native-bbbb2222"}'), context(s, m, { env }));
  await runAppleSimulator(fp('not a fingerprint\nsecond line'), context(s, m, { env }));
  assert.equal(readFileSync(count, 'utf8'), 'bbb', 'a changed or unreadable fingerprint builds normally');
});

test('two projects contend for one simulator slot in queue order without overlapping', async () => {
  const s = appRepo(), m = fakeMachine();
  const other = join(s.root, 'second-project'); mkdirSync(other);
  sh(other, 'git', ['init', '-q', '-b', 'main']); writeFileSync(join(other, '.gitignore'), 'build/\n');
  sh(other, 'git', ['add', '-A']); sh(other, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'second']);
  const slow = options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', `${SMOKE}setTimeout(()=>{},700)`] }] });
  const waits: string[] = [];
  const [a, b] = await Promise.all([
    runAppleSimulator(slow, context(s, m, { context: { sha: s.sha, projectId: 'p-one' } })),
    runAppleSimulator(slow, { ...context({ ...s, repo: other, sha: sh(other, 'git', ['rev-parse', 'HEAD']) }, m, { context: { sha: sh(other, 'git', ['rev-parse', 'HEAD']), projectId: 'p-two' } }) }),
    until(() => leasesNow(), leases => { for (const l of leases) if (l.state === 'waiting') waits.push(l.projectId!); return leases.some(l => l.state === 'waiting'); }, 20_000, 'a queued contender'),
  ]);
  assert.equal(a.result.status, 'passed', a.result.summary); assert.equal(b.result.status, 'passed', b.result.summary);
  const [first, second] = [a.result.data.evidence.lease!, b.result.data.evidence.lease!].sort((x, y) => x.acquiredAt! - y.acquiredAt!);
  assert(first.releasedAt! <= second.acquiredAt!, 'the second project started only after the first released its slot');
  assert(second.waitedMs > 0);
  // Each simulator's create..delete window is disjoint from the other's.
  const window = (udid: string) => m.log().filter(e => e.args.includes(udid)).map(e => e.t);
  const [wa, wb] = [window(a.result.data.evidence.device!.udid), window(b.result.data.evidence.device!.udid)];
  assert(Math.max(...wa) < Math.min(...wb) || Math.max(...wb) < Math.min(...wa));
  assert(waits.length > 0); assertForeignUntouched(m);
});

test('cancellation stops the test, deletes only the simulator it created and releases the lease', async () => {
  const s = appRepo(), m = fakeMachine(), marker = join(s.home, 'test-started');
  const abort = new AbortController();
  const running = runAppleSimulator(options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', hang(marker)] }] }), context(s, m, { signal: abort.signal }));
  await until(() => existsSync(marker), Boolean, 20_000, 'the test to start');
  const udid = readFileSync(marker, 'utf8');
  assert.equal(leasesNow()[0]!.owned[0]!.udid, udid, 'the lease records what it created before the test runs');
  abort.abort('canceled by test');
  const run = await running;
  assert.equal(run.result.status, 'unknown'); assert.match(run.result.summary, /canceled/);
  assert.equal(run.result.data.evidence.checks.find(c => c.name === 'smoke')!.status, 'unknown');
  assert.equal(run.execution.reaped, true);
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid]);
  assert.equal(leasesNow().length, 0); assertForeignUntouched(m);
});

test('a crashed holder is detected by PID and start identity; reaping cleans only its recorded simulator', async () => {
  const s = appRepo(), m = fakeMachine(), marker = join(s.home, 'crash-test-started');
  writeFileSync(join(s.repo, 'yardmaster.json'), JSON.stringify({ services: {
    providers: { 'apple-simulator': { options: { bundleId: 'dev.yardmaster.smoke', build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app' },
      tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', hang(marker)] }] } } },
    routes: { 'device.test': { prefer: ['apple-simulator'] } } } }));
  sh(s.repo, 'git', ['add', '-A']); sh(s.repo, 'git', ['commit', '-q', '-m', 'device config']);
  const child = spawn(process.execPath, [cli, 'providers', 'run', 'device.test', '--json'], { cwd: s.repo, env: { ...process.env, PATH: m.PATH, YARDMASTER_HOME: s.home }, stdio: 'ignore' });
  try {
    await until(() => existsSync(marker), Boolean, 30_000, 'the CLI holder to start its test');
    const held = leasesNow().find(l => l.pool === 'simulator')!;
    assert.equal(held.state, 'held'); assert.equal(held.pid, child.pid);
    assert.equal(held.owned[0]!.udid, readFileSync(marker, 'utf8'));
    // A live holder is never reaped.
    assert.deepEqual(await reapLeases(hostCleanup({ PATH: m.PATH })), []);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const reap = spawn(process.execPath, [cli, 'devices', 'reap', '--json'], { cwd: s.repo, env: { ...process.env, PATH: m.PATH, YARDMASTER_HOME: s.home } });
    let out = ''; reap.stdout.on('data', chunk => { out += chunk; });
    await new Promise(resolve => reap.once('exit', resolve));
    const results = JSON.parse(out) as { outcome: string; pool: string }[];
    assert.deepEqual(results.map(r => `${r.pool}:${r.outcome}`), ['simulator:released']);
    assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid]);
    assert.equal(leasesNow().length, 0); assertForeignUntouched(m);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('an expired lease of a live holder keeps its slot; only a dead holder identity frees it and its simulator', async () => {
  const s = appRepo(), m = fakeMachine();
  const cleanup = hostCleanup({ PATH: m.PATH });
  const build = await acquireLease({ pool: 'build', capacity: 1, holder: 'stalled-build', ttlMs: 60_000, waitMs: 0, cleanup });
  const sim = await acquireLease({ pool: 'simulator', capacity: 1, holder: 'stalled-test', ttlMs: 60_000, waitMs: 0, cleanup });
  assert(build.lease && sim.lease);
  const name = 'ym-expired-0001';
  sim.lease.own({ kind: 'simulator', name, udid: null });
  sh(s.repo, join(m.bin, 'xcrun'), ['simctl', 'create', name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'com.apple.CoreSimulator.SimRuntime.iOS-26-5']);
  // A stalled or suspended controller stops renewing, but its process (and its xcodebuild) is still alive.
  const expire = () => { const db = openDb(); try { db.prepare('UPDATE resource_leases SET expires_at = ?').run(Date.now() - 1000); } finally { db.close(); } };
  expire();
  assert.deepEqual(await reapLeases(cleanup), [], 'expiry alone is not proof of death');
  assert.equal(build.lease.holds(), true); assert.equal(sim.lease.holds(), true);
  const contender = await acquireLease({ pool: 'build', capacity: 1, holder: 'next', ttlMs: 60_000, waitMs: 300, pollMs: 250, cleanup });
  assert.equal(contender.lease, null, 'nobody else gets the build slot while its holder lives');
  assert.equal(m.state().devices.length, 2, 'the live holder keeps its simulator');
  // Once the recorded holder identity is dead, the slot is reclaimed and only its recorded simulator removed.
  const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
  const db = openDb(); try { db.prepare('UPDATE resource_leases SET pid = ?, proc_started = NULL').run(dead.pid!); } finally { db.close(); }
  const results = await reapLeases(cleanup);
  assert.deepEqual(results.map(r => `${r.pool}:${r.outcome}`).sort(), ['build:released', 'simulator:released']);
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid]);
  assertForeignUntouched(m);
});

test('cleanup refuses a recorded UDID whose simulator no longer carries the recorded name', async () => {
  const s = appRepo(), m = fakeMachine();
  const r = await cleanupOwnedSimulators({ xcrun: join(m.bin, 'xcrun'), cwd: s.repo, env: { PATH: m.PATH } }, [{ kind: 'simulator', name: 'ym-not-the-foreign-one', udid: FOREIGN.udid }]);
  assert.equal(r.ok, false); assert.match(r.detail, /left untouched/);
  assertForeignUntouched(m);
});

test('memory pressure holds heavy device work before any simulator is created, then admits it', async () => {
  const s = appRepo(), m = fakeMachine();
  const warn = async (): Promise<MemorySample> => ({ availableMb: 9000, pressure: 'warn', sampledAt: Date.now() });
  const held = await runAppleSimulator(options(), context(s, m, { sampleMemory: warn, devices: devices({ waitMinutes: 0 }) }));
  assert.equal(held.result.status, 'unknown'); assert.match(held.result.summary, /memory pressure is warn/);
  assert.equal(created(m).length, 0); assert.equal(leasesNow().length, 0);
  let calls = 0;
  const easing = async (): Promise<MemorySample> => ({ availableMb: 9000, pressure: ++calls > 3 ? 'normal' : 'critical', sampledAt: Date.now() });
  const admitted = await runAppleSimulator(options(), context(s, m, { sampleMemory: easing }));
  assert.equal(admitted.result.status, 'passed', admitted.result.summary);
  assert(admitted.result.data.evidence.lease!.waitedMs > 0);
  assert.equal(memoryHold({ availableMb: 500, pressure: 'normal', sampledAt: 0 }, { minFreeMemMb: 1024, holdAtPressure: 'critical' }), '500 MB memory available (minimum 1024 MB)');
  assert.equal(memoryHold({ availableMb: 9000, pressure: 'warn', sampledAt: 0 }, { minFreeMemMb: 0, holdAtPressure: 'off' }), null);
});

test('the first task waits for memory pressure, not only tasks after one is already running', async () => {
  const s = sandbox();
  const calls: string[] = [];
  const client = new Proxy({}, { get: (_t, name: string) => name === 'then' ? undefined : async () => { calls.push(name); return null; } }) as Client;
  let pressure: MemorySample['pressure'] = 'critical';
  const loop = new WorkerLoop({ client, machineId: 'm-admission', repos: () => ({}), agents: () => ['mock'], localConfig: () => loadConfig(s.repo),
    verifySlots: new Semaphore(1), loadPerCpu: () => 0, sampleMemory: async () => ({ availableMb: 9000, pressure, sampledAt: Date.now() }) });
  await loop.tick();
  assert.equal(loop.active.size, 0);
  assert(!calls.includes('worker.claim'), 'no claim while memory pressure is critical');
  assert(calls.includes('task.event'));
  pressure = 'normal';
  await loop.tick();
  assert(calls.includes('worker.claim'));
});

test('leases survive hub restarts: a live holder keeps its slot, a crashed one is freed by the next hub', async () => {
  const s = appRepo(), marker = join(s.home, 'holder-ready'), release = join(s.home, 'holder-release');
  const wait = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'1');const p=process.ppid;setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})||process.ppid!==p)process.exit(0)},50);`;
  const holder = spawn(process.execPath, [cli, 'devices', 'lease', 'simulator', '--wait-minutes', '0', '--', process.execPath, '-e', wait],
    { cwd: s.repo, env: { ...process.env, YARDMASTER_HOME: s.home }, stdio: 'ignore' });
  const contend = () => acquireLease({ pool: 'simulator', capacity: 1, holder: 'other-project', projectId: 'p-other', ttlMs: 60_000, waitMs: 200, pollMs: 50, cleanup: async () => ({ ok: true, detail: '' }) });
  try {
    await until(() => existsSync(marker), Boolean, 30_000, 'the CLI to hold a lease');
    for (const round of [1, 2]) {
      const hub = new Hub({ token: 'fixture', machineId: `m-hub-${round}`, includeMock: true, port: 0, quiet: true, tickMs: 60_000 });
      await hub.start();
      try {
        const status = await hub.client['devices.status']({});
        assert.equal(status.leases.filter(l => l.state === 'held').length, 1, `restart ${round} keeps the live holder's lease`);
        const blocked = await contend();
        assert.equal(blocked.lease, null);
        assert.match((blocked as { reason: string }).reason, /queue position 1/);
      } finally { await hub.stop(); hub.coord.db.close(); }
    }
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
    const hub = new Hub({ token: 'fixture', machineId: 'm-hub-3', includeMock: true, port: 0, quiet: true, tickMs: 60_000 });
    await hub.start();
    try {
      assert.equal(leasesNow().length, 0, 'the hub start reaped the crashed holder');
      assert(hub.coord.eventsSince(0, null, 50).some(e => e.kind === 'device.lease_reaped'));
      const granted = await contend();
      assert(granted.lease); granted.lease.release();
    } finally { await hub.stop(); hub.coord.db.close(); }
  } finally { writeFileSync(release, '1'); if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); }
});

test('apple-simulator is opt-in and eligible only with xcrun present and valid options', () => {
  const s = appRepo(), m = fakeMachine(), plugins = builtinProviders();
  const opts = { bundleId: 'dev.yardmaster.smoke', build: { app: 'build/Smoke.app' } };
  const cfg = (o: unknown) => ServicesConfigSchema.parse({ providers: { 'apple-simulator': { options: o } }, routes: { 'device.test': { prefer: ['apple-simulator'] } } });
  assert.equal(planService('device.test', cfg(opts), plugins, s.repo, { PATH: m.PATH }).selected, 'apple-simulator');
  assert.match(planService('device.test', cfg(opts), plugins, s.repo, { PATH: '/nonexistent' }).candidates[0]!.reasons.join(' '), /xcrun is missing/);
  assert.match(planService('device.test', cfg({ build: { app: 'x' } }), plugins, s.repo, { PATH: m.PATH }).candidates[0]!.reasons.join(' '), /options are invalid: bundleId/);
  assert.equal(planService('device.test', ServicesConfigSchema.parse({ providers: { 'apple-simulator': { options: opts } } }), plugins, s.repo, { PATH: m.PATH }).selected, null, 'enabling alone does not route device.test');
});

for (const requires of ['simulator', 'physical'] as const) test(`managed task acceptance with a ${requires} requirement records device evidence for the dashboard`, async () => {
  const m = fakeMachine();
  const services = { providers: { 'apple-simulator': { options: { bundleId: 'dev.yardmaster.smoke', requires,
    build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app' }, tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', SMOKE] }] } } },
    routes: { 'device.test': { prefer: ['apple-simulator'] } }, verify: [{ capability: 'device.test' }] };
  const s = appRepo({ services, review: { mode: 'never' }, worktree: { warmStart: 'off' }, integration: { trainSize: 1, syncBase: false } });
  const previous = process.env.PATH; process.env.PATH = m.PATH;
  const hub = new Hub({ db: openDb(), token: 'fixture', machineId: 'm-fixture', includeMock: true });
  try {
    const project = await hub.coord.registerProject(s.repo);
    const task = hub.coord.addTasks(project.id, [{ title: 'Change the smoke app', prompt: '@mock write result.txt correct', agent: 'mock' }], 'test').created[0]!;
    const claim = hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [project.id]: s.repo }, runningByAgent: {} })!;
    const outcome = await runAttempt({ api: hub.client, machineId: 'm-fixture', task: claim.task, project, repoPath: s.repo,
      agent: 'mock', model: null, config: loadConfig(s.repo), startPoint: (await hub.integrator.head(project.id))!, verifySlots: new Semaphore(1), installed: ['mock'] });
    assert.equal(outcome.status, requires === 'simulator' ? 'ready' : 'needs_human');
    const detail = await hub.client['task.get']({ id: task.id });
    const e = detail.devices[0]!.evidence as DeviceEvidence;
    assert.equal(e.taskId, task.id); assert.equal(e.projectId, project.id);
    assert.equal(e.commit, hub.coord.getTask(task.id)!.head_sha);
    assert.equal(e.status.code, 'passed', 'acceptance ran the shell checks before the device check');
    assert.equal(e.status.simulator, 'passed'); assert.equal(e.status.physical, 'untested');
    assert.equal(e.status.overall, requires === 'simulator' ? 'passed' : 'unknown');
    assert(detail.devices[0]!.receiptPath?.endsWith('result.json'));
    if (requires === 'physical') assert.match(hub.coord.getTask(task.id)!.attention ?? '', /physical device untested/i);
    const status = await hub.client['devices.status']({ projectId: project.id });
    assert.equal(status.evidence.length, 1); assert.equal(status.leases.length, 0);
    assertForeignUntouched(m);
  } finally { process.env.PATH = previous; await hub.integrator.stop(); hub.coord.db.close(); }
});

test('ym verify gates on device evidence for HEAD and records it for ym devices evidence', async () => {
  const m = fakeMachine();
  const s = appRepo();
  writeFileSync(join(s.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], services: {
    providers: { 'apple-simulator': { options: { bundleId: 'dev.yardmaster.smoke', build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app' } } } },
    routes: { 'device.test': { prefer: ['apple-simulator'] } }, verify: [{ capability: 'device.test' }] } }));
  sh(s.repo, 'git', ['add', '-A']); sh(s.repo, 'git', ['commit', '-q', '-m', 'device acceptance']);
  const head = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
  const run = (args: string[]) => new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: s.repo, env: { ...process.env, PATH: m.PATH, YARDMASTER_HOME: s.home } });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; });
    child.once('exit', code => resolve({ code, out }));
  });
  const verified = await run(['verify', '--json']);
  assert.equal(verified.code, 0, verified.out);
  assert.equal(JSON.parse(verified.out).sha, head);
  const listed = await run(['devices', 'evidence', '--json']);
  const [item] = JSON.parse(listed.out) as { evidence: DeviceEvidence }[];
  assert.equal(item!.evidence.commit, head); assert.equal(item!.evidence.status.simulator, 'passed'); assert.equal(item!.evidence.status.code, 'passed');
  const text = await run(['devices', 'evidence']);
  assert.match(text.out, new RegExp(`PASSED ${head.slice(0, 12)}: code passed, simulator passed, physical device untested \\[iPhone 17, iOS 26\\.5 \\(simulator\\)\\]`));
  const db = openDb(); try { assert.equal(deviceEvidence(db).length, 1); } finally { db.close(); }
  // Evidence that names another commit cannot pass acceptance, even when its provider says passed.
  const forged = ServicesConfigSchema.parse({ local: { 'device.test': { service: 'device', command: [process.execPath, '-e',
    `console.log(JSON.stringify({status:'passed',summary:'ok',data:{evidence:${JSON.stringify({ ...item!.evidence, commit: 'a'.repeat(40) })}}}))`], protocol: 'json', locality: 'local', cost: 'free' } },
    verify: [{ capability: 'device.test' }] });
  const gate = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services: forged });
  assert.equal(gate.ok, false); assert.equal(gate.serviceStatus, 'unknown'); assert.match(gate.output, /does not establish a pass/);
});

test('declared credentials are redacted from saved device logs and evidence', async () => {
  const s = appRepo(), m = fakeMachine(), secret = 'device-lab-credential-value';
  const run = await runAppleSimulator(options({ requiredEnv: ['LAB_TOKEN'], build: { command: [process.execPath, '-e', `${BUILD}console.log('token='+process.env.LAB_TOKEN)`], app: 'build/Smoke.app' },
    tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', `console.log(process.env.LAB_TOKEN);process.exit(1)`] }] }),
    context(s, m, { env: { PATH: m.PATH, HOME: s.home, LAB_TOKEN: secret } }));
  assert.equal(run.result.status, 'failed');
  for (const file of run.result.data.evidence.files.filter(f => f.kind === 'log')) assert(!readFileSync(file.path, 'utf8').includes(secret), file.path);
  assert(!readFileSync(join(run.result.artifacts[0]!), 'utf8').includes(secret));
  assert.match(readFileSync(run.result.data.evidence.checks.find(c => c.name === 'build')!.log!, 'utf8'), /token=\[redacted\]/);
});

test('built-in phase names are reserved, so a user test can never hide among them', () => {
  for (const name of ['build', 'boot', 'install', 'launch']) {
    assert.throws(() => options({ tests: [{ name, runner: 'command', command: ['true'] }] }), /reserved check names/);
  }
});

test('the run installs and hashes its own copy of the build, not output a later build overwrote', async () => {
  const s = appRepo(), m = fakeMachine();
  const blocker = await acquireLease({ pool: 'simulator', capacity: 1, holder: 'blocker', ttlMs: 60_000, waitMs: 0, cleanup: async () => ({ ok: true, detail: '' }) });
  assert(blocker.lease);
  // The test reads the app through both inputs it is given; both must be the copy that was hashed and installed.
  const READ = `const fs=require('node:fs');const d=process.env.YARDMASTER_ARTIFACT_DIR;fs.writeFileSync(d+'/env.txt',fs.readFileSync(process.env.YARDMASTER_APP_PATH+'/Smoke','utf8'));fs.writeFileSync(d+'/arg.txt',fs.readFileSync(process.argv[1]+'/Smoke','utf8'));`;
  const ctx = context(s, m);
  const running = runAppleSimulator(options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', READ, '{app}'] }] }), ctx);
  // Once it queues for the simulator its build is done; another build now rewrites the shared output.
  await until(() => leasesNow(), leases => leases.some(l => l.state === 'waiting'), 20_000, 'the run to queue for a simulator');
  const app = join(s.repo, 'build/Smoke.app');
  const original = artifactSha256(app);
  writeFileSync(join(app, 'Smoke'), 'binary from someone else');
  blocker.lease.release();
  const run = await running;
  assert.equal(run.result.status, 'passed', run.result.summary);
  assert.equal(run.result.data.evidence.artifact!.sha256, original);
  const installed = m.log().find(e => e.args[1] === 'install')!.args[3]!;
  assert.notEqual(installed, app, 'installed from the run-owned snapshot');
  for (const input of ['env.txt', 'arg.txt']) assert.equal(readFileSync(join(ctx.evidenceDir, 'tests', 'smoke', input), 'utf8'), `binary for ${s.sha}\n`, `tests read the installed copy via ${input}`);
  assert(!existsSync(installed), 'the snapshot is removed after the run');
});

test('a project cannot raise the machine-wide simulator limit set in the global config', async () => {
  const s = appRepo({ devices: { holdAtPressure: 'off', minFreeMemMb: 0, limits: { simulator: 1 } } }), m = fakeMachine();
  writeFileSync(join(s.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], devices: { limits: { simulator: 2 }, waitMinutes: 0 } }));
  sh(s.repo, 'git', ['commit', '-qam', 'project asks for two simulators']);
  const other = await acquireLease({ pool: 'simulator', capacity: 1, holder: 'other-project', ttlMs: 60_000, waitMs: 0, cleanup: async () => ({ ok: true, detail: '' }) });
  assert(other.lease);
  try {
    const run = await runAppleSimulator(options(), { ...context(s, m), devices: undefined });
    assert.equal(run.result.status, 'unknown');
    assert.match(run.result.summary, /No simulator slot: waiting in queue position 1/);
    assert.equal(created(m).length, 0);
  } finally { other.lease.release(); }
});

test('malformed device evidence cannot pass acceptance', async () => {
  const s = appRepo();
  const services = ServicesConfigSchema.parse({ local: { 'device.test': { service: 'device', command: [process.execPath, '-e',
    `console.log(JSON.stringify({status:'passed',summary:'ok',data:{evidence:{kind:'yardmaster.device-evidence',commit:${JSON.stringify(s.sha)}}}}))`], protocol: 'json', locality: 'local', cost: 'free' } },
    verify: [{ capability: 'device.test' }] });
  const gate = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services });
  assert.equal(gate.ok, false); assert.equal(gate.serviceStatus, 'unknown'); assert.match(gate.output, /malformed device evidence/);
});

test('two reapers racing over one crashed holder clean its simulator once', async () => {
  appRepo();
  const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
  const db = openDb();
  try {
    db.prepare(`INSERT INTO resource_leases (id, pool, state, holder, host, pid, proc_started, queued_at, acquired_at, expires_at, owned)
      VALUES ('l-crashed', 'simulator', 'held', 'gone', ?, ?, NULL, ?, ?, ?, ?)`).run((await import('../src/paths.ts')).machineId(), dead.pid!, Date.now(), Date.now(), Date.now() + 60_000,
      JSON.stringify([{ kind: 'simulator', name: 'ym-crashed-0001', udid: null }]));
  } finally { db.close(); }
  let cleanups = 0;
  const cleanup = async () => { cleanups++; await new Promise(resolve => setTimeout(resolve, 100)); return { ok: true, detail: 'removed' }; };
  const results = (await Promise.all([reapLeases(cleanup), reapLeases(cleanup)])).flat();
  assert.equal(cleanups, 1);
  assert.deepEqual(results.map(r => r.outcome), ['released']);
  assert.equal(leasesNow().length, 0);
});

test('the default runtime is the newest by version parts, not by string length', () => {
  const runtime = (version: string) => ({ identifier: `rt-${version}`, name: `iOS ${version}`, version, isAvailable: true, platform: 'iOS', supportedDeviceTypes: [{ identifier: 'phone', name: 'iPhone 17', productFamily: 'iPhone' }] });
  const target = chooseTarget({ devicetypes: [], runtimes: [runtime('18.5.1'), runtime('18.6'), runtime('9.3')], devices: {} }, {});
  assert(!('error' in target)); assert.equal(target.runtime.version, '18.6');
  assert.equal(compareVersions('18.6', '18.5.1') > 0, true); assert.equal(compareVersions('26.0', '26'), 0);
});

test('credentials echoed into test reports and app logs are scrubbed before they are hashed', async () => {
  const s = appRepo(), m = fakeMachine(), secret = 'report-credential-value-1234';
  const run = await runAppleSimulator(options({ requiredEnv: ['LAB_TOKEN'], tests: [{ name: 'report', runner: 'command',
    command: [process.execPath, '-e', `require('node:fs').writeFileSync(process.env.YARDMASTER_ARTIFACT_DIR+'/junit.xml','<case token="'+process.env.LAB_TOKEN+'"/>')`] }] }),
    context(s, m, { env: { PATH: m.PATH, HOME: s.home, LAB_TOKEN: secret } }));
  assert.equal(run.result.status, 'passed', run.result.summary);
  const report = run.result.data.evidence.files.find(f => f.path.endsWith('junit.xml'))!;
  assert.equal(readFileSync(report.path, 'utf8'), '<case token="[redacted]"/>');
  assert.equal(artifactSha256(report.path), report.sha256, 'the recorded hash is of the scrubbed file');
  for (const f of run.result.data.evidence.files.filter(f => f.kind === 'log')) assert.equal(artifactSha256(f.path), f.sha256, `${f.path} hash matches the kept file`);
});

function claimed(sha: string, over: { requirement?: string; status?: Record<string, string>; device?: Record<string, unknown> | null }) {
  return { kind: 'yardmaster.device-evidence', version: 1, requestId: null, projectId: null, taskId: null, commit: sha, requirement: over.requirement ?? 'simulator',
    status: { code: 'not-run', simulator: 'passed', physical: 'untested', overall: 'passed', ...over.status },
    artifact: null, environment: { machineId: 'm', os: 'darwin', arch: 'arm64', xcode: null },
    device: over.device === undefined ? { kind: 'simulator', name: 'n', model: 'iPhone 17', modelIdentifier: null, runtime: 'iOS 26.5', runtimeIdentifier: 'rt', udid: 'U', createdByYardmaster: false } : over.device,
    checks: [], files: [], lease: null, startedAt: '', completedAt: '', summary: 'provider says ok' };
}
function deviceProvider(payload: unknown, input: unknown) {
  const script = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify(${JSON.stringify(payload)})))`;
  return ServicesConfigSchema.parse({ local: { 'device.test': { service: 'device', command: [process.execPath, '-e', script], protocol: 'json', locality: 'local', cost: 'free' } },
    verify: [{ capability: 'device.test', input }] });
}

test('acceptance enforces the requested device level and device consistency, not the provider\'s own claim', async () => {
  const s = appRepo();
  const { runService } = await import('../src/providers.ts');
  const { evidenceProblem, requiredDeviceLevel } = await import('../src/device-evidence.ts');
  const physicalDevice = { kind: 'physical', name: 'Phone', model: 'iPhone 16', modelIdentifier: 'iPhone17,3', runtime: 'iOS 26.5', runtimeIdentifier: 'rt', udid: 'D', createdByYardmaster: false };
  // The level comes from the check input, then the project's provider options; the provider's report never sets it.
  assert.equal(requiredDeviceLevel({ requires: 'physical' }, { requires: 'simulator' }), 'physical');
  assert.equal(requiredDeviceLevel({}, { requires: 'physical' }), 'physical');
  assert.equal(requiredDeviceLevel({}, {}), null);
  const parse = (o: unknown) => DeviceEvidenceSchema.parse(o);
  // Asked for physical; a provider answering with simulator evidence for a simulator requirement does not pass.
  assert.match(evidenceProblem(parse(claimed(s.sha, {})), s.sha, 'physical')!, /answers a simulator requirement, but this check requires physical/);
  // Simulator evidence claiming a physical pass is inconsistent.
  assert.match(evidenceProblem(parse(claimed(s.sha, { requirement: 'physical', status: { physical: 'passed' } })), s.sha, 'physical')!, /physical-device pass on a simulator/);
  // A real physical pass satisfies physical, and also a simulator-level requirement.
  const real = parse(claimed(s.sha, { requirement: 'physical', status: { simulator: 'not-run', physical: 'passed' }, device: physicalDevice }));
  assert.equal(evidenceProblem(real, s.sha, 'physical'), null);
  assert.equal(evidenceProblem(real, s.sha, 'simulator'), null);
  // End to end through acceptance, with a provider plugin that reports whatever it likes.
  for (const [payload, input, expect] of [
    [{ status: 'passed', summary: 'ok', data: { evidence: claimed(s.sha, {}) } }, { requires: 'physical' }, /requires physical/],
    [{ status: 'passed', summary: 'ok', data: { evidence: claimed(s.sha, { requirement: 'physical', status: { physical: 'passed' } }) } }, { requires: 'physical' }, /physical-device pass on a simulator/],
    [{ status: 'passed', summary: 'ok' }, { requires: 'physical' }, /requires a physical device pass; local reported a pass without device evidence/],
    [{ status: 'passed', summary: 'ok', data: { evidence: claimed(s.sha, { requirement: 'physical', status: { simulator: 'not-run', physical: 'passed' }, device: physicalDevice }) } }, { requires: 'physical' }, null],
  ] as const) {
    const services = deviceProvider(payload, input);
    const run = await runService('device.test', input, services, [], { cwd: s.repo, context: { sha: s.sha } });
    assert.equal(run.result.status, 'passed', 'the provider itself reports a pass every time');
    const gate = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services });
    if (expect) { assert.equal(gate.ok, false, JSON.stringify(payload)); assert.equal(gate.serviceStatus, 'unknown'); assert.match(gate.output, expect); }
    else assert.equal(gate.ok, true, gate.output);
  }
});

test('Linux admission counts reclaimable cache through MemAvailable, not only free pages', () => {
  // A healthy machine whose RAM is mostly page cache: about 403 MB "free" but 11.3 GB available.
  const available = linuxAvailableMb(join(import.meta.dirname, 'fixtures/meminfo-cache-heavy.txt'))!;
  assert.equal(Math.round(available), 11596);
  assert.equal(memoryHold({ availableMb: available, pressure: null, sampledAt: 0 }, { minFreeMemMb: 1024, holdAtPressure: 'critical' }), null);
  assert.notEqual(memoryHold({ availableMb: 412880 / 1024, pressure: null, sampledAt: 0 }, { minFreeMemMb: 1024, holdAtPressure: 'critical' }), null, 'free pages alone would hold all work');
  assert.equal(meminfoAvailableMb('MemTotal: 1 kB\nMemFree: 1 kB\n'), null, 'old kernels without MemAvailable fall back to freemem');
  assert.equal(linuxAvailableMb(join(import.meta.dirname, 'fixtures/no-such-meminfo')), null);
});

test('scrubbing streams any file size and catches secrets split across chunk boundaries', async () => {
  const dir = tempDir('ym-scrub-'), file = join(dir, 'report.bin'), secret = 'chunk-split-secret', other = 'short-key';
  const body = `head ${secret} middle ${other}${secret}tail ${secret}`;
  for (const chunk of [1, 3, 5, 7, 16, 1 << 20]) {
    writeFileSync(file, body);
    assert.equal(scrubFile(file, [other, secret], chunk), true);
    assert.equal(readFileSync(file, 'utf8'), 'head [redacted] middle [redacted]tail [redacted]', `chunk ${chunk}`);
  }
  writeFileSync(file, 'nothing to hide');
  assert.equal(scrubFile(file, [secret], 4), false);
  assert.equal(readFileSync(file, 'utf8'), 'nothing to hide');
  // Through the device run: a 9 MiB report with the credential right at the 1 MiB read boundary is kept only scrubbed.
  const s = appRepo(), m = fakeMachine(), big = 'large-report-credential-0000';
  const write = `const fs=require('node:fs');const b=Buffer.alloc(9*1024*1024,'x');b.write(process.env.LAB_TOKEN,1024*1024-5);b.write(process.env.LAB_TOKEN,b.length-40);fs.writeFileSync(process.env.YARDMASTER_ARTIFACT_DIR+'/huge.log',b)`;
  const run = await runAppleSimulator(options({ requiredEnv: ['LAB_TOKEN'], tests: [{ name: 'report', runner: 'command', command: [process.execPath, '-e', write] }] }),
    context(s, m, { env: { PATH: m.PATH, HOME: s.home, LAB_TOKEN: big } }));
  assert.equal(run.result.status, 'passed', run.result.summary);
  const kept = run.result.data.evidence.files.find(f => f.path.endsWith('huge.log'))!;
  const content = readFileSync(kept.path);
  assert.equal(content.includes(big), false, 'no unsanitized file is kept as evidence');
  assert.equal(content.indexOf('[redacted]'), 1024 * 1024 - 5);
  assert.equal(artifactSha256(kept.path), kept.sha256);
});

test('device commands re-inspect cleanup that could not be verified before reporting it unconfirmed', async () => {
  appRepo();
  // A ps whose process census fails, like an ownership inspection missing its deadline on a loaded machine.
  const bin = tempDir('ym-slow-ps-'), flag = join(bin, 'failures');
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "-U" ]; then n=$(cat "${flag}" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${flag}"; exit 1; fi; fi; done\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const ctx = { cwd: bin, env: { PATH: process.env.PATH, HOME: process.env.HOME } };
    writeFileSync(flag, '1');
    const once = await exec(ctx, process.execPath, ['-e', ''], { timeoutMs: 30_000, reinspectDelayMs: 10 });
    assert.equal(once.reaped, true, `a single failed inspection is re-checked: ${once.cleanup}`);
    assert.equal(once.cleanup, ''); assert.equal(once.ok, true);
    writeFileSync(flag, '99');
    const always = await exec(ctx, process.execPath, ['-e', ''], { timeoutMs: 30_000, reinspectDelayMs: 10 });
    assert.equal(always.reaped, false, 'inspection that never completes stays unconfirmed');
    assert.match(always.cleanup, /^unverified/);
  } finally { process.env.PATH = previous; }
});

test('evidence that is not a pass is never accepted, even with an empty summary', () => {
  const sha = 'a'.repeat(40);
  for (const overall of ['unknown', 'failed']) {
    const e = DeviceEvidenceSchema.parse({ ...claimed(sha, { status: { overall } }), summary: '' });
    const problem = evidenceProblem(e, sha, 'simulator');
    assert.ok(problem, `${overall} with an empty summary is a problem`);
    assert.match(problem, new RegExp(`overall status is ${overall}`));
  }
});

test('a stated device requirement needs device evidence whatever service the provider declares', async () => {
  const s = appRepo();
  for (const service of ['ci', 'browser', 'device'] as const) for (const requires of ['physical', 'simulator'] as const) {
    const script = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({status:'passed',summary:'trust me'})))`;
    const services = ServicesConfigSchema.parse({ local: { 'device.test': { service, command: [process.execPath, '-e', script], protocol: 'json', locality: 'local', cost: 'free' } },
      verify: [{ capability: 'device.test', input: { requires } }] });
    const gate = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services });
    assert.equal(gate.ok, false, `${service}/${requires}`); assert.equal(gate.serviceStatus, 'unknown');
    assert.match(gate.output, new RegExp(`requires a ${requires} device pass`));
  }
  // With no stated requirement, a provider without device evidence keeps working as before.
  const plain = ServicesConfigSchema.parse({ local: { 'device.test': { service: 'ci', command: [process.execPath, '-e', 'process.exit(0)'], protocol: 'command', locality: 'local', cost: 'free' } },
    verify: [{ capability: 'device.test' }] });
  assert.equal((await verifyArtifact(s.repo, [], 1, undefined, undefined, { services: plain })).ok, true);
});

const runCli = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  child.once('exit', code => resolve({ code, out, err }));
});
function insertLease(over: { pid: number; procStarted: number | null; bootId: string | null; expiresAt: number; owned?: unknown[] }) {
  const db = openDb();
  try {
    db.prepare(`INSERT INTO resource_leases (id, pool, state, holder, host, pid, proc_started, boot_id, queued_at, acquired_at, expires_at, owned)
      VALUES (?, 'simulator', 'held', 'old-holder', ?, ?, ?, ?, ?, ?, ?, ?)`).run(`l-${randomUUID()}`, machineId(), over.pid, over.procStarted, over.bootId,
      Date.now(), Date.now(), over.expiresAt, JSON.stringify(over.owned ?? []));
  } finally { db.close(); }
  return leasesNow().at(-1)!;
}

test('no lease is granted without a readable holder start time', { skip: process.platform === 'linux' && 'Linux reads start times from /proc, without ps' }, async () => {
  const s = appRepo();
  const bin = tempDir('ym-no-lstart-');
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = "-o" ] && [ "$2" = "lstart=" ]; then exit 1; fi\nexec /bin/ps "$@"\n', { mode: 0o755 });
  const r = await runCli(s.repo, ['devices', 'lease', 'build', '--wait-minutes', '0', '--', process.execPath, '-e', ''], { ...process.env, PATH: `${bin}:${process.env.PATH}`, YARDMASTER_HOME: s.home });
  assert.equal(r.code, 1);
  assert.match(r.err, /Cannot read this process's start time, so it cannot hold a device lease safely/);
  assert.equal(leasesNow().length, 0, 'nothing was recorded without an identity');
});

test('a holder PID from an earlier boot is never treated as alive, even if the PID is in use now', async () => {
  appRepo(); const m = fakeMachine();
  const { selfIdentity } = await import('../src/leases.ts');
  const me = await selfIdentity();
  assert.ok(me.bootId, 'this platform reports a boot identity');
  const name = 'ym-old-boot-0001';
  execFileSync(join(m.bin, 'xcrun'), ['simctl', 'create', name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'com.apple.CoreSimulator.SimRuntime.iOS-26-5']);
  // Same PID and start time as a live process (this one), but recorded during a previous boot.
  insertLease({ pid: me.pid, procStarted: me.startedAt, bootId: 'previous-boot', expiresAt: Date.now() + 60_000, owned: [{ kind: 'simulator', name, udid: null }] });
  const results = await reapLeases(hostCleanup({ PATH: m.PATH }));
  assert.deepEqual(results.map(r => r.outcome), ['released']);
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid]);
  assertForeignUntouched(m);
});

test('owners can recover a stale claim whose holder cannot be identified; verifiable holders are refused', async () => {
  const s = appRepo(), m = fakeMachine();
  const env = { ...process.env, PATH: m.PATH, YARDMASTER_HOME: s.home };
  const name = 'ym-unidentified-01';
  execFileSync(join(m.bin, 'xcrun'), ['simctl', 'create', name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', 'com.apple.CoreSimulator.SimRuntime.iOS-26-5']);
  // A legacy claim with no start identity on a PID that is in use (this test process): never presumed dead.
  const stale = insertLease({ pid: process.pid, procStarted: null, bootId: null, expiresAt: Date.now() - 1000, owned: [{ kind: 'simulator', name, udid: null }] });
  assert.deepEqual(await reapLeases(hostCleanup({ PATH: m.PATH })), [], 'an unverifiable holder is not reaped automatically');
  const short = await runCli(s.repo, ['devices', 'recover', stale.id, '--note', 'short'], env);
  assert.equal(short.code, 1);
  const recovered = await runCli(s.repo, ['devices', 'recover', stale.id, '--note', 'host rebooted; old controller is gone', '--json'], env);
  assert.equal(recovered.code, 0, recovered.err);
  assert.equal(JSON.parse(recovered.out).outcome, 'released');
  assert.equal(leasesNow().length, 0);
  assert.deepEqual(m.state().devices.map(d => d.udid), [FOREIGN.udid], 'only the recorded simulator was deleted');
  assertForeignUntouched(m);
  // A verifiable live holder, and a lease still being renewed, are refused.
  const { selfIdentity } = await import('../src/leases.ts');
  const me = await selfIdentity();
  const live = insertLease({ pid: me.pid, procStarted: me.startedAt, bootId: me.bootId, expiresAt: Date.now() - 1000 });
  assert.match((await runCli(s.repo, ['devices', 'recover', live.id, '--note', 'trying to take a live slot'], env)).err, /is alive with the recorded identity; stop it first/);
  const fresh = insertLease({ pid: process.pid, procStarted: null, bootId: null, expiresAt: Date.now() + 60_000 });
  assert.match((await runCli(s.repo, ['devices', 'recover', fresh.id, '--note', 'trying to take a renewed slot'], env)).err, /still being renewed/);
});

test('overlapping secrets are redacted as one span, within a chunk and across chunk boundaries', () => {
  const secrets = ['ab', 'b0123456789'];
  assert.equal(redactText('xab0123456789y', secrets), 'x[redacted]y');
  assert.equal(redactText('abcd', ['ab', 'bc', 'cd']), '[redacted]', 'a chain of overlaps is one span');
  const dir = tempDir('ym-overlap-'), file = join(dir, 'log.txt');
  for (let chunk = 1; chunk <= 16; chunk++) for (const body of ['xab0123456789y', 'ab0123456789', 'zzzzzzab0123456789ab0123456789', 'abcd--abcd']) {
    writeFileSync(file, body);
    scrubFile(file, [...secrets, 'bc', 'cd'], chunk);
    const kept = readFileSync(file, 'utf8');
    for (const fragment of ['ab', '0123456789', 'bc', 'cd']) assert(!kept.includes(fragment), `chunk ${chunk}: "${body}" kept "${fragment}" in "${kept}"`);
    assert.equal(kept, redactText(body, [...secrets, 'bc', 'cd']), `chunk ${chunk}: streaming agrees with in-memory redaction`);
  }
});

test('binary evidence is kept byte-identical or omitted when it holds a credential, never rewritten', async () => {
  const s = appRepo(), m = fakeMachine(), secret = 'png-embedded-credential-77';
  const write = `const fs=require('node:fs'),d=process.env.YARDMASTER_ARTIFACT_DIR;const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
fs.writeFileSync(d+'/clean.png',Buffer.concat([png,Buffer.from([0,1,2,3,0,255])]));
fs.writeFileSync(d+'/leaky.png',Buffer.concat([png,Buffer.from([0]),Buffer.from(process.env.LAB_TOKEN),Buffer.from([0,9])]));`;
  const run = await runAppleSimulator(options({ requiredEnv: ['LAB_TOKEN'], tests: [{ name: 'shots', runner: 'command', command: [process.execPath, '-e', write] }] }),
    context(s, m, { env: { PATH: m.PATH, HOME: s.home, LAB_TOKEN: secret } }));
  assert.equal(run.result.status, 'passed', run.result.summary);
  const e = run.result.data.evidence;
  const clean = e.files.find(f => f.path.endsWith('clean.png'))!;
  assert.deepEqual(readFileSync(clean.path), Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 1, 2, 3, 0, 255])]), 'a screenshot without secrets is byte-identical');
  assert.equal(artifactSha256(clean.path), clean.sha256);
  assert(!e.files.some(f => f.path.endsWith('leaky.png')), 'a binary holding a credential is not kept as evidence');
  const leaky = e.omitted.find(o => o.path.endsWith('leaky.png'))!;
  assert.equal(leaky.reason, 'omitted: contains a declared credential');
  assert.equal(existsSync(leaky.path), false);
  assert(e.files.some(f => f.path.endsWith('launch.png')), 'simulator screenshots stay');
});

test('reaping an empty lease table needs no process identity, so Yardmaster runs where ps is unavailable', async () => {
  const s = appRepo();
  const bin = tempDir('ym-no-ps-');
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = await runCli(s.repo, ['devices', 'reap', '--json'], { ...process.env, PATH: `${bin}:${process.env.PATH}`, YARDMASTER_HOME: s.home });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), []);
});

test('Linux start times come from /proc/<pid>/stat, even with spaces and parentheses in the command name', async () => {
  const { procStartMs } = await import('../src/leases.ts');
  // pid (comm) state ppid ... field 22 (starttime) = 123456 ticks after boot.
  const fields = ['S', '1', ...Array.from({ length: 17 }, (_, i) => String(i + 10)), '123456', '0', '0'];
  const stat = `4242 (node (worker) x) ${fields.join(' ')}`;
  assert.equal(procStartMs(stat, 1_794_700_000), 1_794_700_000_000 + 1_234_560);
  assert.equal(procStartMs('4242 (broken)', 1_794_700_000), null);
  if (process.platform === 'linux') {
    const { selfIdentity } = await import('../src/leases.ts');
    const me = await selfIdentity();
    assert.ok(Math.abs(me.startedAt! - (Date.now() - process.uptime() * 1000)) < 5000, 'this process started about when Node says it did');
  }
});

test('a long run of overlapping matches streams in bounded memory and time', () => {
  const dir = tempDir('ym-run-'), file = join(dir, 'run.log');
  // 16 MiB of "a" with the declared value "aa": every position starts a match, so the whole run is one span.
  const size = 16 * 1024 * 1024;
  writeFileSync(file, Buffer.concat([Buffer.from('start '), Buffer.alloc(size, 'a'), Buffer.from(' end')]));
  const before = process.memoryUsage().arrayBuffers;
  const started = Date.now();
  assert.equal(scrubFile(file, ['aa', 'aaa'], 64 * 1024), true);
  const elapsed = Date.now() - started;
  assert.equal(readFileSync(file, 'utf8'), 'start [redacted] end');
  assert(elapsed < 10_000, `streamed in ${elapsed} ms`);
  // Nothing proportional to the file stays allocated: buffers in use stay far below its size.
  assert(process.memoryUsage().arrayBuffers - before < size / 4, 'no file-sized buffer was retained');
  assert.equal(artifactSha256(file), fileSha256(file));
});
