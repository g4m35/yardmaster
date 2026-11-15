#!/usr/bin/env node
// Live proof of the simulator workflow on a real Mac (CI: macos-latest). Copies examples/ios-smoke into two fresh
// repositories and drives the real CLI: acceptance (ym verify), two projects contending for one simulator slot,
// a physical-device requirement, cancellation, and a crashed holder. Every simulator that existed before must be
// untouched afterwards, and every simulator Yardmaster created must be gone.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src/cli.ts');
const work = mkdtempSync(join(tmpdir(), 'ym-device-live-'));
const home = process.env.YARDMASTER_HOME_OUT ?? join(work, 'home');
mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(home, 'config.json'), JSON.stringify({ notify: false, devices: { holdAtPressure: 'critical', minFreeMemMb: 512, waitMinutes: 30 } }));
const env = { ...process.env, YARDMASTER_HOME: home, YARDMASTER_HUB: '', YARDMASTER_TOKEN: '', NO_COLOR: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'ym', GIT_AUTHOR_EMAIL: 'ym@example.invalid', GIT_COMMITTER_NAME: 'ym', GIT_COMMITTER_EMAIL: 'ym@example.invalid' } }).trim();
const log = (...parts) => console.log(`[device-live ${new Date().toISOString()}]`, ...parts);

function simulators() {
  const list = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }));
  return Object.values(list.devices).flat().map(d => ({ udid: d.udid, name: d.name, state: d.state }));
}
function project(name, edit = config => config) {
  const dir = join(work, name);
  cpSync(join(root, 'examples/ios-smoke'), dir, { recursive: true });
  const file = join(dir, 'yardmaster.json');
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', `${name} sample`);
  return dir;
}
/** A clone keeps the project identity (same root commit), so its fingerprint-matched build is reused. */
function clone(from, name, edit) {
  const dir = join(work, name);
  git(work, 'clone', '-q', from, dir);
  const file = join(dir, 'yardmaster.json');
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
  git(dir, 'commit', '-q', '-am', `${name} config`);
  return dir;
}
function ym(cwd, args, { timeoutMs = 25 * 60_000 } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const done = new Promise(resolve => child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); }));
  return { child, done };
}
const json = text => JSON.parse(text);
const evidence = async (cwd) => json((await ym(cwd, ['devices', 'evidence', '--json', '--limit', '50']).done).out).map(item => item.evidence);
const leases = async (cwd) => json((await ym(cwd, ['devices', 'status', '--json']).done).out);
const until = async (fn, label, timeoutMs = 20 * 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await new Promise(r => setTimeout(r, 500)); }
};
const owned = () => simulators().filter(d => d.name.startsWith('ym-'));

const before = simulators().filter(d => !d.name.startsWith('ym-'));
log(`${before.length} pre-existing simulators (${before.filter(d => d.state === 'Booted').length} booted); none may change.`);
const status = await leases(work);
assert.ok(['normal', 'warn', 'critical'].includes(status.memory.pressure), `macOS memory pressure was read: ${JSON.stringify(status.memory)}`);
log('memory admission sample', JSON.stringify(status.memory));

// 1. Acceptance: shell check, then build, lease, install, launch, smoke test, evidence, release.
const a = project('project-a');
const first = await ym(a, ['verify', '--json']).done;
assert.equal(first.code, 0, `ym verify failed: ${first.out}`);
const headA = git(a, 'rev-parse', 'HEAD');
let [e] = await evidence(a);
assert.equal(e.commit, headA); assert.equal(e.requirement, 'simulator');
assert.deepEqual(e.status, { code: 'passed', simulator: 'passed', physical: 'untested', overall: 'passed' });
assert.match(e.artifact.sha256, /^[a-f0-9]{64}$/); assert.equal(e.artifact.source, 'built');
assert.equal(e.device.kind, 'simulator'); assert.match(e.device.runtime, /^iOS /); assert.equal(e.device.createdByYardmaster, true);
assert.deepEqual(e.checks.map(c => `${c.name}:${c.status}`), ['build:passed', 'boot:passed', 'install:passed', 'launch:passed', 'smoke:passed']);
for (const file of ['launch.png', 'final.png', 'smoke.txt']) assert.ok(e.files.some(f => f.path.endsWith(file) && existsSync(f.path)), `receipt has ${file}`);
assert.equal(owned().length, 0, 'the created simulator was deleted');
log('acceptance passed', e.device.model, e.device.runtime, e.artifact.sha256.slice(0, 12));

// 2. Two projects, one simulator slot: B builds while A reuses its build; their simulator windows must not overlap.
const b = project('project-b');
const [ra, rb] = await Promise.all([ym(a, ['verify', '--json']).done, ym(b, ['verify', '--json']).done]);
assert.equal(ra.code, 0, ra.out); assert.equal(rb.code, 0, rb.out);
const [ea] = await evidence(a), [eb] = (await evidence(b)).filter(x => x.commit === git(b, 'rev-parse', 'HEAD'));
assert.equal(ea.artifact.source, 'reused', 'same fingerprint reuses the verified build'); assert.equal(ea.artifact.sha256, e.artifact.sha256);
const [x, y] = [ea.lease, eb.lease].sort((p, q) => p.acquiredAt - q.acquiredAt);
assert.ok(x.releasedAt <= y.acquiredAt, `simulator leases overlapped: ${JSON.stringify([x, y])}`);
log(`contention: second holder waited ${Math.round(y.waitedMs / 1000)} s in the queue`);

// 3. A physical-device requirement is not satisfied by the simulator pass.
writeFileSync(join(work, 'physical.json'), JSON.stringify({ requires: 'physical' }));
const physical = await ym(a, ['providers', 'run', 'device.test', '--input', join(work, 'physical.json'), '--json']).done;
assert.equal(physical.code, 1);
[e] = await evidence(a);
assert.equal(e.status.simulator, 'passed'); assert.equal(e.status.physical, 'untested'); assert.equal(e.status.overall, 'unknown');
log('physical requirement stays untested:', e.summary);

// 4/5. Cancellation (SIGTERM) and a crashed holder (SIGKILL) while a test holds the simulator.
for (const signal of ['SIGTERM', 'SIGKILL']) {
  const marker = join(work, `${signal}.started`);
  const dir = clone(a, `project-${signal.toLowerCase()}`, config => {
    // The waiting test ends by itself if its parent CLI disappears, so a killed holder leaves no process behind.
    config.services.providers['apple-simulator'].options.tests.push({ name: 'hold', runner: 'command',
      command: ['sh', '-c', `touch "${marker}"; while kill -0 $PPID 2>/dev/null; do sleep 1; done`], timeoutMinutes: 20 });
    return config;
  });
  const run = ym(dir, ['verify', '--json']);
  await until(() => existsSync(marker), `${signal} holder to start its test`);
  const held = (await leases(dir)).leases.find(l => l.pool === 'simulator' && l.state === 'held');
  assert.ok(held?.owned[0]?.udid, 'the lease recorded the simulator it created');
  assert.ok(simulators().some(d => d.udid === held.owned[0].udid && d.state === 'Booted'));
  run.child.kill(signal);
  await run.done;
  if (signal === 'SIGKILL') {
    assert.ok(simulators().some(d => d.udid === held.owned[0].udid), 'a crashed holder leaves its simulator for the reaper');
    const reaped = json((await ym(dir, ['devices', 'reap', '--json']).done).out);
    assert.deepEqual(reaped.map(r => `${r.pool}:${r.outcome}`), ['simulator:released']);
  }
  assert.ok(!simulators().some(d => d.udid === held.owned[0].udid), `${signal}: the owned simulator is gone`);
  assert.equal((await leases(dir)).leases.length, 0, `${signal}: no lease remains`);
  log(`${signal}: owned simulator ${held.owned[0].udid} removed and lease released`);
}

const after = simulators().filter(d => !d.name.startsWith('ym-'));
assert.deepEqual(after.map(d => `${d.udid}:${d.state}`).sort(), before.map(d => `${d.udid}:${d.state}`).sort(), 'pre-existing simulators are unchanged');
assert.equal(owned().length, 0);
log('device live checks passed; receipts are under', join(home, 'service-runs'));
