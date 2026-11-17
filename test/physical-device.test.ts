import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { resolveConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { AppleDeviceOptionsSchema, runAppleDevice } from '../src/apple-device-provider.ts';
import type { DeviceRunContext } from '../src/device-provider.ts';
import { artifactSha256, DeviceEvidenceSchema, evidenceLine, evidenceProblem } from '../src/device-evidence.ts';
import { chooseDevice, deviceKey, type PhysicalDevice } from '../src/devicectl.ts';
import { acquireLease, listLeases } from '../src/leases.ts';
import type { MemorySample } from '../src/machine-pressure.ts';
import { builtinProviders } from '../src/provider-builtins.ts';
import { planService } from '../src/providers.ts';
import { ServicesConfigSchema } from '../src/provider-contract.ts';

const PHONE = { identifier: 'ECED681C-0000-4000-8000-0000000000AA', udid: '00008150-0001632136400AA1', name: "Owner's iPhone", model: 'iPhone 17', productType: 'iPhone18,3',
  os: '27.0', build: '24A435', serial: 'G037TESTSER1', ecid: 390469271994001, pairing: 'paired', developerMode: true, locked: false };
/** Someone else's app on the phone. No run may install over, terminate-by-bundle or remove it unless configured to. */
const FOREIGN = { bundleIdentifier: 'com.owner.app', name: 'Owner App', version: '1.0.0', bundleVersion: '20', url: 'file:///private/var/containers/Bundle/Application/OWN/Owner.app/' };
const normal = async (): Promise<MemorySample> => ({ availableMb: 8000, pressure: 'normal', sampledAt: Date.now() });

function fakePhone(over: { devices?: unknown[]; apps?: Record<string, unknown[]>; config?: Record<string, unknown> } = {}) {
  const bin = tempDir('ym-fake-devicectl-');
  copyFileSync(join(import.meta.dirname, 'fixtures/fake-devicectl.mjs'), join(bin, 'fake-devicectl.mjs'));
  writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-devicectl.mjs')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'phone-state.json'), JSON.stringify({ devices: over.devices ?? [PHONE], apps: over.apps ?? { [PHONE.udid]: [FOREIGN] }, running: [], crashes: {},
    config: { bundleId: 'dev.yardmaster.smoke', ...over.config } }));
  return { bin, PATH: `${bin}:${process.env.PATH}`,
    state: () => JSON.parse(readFileSync(join(bin, 'phone-state.json'), 'utf8')) as { apps: Record<string, { bundleIdentifier: string; installedFrom?: string }[]>; running: { pid: number }[]; crashes: Record<string, string[]>; config: Record<string, unknown> },
    log: () => existsSync(join(bin, 'phone-log.jsonl')) ? readFileSync(join(bin, 'phone-log.jsonl'), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { args: string[] }).args) : [],
    set(config: Record<string, unknown>) { const s = this.state(); Object.assign(s.config, config); writeFileSync(join(bin, 'phone-state.json'), JSON.stringify(s)); } };
}
type Phone = ReturnType<typeof fakePhone>;
const devicectlCalls = (p: Phone, sub: string) => p.log().filter(a => a[0] === 'devicectl' && a.slice(1, 4).join(' ').startsWith(sub));

const BUILD = `const fs=require('node:fs');fs.mkdirSync('build/Smoke.app',{recursive:true});fs.writeFileSync('build/Smoke.app/Smoke','device build of '+require('node:child_process').execSync('git rev-parse HEAD'));`;
/** Passes only when given the real device UDID, the physical kind and the bundle ID; echoes the UDID so redaction is tested. */
const SMOKE = `const e=process.env;if(e.YARDMASTER_DEVICE_KIND!=='physical'||e.YARDMASTER_DEVICE_UDID!==${JSON.stringify(PHONE.udid)}||!e.YARDMASTER_BUNDLE_ID)process.exit(9);console.log('smoke on '+e.YARDMASTER_DEVICE_UDID+' serial ${PHONE.serial}');console.log(${JSON.stringify('device name ' + PHONE.name)});require('node:fs').writeFileSync(e.YARDMASTER_ARTIFACT_DIR+'/result.txt','ok '+e.YARDMASTER_DEVICE_UDID);`;
const hang = (marker: string) => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'held');const p=process.ppid;setInterval(()=>{if(process.ppid!==p)process.exit(0)},100);setTimeout(()=>process.exit(0),60000);`;

function appRepo() {
  const s = sandbox({ devices: { holdAtPressure: 'off', minFreeMemMb: 0, waitMinutes: 1 } });
  writeFileSync(join(s.repo, '.gitignore'), 'build/\n');
  sh(s.repo, 'git', ['add', '-A']); sh(s.repo, 'git', ['commit', '-q', '-m', 'ignore build output']);
  return { ...s, sha: sh(s.repo, 'git', ['rev-parse', 'HEAD']) };
}
const options = (over: Record<string, unknown> = {}) => AppleDeviceOptionsSchema.parse({ bundleId: FOREIGN.bundleIdentifier, settleSeconds: 0,
  tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', SMOKE] }], ...over });
const built = (over: Record<string, unknown> = {}) => options({ bundleId: 'dev.yardmaster.smoke', build: { command: [process.execPath, '-e', BUILD], app: 'build/Smoke.app' }, ...over });
function context(s: { repo: string; home: string; sha: string }, p: Phone, over: Partial<DeviceRunContext> = {}): DeviceRunContext {
  const evidenceDir = join(s.home, 'evidence-' + randomUUID()); mkdirSync(evidenceDir, { recursive: true });
  return { cwd: s.repo, env: { PATH: p.PATH, HOME: s.home }, evidenceDir, input: {}, requestId: randomUUID(),
    context: { sha: s.sha, projectId: 'p-one' }, devices: resolveConfig([{ devices: { minFreeMemMb: 0, waitMinutes: 1 } }]).devices, sampleMemory: normal, pollMs: 100, ...over };
}
const leasesNow = () => { const db = openDb(); try { return listLeases(db); } finally { db.close(); } };
function allText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))
    .filter(file => statSync(file).size < 1_000_000).map(file => readFileSync(file, 'latin1')).join('\n');
}
const assertNoHardwareIds = (dir: string) => {
  const text = allText(dir);
  for (const id of [PHONE.udid, PHONE.identifier, PHONE.serial, String(PHONE.ecid), PHONE.name]) assert(!text.includes(id), `evidence must not contain ${id}`);
};

test('an installed app is launched, smoke-tested, screenshotted and stopped on the paired phone; nothing is installed or removed', async () => {
  const s = appRepo(), p = fakePhone();
  const ctx = context(s, p, { context: { sha: s.sha, projectId: 'p-one', codeChecks: 'passed' } });
  const run = await runAppleDevice(options(), ctx);
  const e = run.result.data.evidence;
  assert.equal(run.result.status, 'passed', run.result.summary);
  assert.deepEqual(e.status, { code: 'passed', simulator: 'not-run', physical: 'passed', overall: 'passed' });
  assert.equal(e.requirement, 'physical'); assert.equal(e.commit, s.sha); assert.equal(e.environment.xcode, 'Xcode 99.0 Build version 99A1');
  assert.deepEqual(e.device, { kind: 'physical', name: 'iPhone 17', model: 'iPhone 17', modelIdentifier: 'iPhone18,3', runtime: 'iOS 27.0',
    runtimeIdentifier: 'iOS 27.0 (24A435)', udid: deviceKey(PHONE.udid), createdByYardmaster: false });
  assert.match(e.device!.udid, /^d-[a-f0-9]{20}$/);
  assert.equal(e.artifact, null);
  assert.deepEqual(e.deviceApp, { bundleId: FOREIGN.bundleIdentifier, name: 'Owner App', version: '1.0.0', build: '20', installedByRun: false });
  assert.deepEqual(e.checks.map(c => `${c.name}:${c.status}`), ['device:passed', 'launch:passed', 'smoke:passed', 'crash-reports:passed']);
  for (const name of ['launch.png', 'final.png', 'app-console.log', 'result.txt']) assert(e.files.some(f => f.path.endsWith(name) && existsSync(f.path)), `kept ${name}`);
  assert.match(readFileSync(e.files.find(f => f.path.endsWith('app-console.log'))!.path, 'utf8'), /App log: ready on \[redacted\]/);
  assert.match(e.summary, /tested the copy of com\.owner\.app already installed \(1\.0\.0 build 20\), not a build of this commit/);
  // Hardware identifiers never reach saved evidence; the smoke command got the real UDID to drive the device.
  assertNoHardwareIds(ctx.evidenceDir);
  assert.match(readFileSync(e.files.find(f => f.path.endsWith('result.txt'))!.path, 'utf8'), /^ok \[redacted\]$/);
  // Launched with --console, stopped by pid; nothing installed, uninstalled or left running.
  assert.equal(devicectlCalls(p, 'device install').length + devicectlCalls(p, 'device uninstall').length, 0);
  assert.equal(devicectlCalls(p, 'device process terminate').length, 1);
  assert.deepEqual(p.state().running, []);
  assert.deepEqual(p.state().apps[PHONE.udid]!.map(a => a.bundleIdentifier), [FOREIGN.bundleIdentifier]);
  assert.equal(e.lease!.pool, 'physical'); assert.equal(e.lease!.cleanup, 'released'); assert.equal(leasesNow().length, 0);
  assert.equal(run.execution.reaped, true);
  // Text surfaces say what was tested; acceptance refuses an installed copy for a commit.
  assert.match(evidenceLine(e), /^PASSED [a-f0-9]{12}: code passed, simulator not run, physical device passed \[iPhone 17, iOS 27\.0 \(physical\)\] installed app 1\.0\.0 \(20\), not built from this commit$/);
  assert.match(evidenceProblem(e, s.sha, 'physical')!, /tested the copy of com\.owner\.app already installed on the device \(1\.0\.0 build 20\), not a build of this commit/);
});

test('a configured build is installed, tested, accepted for its commit and removed only because this run installed it', async () => {
  const s = appRepo(), p = fakePhone();
  const run = await runAppleDevice(built({ install: { uninstallAfter: true } }), context(s, p));
  const e = run.result.data.evidence;
  assert.equal(run.result.status, 'passed', run.result.summary);
  assert.deepEqual(e.checks.map(c => `${c.name}:${c.status}`), ['build:passed', 'device:passed', 'install:passed', 'launch:passed', 'smoke:passed', 'crash-reports:passed', 'uninstall:passed']);
  assert.equal(e.artifact!.sha256, artifactSha256(join(s.repo, 'build/Smoke.app'))); assert.equal(e.artifact!.builtFromCommit, s.sha);
  assert.equal(e.deviceApp!.installedByRun, true);
  assert.equal(evidenceProblem(e, s.sha, 'physical'), null);
  // The installed copy was this run's snapshot, not the build output; the foreign app is untouched.
  const install = devicectlCalls(p, 'device install app')[0]!;
  assert.equal(install[5], PHONE.udid);
  assert.match(install[6]!, /Smoke\.app$/); assert.notEqual(install[6], join(s.repo, 'build/Smoke.app'));
  assert.deepEqual(devicectlCalls(p, 'device uninstall app').map(a => a[6]), ['dev.yardmaster.smoke']);
  assert.deepEqual(p.state().apps[PHONE.udid]!.map(a => a.bundleIdentifier), [FOREIGN.bundleIdentifier]);
  assert.equal(leasesNow().length, 0);
});

test('a build never replaces a copy the run did not install unless configured, and a replaced copy is never removed', async () => {
  const s = appRepo();
  const theirs = { ...FOREIGN, bundleIdentifier: 'dev.yardmaster.smoke' };
  const p = fakePhone({ apps: { [PHONE.udid]: [theirs] } });
  const refused = await runAppleDevice(built({ install: { uninstallAfter: true } }), context(s, p));
  const e = refused.result.data.evidence;
  assert.equal(refused.result.status, 'unknown'); assert.equal(e.status.physical, 'untested');
  assert.match(e.checks.find(c => c.name === 'install')!.detail, /already installed .* this run did not install it/);
  assert.equal(devicectlCalls(p, 'device install').length + devicectlCalls(p, 'device uninstall').length + devicectlCalls(p, 'device process launch').length, 0);
  assert.equal(leasesNow().length, 0);
  const replaced = await runAppleDevice(built({ install: { replaceExisting: true, uninstallAfter: true } }), context(s, p));
  assert.equal(replaced.result.status, 'passed', replaced.result.summary);
  assert.equal(replaced.result.data.evidence.deviceApp!.installedByRun, false);
  assert.equal(devicectlCalls(p, 'device install').length, 1);
  assert.equal(devicectlCalls(p, 'device uninstall').length, 0, 'a copy that existed before the run is never removed');
  assert(!replaced.result.data.evidence.checks.some(c => c.name === 'uninstall'));
});

for (const [label, setup, reason] of [
  ['no device is connected', { devices: [] }, /a paired iPhone or iPad is not known to this Mac/],
  ['the device is locked', { devices: [{ ...PHONE, locked: true }] }, /is locked/],
  ['the device does not answer', { devices: [{ ...PHONE, unreachable: true }] }, /did not answer/],
  ['the device is not trusted', { devices: [{ ...PHONE, pairing: 'unpaired' }] }, /a paired iPhone or iPad is not known/],
  ['Developer Mode is off', { devices: [{ ...PHONE, developerMode: false }] }, /Developer Mode/],
  ['two devices and none chosen', { devices: [PHONE, { ...PHONE, identifier: 'X2', udid: '00008150-0001632136400BB2', name: 'Second' }] }, /2 devices match and none is configured/],
  ['devicectl is missing', { config: { noDevicectl: true } }, /xcrun devicectl is not available/],
  ['the app is not installed', { apps: {} }, /com\.owner\.app is not installed on iPhone 17/],
] as const) test(`unavailable, never a pass, when ${label}`, async () => {
  const s = appRepo(), p = fakePhone(setup as Parameters<typeof fakePhone>[0]);
  const run = await runAppleDevice(options(), context(s, p));
  const e = run.result.data.evidence;
  assert.equal(run.result.status, 'unknown'); assert.equal(e.status.overall, 'unknown'); assert.equal(e.status.physical, 'untested');
  assert.match(`${e.summary} ${e.checks.map(c => c.detail).join(' ')}`, reason);
  assert(e.checks.every(c => c.status === 'unavailable' || c.status === 'passed'));
  assert.equal(devicectlCalls(p, 'device process launch').length, 0);
  assert.equal(leasesNow().length, 0);
  assert.match(evidenceProblem(DeviceEvidenceSchema.parse(e), s.sha, 'physical')!, /.+/);
});

test('a configured device is chosen by UDID or name; an unknown one is reported by its hashed key', () => {
  const a = { identifier: 'A', udid: '00008150-AAAAAAAAAAAAAAAA', name: 'Lab A', model: 'iPhone 17', modelIdentifier: 'iPhone18,3', platform: 'iOS', osVersion: '27.0', osBuild: null,
    pairing: 'paired', developerMode: 'enabled', bootState: 'booted', transport: 'wired', serial: null, ecid: null } satisfies PhysicalDevice;
  const b = { ...a, identifier: 'B', udid: '00008150-BBBBBBBBBBBBBBBB', name: 'Lab B' };
  assert.equal((chooseDevice([a, b], { udid: b.udid.toLowerCase() }) as { device: PhysicalDevice }).device.name, 'Lab B');
  assert.equal((chooseDevice([a, b], { name: 'Lab A' }) as { device: PhysicalDevice }).device.udid, a.udid);
  const missing = chooseDevice([a], { udid: '00008150-CCCCCCCCCCCCCCCC' }) as { unavailable: string };
  assert.match(missing.unavailable, /^device d-[a-f0-9]{20} is not known/); assert(!missing.unavailable.includes('CCCC'));
  assert.equal(deviceKey(a.udid), deviceKey(a.udid.toLowerCase()), 'the key is stable whatever the case');
});

test('a failing smoke test fails the physical check, and the app is still stopped and the lease released', async () => {
  const s = appRepo(), p = fakePhone();
  const run = await runAppleDevice(options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', 'process.exit(3)'] }] }), context(s, p));
  assert.equal(run.result.status, 'failed'); assert.equal(run.result.data.evidence.status.physical, 'failed');
  assert.deepEqual(p.state().running, []); assert.equal(leasesNow().length, 0);
});

test('a crash during the run is a failure, and its crash report is kept without hardware identifiers', async () => {
  const s = appRepo(), p = fakePhone({ config: { crashAfterMs: 300 } });
  const ctx = context(s, p);
  const run = await runAppleDevice(options({ settleSeconds: 1, tests: [] }), ctx);
  const e = run.result.data.evidence;
  assert.equal(run.result.status, 'failed', run.result.summary);
  assert.equal(e.checks.find(c => c.name === 'crash-reports')!.status, 'failed');
  const crash = e.files.find(f => f.path.endsWith('.ips'))!;
  assert.match(readFileSync(crash.path, 'utf8'), /EXC_CRASH/);
  assertNoHardwareIds(ctx.evidenceDir);
  assert.equal(leasesNow().length, 0);
});

test('the physical lease is held for the whole run and records the device; cancellation stops the app and releases it', async () => {
  const s = appRepo(), p = fakePhone(), marker = join(s.home, 'test-started');
  const abort = new AbortController();
  const running = runAppleDevice(options({ tests: [{ name: 'smoke', runner: 'command', command: [process.execPath, '-e', hang(marker)] }] }), context(s, p, { signal: abort.signal }));
  await until(() => existsSync(marker), Boolean, 20_000, 'the smoke test to start');
  const [held] = leasesNow();
  assert.equal(held!.pool, 'physical'); assert.equal(held!.state, 'held');
  assert.deepEqual(held!.owned, [{ kind: 'device', key: deviceKey(PHONE.udid) }]);
  abort.abort('canceled by test');
  const run = await running;
  assert.equal(run.result.status, 'unknown'); assert.match(run.result.summary, /canceled/);
  assert.equal(run.result.data.evidence.status.physical, 'unknown');
  assert.equal(run.execution.reaped, true);
  assert.deepEqual(p.state().running, [], 'the launched app was terminated after the cancel');
  assert.equal(leasesNow().length, 0);
});

test('two leases in a pool with room for several phones never share one phone', async () => {
  sandbox();
  const lease = () => acquireLease({ pool: 'physical', capacity: 2, holder: `cli-${randomUUID().slice(0, 4)}`, ttlMs: 60_000, waitMs: 5000, pollMs: 50, cleanup: async () => ({ ok: true, detail: '' }) });
  const [one, two] = [await lease(), await lease()];
  const key = deviceKey(PHONE.udid);
  assert.equal(one.lease!.claimDevice(key), null);
  assert.match(two.lease!.claimDevice(key)!, /^cli-/);
  assert.equal(two.lease!.claimDevice(deviceKey('00008150-000000000000OTHER')), null, 'another phone is free');
  one.lease!.release();
  assert.equal(two.lease!.claimDevice(key), null, 'free once the first run releases it');
  two.lease!.release();
});

test('apple-device is opt-in and eligible only with xcrun present and valid options', () => {
  const s = appRepo(), p = fakePhone(), plugins = builtinProviders();
  const cfg = (o: unknown) => ServicesConfigSchema.parse({ providers: { 'apple-device': { options: o } }, routes: { 'device.test': { prefer: ['apple-device'] } } });
  assert.equal(planService('device.test', cfg({ bundleId: 'com.owner.app' }), plugins, s.repo, { PATH: p.PATH }).selected, 'apple-device');
  assert.match(planService('device.test', cfg({ bundleId: 'com.owner.app' }), plugins, s.repo, { PATH: '/nonexistent' }).candidates[0]!.reasons.join(' '), /xcrun is missing/);
  assert.match(planService('device.test', cfg({ bundleId: 'com.owner.app', device: { udid: '00008150-0001632136400AA1', name: 'x' } }), plugins, s.repo, { PATH: p.PATH }).candidates[0]!.reasons.join(' '), /not both/);
  assert.throws(() => AppleDeviceOptionsSchema.parse({ bundleId: 'a.b', tests: [{ name: 'crash-reports', runner: 'command', command: ['true'] }] }), /reserved/);
});
