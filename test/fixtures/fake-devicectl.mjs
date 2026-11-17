#!/usr/bin/env node
// Stand-in for `xcrun devicectl` (and `xcrun --find devicectl`, `xcrun xcodebuild -version`): a simulated paired phone.
// State and an invocation log live beside this file. Results go to --json-output like the real tool. Never touches hardware.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, 'phone-state.json'), lock = join(here, 'phone-state.lock');
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => Atomics.wait(pause, 0, 0, ms);
function withState(fn) {
  for (let i = 0; ; i++) { try { mkdirSync(lock); break; } catch { if (i > 2000) process.exit(90); sleep(5); } }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const out = fn(state);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return out;
  } finally { rmdirSync(lock); }
}

let args = process.argv.slice(2);
appendFileSync(join(here, 'phone-log.jsonl'), JSON.stringify({ t: Date.now(), pid: process.pid, args }) + '\n');
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
if (args[0] === 'xcodebuild' && args[1] === '-version') { process.stdout.write('Xcode 99.0\nBuild version 99A1\n'); process.exit(0); }
if (args[0] === '--find') {
  if (args[1] === 'devicectl' && !read().config.noDevicectl) { process.stdout.write('/fake/devicectl\n'); process.exit(0); }
  process.stderr.write(`xcrun: error: unable to find utility "${args[1]}"\n`); process.exit(72);
}
if (args[0] !== 'devicectl') process.exit(2);
args = args.slice(1);
const take = flag => { const at = args.indexOf(flag); if (at < 0) return null; const value = args[at + 1]; args.splice(at, 2); return value; };
const jsonOut = take('--json-output'); take('--timeout');
const deviceArg = take('--device');
const write = (result, outcome = 'success', error) => { if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ info: { outcome, jsonVersion: 5 }, result, ...(error ? { error } : {}) })); };
const fail = (message, code = 1) => {
  write(undefined, 'failed', { code: 1000, domain: 'com.apple.dt.CoreDeviceError', userInfo: { NSLocalizedDescription: { string: message } } });
  process.stderr.write(`ERROR: ${message}\n`); process.exit(code);
};
const cmd = args.slice(0, 3).join(' ');
const state = read();
if (state.config.fail && cmd.startsWith(state.config.fail)) fail(`forced failure of ${state.config.fail}`);
const phone = deviceArg ? state.devices.find(d => [d.udid, d.identifier, d.name].includes(deviceArg)) : null;
if (deviceArg && !phone) fail(`The specified device was not found. (Name: ${deviceArg})`);
const exeOf = app => app.url.replace(/\/$/, '') + '/' + app.url.replace(/\/$/, '').split('/').at(-1).replace(/\.app$/, '');

if (cmd === 'list devices') {
  write({ devices: [
    { identifier: 'SIM-0000', properties: { hardware: { udid: 'SIM-0000', reality: 'simulated', platform: 'iOS', marketingName: 'iPhone 17' } } },
    ...state.devices.map(d => ({ identifier: d.identifier, visibilityClass: 'default',
      properties: { hardware: { udid: d.udid, marketingName: d.model, productType: d.productType, platform: 'iOS', reality: 'physical', serialNumber: d.serial, ecid: d.ecid },
        software: { osVersionNumber: { stringValue: d.os }, osBuildVersions: { buildVersion: { name: d.build } } },
        state: { name: d.name, bootState: 'booted', developerModeStatus: d.developerMode ? { enabled: { mode: 1 } } : { disabled: {} } },
        connection: d.unreachable ? { pairingState: d.pairing, state: 'unavailable' } : { pairingState: d.pairing, transportType: 'wired', state: 'disconnected' } } })) ] });
} else if (cmd === 'device info lockState') {
  if (phone.unreachable) fail('The device is not connected.');
  write({ deviceIdentifier: phone.identifier, passcodeRequired: !!phone.locked, unlockedSinceBoot: true });
} else if (cmd === 'device info apps') {
  const bundle = take('--bundle-id');
  write({ apps: (state.apps[phone.udid] ?? []).filter(a => !bundle || a.bundleIdentifier === bundle), deviceIdentifier: phone.identifier });
} else if (cmd === 'device info processes') {
  write({ deviceIdentifier: phone.identifier, runningProcesses: [{ executable: 'file:///sbin/launchd', processIdentifier: 1 }, ...state.running.filter(p => p.udid === phone.udid).map(p => ({ executable: p.executable, processIdentifier: p.pid }))] });
} else if (cmd === 'device info files') {
  write({ deviceIdentifier: phone.identifier, domain: 'systemCrashLogs', files: [{ name: 'Assistant', relativePath: 'Assistant', resources: { isDirectory: true }, metadata: {} },
    ...(state.crashes[phone.udid] ?? []).map(name => ({ name, relativePath: name, resources: { isDirectory: false }, metadata: { lastModDate: new Date().toISOString(), size: 10 } }))] });
} else if (cmd === 'device copy from') {
  const source = take('--source'), destination = take('--destination');
  if (!(state.crashes[phone.udid] ?? []).includes(source)) fail('no such file');
  writeFileSync(destination, `{"crashReporterKey":"x","udid":"${phone.udid}","serial":"${phone.serial}"}\nException Type: EXC_CRASH\n`);
  write({ deviceIdentifier: phone.identifier });
} else if (cmd === 'device install app') {
  const path = args[3];
  if (!path || !existsSync(path)) fail('install path missing');
  withState(s => {
    const apps = s.apps[phone.udid] ??= [];
    const at = apps.findIndex(a => a.bundleIdentifier === s.config.bundleId);
    const app = { bundleIdentifier: s.config.bundleId, name: 'Smoke', version: '2.0', bundleVersion: '7', url: `file:///private/var/containers/Bundle/Application/NEW/Smoke.app/`, installedFrom: path };
    if (at >= 0) apps[at] = app; else apps.push(app);
  });
  write({ installedApplications: [{ bundleID: read().config.bundleId, installationURL: 'file:///private/var/containers/Bundle/Application/NEW/Smoke.app/' }] });
} else if (cmd === 'device uninstall app') {
  const bundle = args[3];
  withState(s => { s.apps[phone.udid] = (s.apps[phone.udid] ?? []).filter(a => a.bundleIdentifier !== bundle); });
  write({ deviceIdentifier: phone.identifier });
} else if (cmd === 'device process terminate') {
  const pid = Number(take('--pid'));
  const found = withState(s => { const before = s.running.length; s.running = s.running.filter(p => p.pid !== pid); return s.running.length < before; });
  if (!found) fail(`no process ${pid}`);
  write({ deviceIdentifier: phone.identifier, signal: { name: 'SIGTERM', value: 15 } });
} else if (cmd === 'device capture screenshot') {
  writeFileSync(take('--destination'), Buffer.from('89504e470d0a1a0a', 'hex'));
  write({ deviceIdentifier: phone.identifier, imageFormat: 'png' });
} else if (cmd === 'device process launch') {
  const bundle = args.at(-1);
  const app = (state.apps[phone.udid] ?? []).find(a => a.bundleIdentifier === bundle);
  if (!app) fail(`The application ${bundle} is not installed.`);
  const pid = 1000 + Math.floor(Math.random() * 8000);
  withState(s => {
    if (args.includes('--terminate-existing')) s.running = s.running.filter(p => p.executable !== exeOf(app));
    s.running.push({ pid, udid: phone.udid, executable: exeOf(app) });
  });
  process.stdout.write(`Launched application with ${bundle} bundle identifier.\nWaiting for the application to terminate…\n`);
  process.stderr.write(`App log: ready on ${phone.udid}\n`);
  if (!args.includes('--console')) { write({ process: { processIdentifier: pid, executable: exeOf(app) } }); process.exit(0); }
  const started = Date.now();
  for (;;) {
    sleep(100);
    const now = read();
    if (now.config.crashAfterMs && Date.now() - started > now.config.crashAfterMs) {
      withState(s => { s.running = s.running.filter(p => p.pid !== pid); (s.crashes[phone.udid] ??= []).push(`${exeOf(app).split('/').at(-1)}-2026-11-16-223000.ips`); });
      process.stdout.write('App terminated due to signal 6.\n');
      write({ process: { processIdentifier: pid }, terminationResult: { terminatingSignal: 6 } });
      process.exit(0);
    }
    if (!now.running.some(p => p.pid === pid)) break;
  }
  process.stdout.write('App terminated due to signal 15.\n');
  write({ process: { processIdentifier: pid }, terminationResult: { terminatingSignal: 15 } });
} else fail(`fake devicectl does not know ${cmd}`, 64);
