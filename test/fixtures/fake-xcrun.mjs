#!/usr/bin/env node
// Stand-in for Xcode's xcrun (simctl + xcodebuild -version). State and an invocation log live beside this file,
// so concurrent callers in different processes share one simulated machine. Never touches real simulators.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, 'sim-state.json'), lock = join(here, 'sim-state.lock');
const args = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; ; i++) {
  try { mkdirSync(lock); break; } catch { if (i > 2000) process.exit(90); Atomics.wait(pause, 0, 0, 5); }
}
let code = 0;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { devices: [], config: {} };
appendFileSync(join(here, 'sim-log.jsonl'), JSON.stringify({ t: Date.now(), pid: process.pid, args }) + '\n');
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const device = udid => state.devices.find(d => d.udid === udid);
const out = text => process.stdout.write(text);
try {
  if (args[0] === 'xcodebuild' && args[1] === '-version') out('Xcode 99.0\nBuild version 99A1\n');
  else if (args[0] !== 'simctl') code = 2;
  else {
    const [cmd, ...rest] = args.slice(1);
    if (state.config.fail === cmd) code = 1;
    else if (cmd === 'list') out(JSON.stringify({
      devicetypes: [{ identifier: TYPE, name: 'iPhone 17', productFamily: 'iPhone', modelIdentifier: 'iPhone18,3' }],
      runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', version: '26.5', isAvailable: true, platform: 'iOS', supportedDeviceTypes: [{ identifier: TYPE, name: 'iPhone 17', productFamily: 'iPhone' }] }],
      devices: { [RUNTIME]: state.devices.map(({ udid, name, state: s }) => ({ udid, name, state: s, isAvailable: true })) },
    }));
    else if (cmd === 'create') {
      const udid = randomUUID().toUpperCase();
      state.devices.push({ udid, name: rest[0], state: 'Shutdown', type: rest[1], runtime: rest[2], installed: [] });
      out(udid + '\n');
    } else if (cmd === 'boot') {
      const d = device(rest[0]);
      if (!d) code = 164;
      else {
        d.state = 'Booted';
        // Like launchd_sim: a detached process that outlives simctl, inherits its environment and belongs to the simulator.
        const sim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: 'ignore' });
        sim.unref();
        d.simPid = sim.pid;
      }
    }
    else if (cmd === 'bootstatus') { if (device(rest[0])?.state !== 'Booted') code = 165; }
    else if (cmd === 'install') { const d = device(rest[0]); if (!d || !existsSync(rest[1])) code = 22; else d.installed.push(rest[1]); }
    else if (cmd === 'launch') {
      const udid = rest.at(-2), bundle = rest.at(-1), d = device(udid);
      const stdout = rest.find(a => a.startsWith('--stdout='))?.slice(9);
      if (!d || d.state !== 'Booted' || !d.installed.length) code = 4;
      else { if (stdout) writeFileSync(stdout, 'app ready\n'); out(`${bundle}: 4242\n`); }
    } else if (cmd === 'io') { if (!device(rest[0])) code = 5; else writeFileSync(rest[2], Buffer.from('89504e470d0a1a0a', 'hex')); }
    else if (cmd === 'shutdown') {
      const d = device(rest[0]);
      if (!d) code = 164;
      else if (d.state === 'Shutdown') code = 149;
      else {
        d.state = 'Shutdown';
        // Record whether the simulator's own process was still running when the simulator was shut down.
        let alive = false;
        if (d.simPid) { try { process.kill(d.simPid, 0); alive = true; process.kill(d.simPid, 'SIGTERM'); } catch { alive = false; } }
        appendFileSync(join(here, 'sim-processes'), `${d.simPid ?? 'none'} ${alive}\n`);
      }
    }
    else if (cmd === 'delete') { const before = state.devices.length; state.devices = state.devices.filter(d => d.udid !== rest[0]); if (state.devices.length === before) code = 164; }
    else code = 3;
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
} finally { rmdirSync(lock); }
process.exitCode = code;
