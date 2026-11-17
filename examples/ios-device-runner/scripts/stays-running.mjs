#!/usr/bin/env node
// A smoke check that needs no UI automation: the app Yardmaster launched must still be running, as the same
// process, after a number of seconds (default 15). Exit 1 means it exited or restarted; that is a failure.
//   node stays-running.mjs [seconds]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const udid = process.env.YARDMASTER_DEVICE_UDID, bundleId = process.env.YARDMASTER_BUNDLE_ID;
if (!udid || !bundleId) { console.error('Run through Yardmaster, which provides the leased device and bundle ID.'); process.exit(2); }
const seconds = Number(process.argv[2] ?? 15);
const work = mkdtempSync(join(tmpdir(), 'ym-alive-'));
const devicectl = (...args) => {
  const file = join(work, 'out.json');
  execFileSync('xcrun', ['devicectl', ...args, '--device', udid, '--json-output', file], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  return JSON.parse(readFileSync(file, 'utf8')).result;
};
try {
  const app = devicectl('device', 'info', 'apps', '--bundle-id', bundleId).apps.find(a => a.bundleIdentifier === bundleId);
  if (!app?.url) { console.error(`${bundleId} is not installed`); process.exit(1); }
  const bundle = app.url.replace(/\/$/, '') + '/';
  const pids = () => devicectl('device', 'info', 'processes').runningProcesses.filter(p => p.executable?.startsWith(bundle)).map(p => p.processIdentifier);
  const first = pids();
  if (!first.length) { console.error(`${bundleId} is not running`); process.exit(1); }
  console.log(`${app.name ?? bundleId} ${app.version ?? '?'} (${app.bundleVersion ?? '?'}) running as pid ${first[0]}`);
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(3000, Math.max(0, deadline - Date.now())));
    const now = pids();
    if (!now.includes(first[0])) { console.error(`pid ${first[0]} is gone after ${Math.round((seconds * 1000 - (deadline - Date.now())) / 1000)} s (now: ${now.join(', ') || 'not running'})`); process.exit(1); }
  }
  console.log(`still running as pid ${first[0]} after ${seconds} s`);
} finally { rmSync(work, { recursive: true, force: true }); }
