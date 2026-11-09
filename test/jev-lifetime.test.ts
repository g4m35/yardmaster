import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAgentSettings, EffortRoutingSchema } from '../src/config.ts';
import { routeEffort } from '../src/jev.ts';
import { groupAlive, isAlive, terminateOwnedGroup, type OwnedProcessInfo } from '../src/proc.ts';
import { tempDir, until } from './helpers.ts';
process.env.YARDMASTER_HOME = join(tempDir('ym-jev-owner-home-'), 'home');

function fixture(mode: 'resist' | 'pipes' | 'reply' = 'resist') {
  const root = tempDir('ym-jev-lifetime-');
  const ready = join(root, 'ready');
  const childReady = join(root, 'child-ready');
  const script = join(root, 'router.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
let input = ''; for await (const c of process.stdin) input += c;
const q = JSON.parse(input);
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const reply = { v: 1, requestId: q.requestId, sessionId: q.sessionId, providerInstanceId: q.providerInstanceId, model: q.model,
 status: 'apply', reason: 'difficulty_lower', level: 'low', patch: { optionId: q.capability.optionId, value: 'low' }, judge: null };
if (${JSON.stringify(mode)} === 'resist') setInterval(() => {}, 1000);
else {
 console.log(JSON.stringify(reply));
 if (${JSON.stringify(mode)} === 'pipes') {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childReady)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`)}], { stdio: 'inherit' });
  child.unref();
 }
}
`);
  const config = EffortRoutingSchema.parse({ enabled: true, mode: 'active', command: [process.execPath, script], timeoutMs: 2000,
    bindings: [{ agent: 'claude', model: 'fixture', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' }] });
  const opts = { config, agent: 'claude', model: 'fixture', settings: defaultAgentSettings(), tier: 'standard' as const,
    task: { id: 'lifetime-fixture', title: 'Typo', prompt: 'Fix typo.', attempts: 1, agent_session: null, retry_note: null, review_rounds: 0, conflict_rounds: 0 }, repoPath: root };
  return { opts, ready, childReady };
}

async function cleanup(pid: number | undefined) {
  if (pid) {
    const r = await terminateOwnedGroup(pid, { graceMs: 20, killWaitMs: 1500 });
    assert.ok(r.status === 'exited' || r.status === 'terminated', `fixture group ${pid}: ${r.status}`);
  }
}

test('router timeout escalates TERM-resistant judge to KILL and reports reaped evidence', async () => {
  const f = fixture();
  let registered: OwnedProcessInfo | undefined;
  try {
    const pending = routeEffort({ ...f.opts, onSpawn: (info) => { registered = info; } });
    await until(() => existsSync(f.ready), Boolean);
    const r = await pending;
    assert.equal(r.reason, 'timeout');
    assert.equal(r.process?.end, 'timeout');
    assert.equal(r.process?.reaped, true);
    assert.equal(r.process?.reap.signal, 'SIGKILL');
    assert.equal(r.process?.pid, registered?.pid);
    assert.equal(registered?.pgid, registered?.pid);
    assert.equal(groupAlive(registered!.pid), false);
  } finally { await cleanup(registered?.pid); }
});

test('a successful router cannot leave its pipe-holding descendant running', async () => {
  const f = fixture('pipes');
  let registered: OwnedProcessInfo | undefined;
  try {
    const r = await routeEffort({ ...f.opts, onSpawn: (info) => { registered = info; } });
    assert.equal(r.status, 'apply');
    assert.equal(r.effort, 'low');
    assert.equal(r.process?.pipeHeld, true);
    assert.equal(r.process?.reaped, true);
    assert.equal(groupAlive(registered!.pid), false);
    assert.equal(isAlive(Number(readFileSync(f.childReady, 'utf8'))), false);
  } finally { await cleanup(registered?.pid); }
});

test('cancellation during registration waits for cleanup and preserves the canceled reason', async () => {
  const f = fixture();
  const abort = new AbortController();
  let registered: OwnedProcessInfo | undefined;
  try {
    const pending = routeEffort({ ...f.opts, signal: abort.signal, onSpawn: (info) => {
      registered = info;
      return new Promise<void>(() => {});
    } });
    await until(() => registered !== undefined, Boolean);
    assert.equal(existsSync(f.ready), false, 'router input is withheld while registration is pending');
    assert.equal(groupAlive(registered!.pid), true);
    abort.abort('test cancellation');
    const r = await pending;
    assert.equal(r.reason, 'canceled');
    assert.equal(r.process?.reaped, true);
    assert.equal(groupAlive(registered!.pid), false);
  } finally { await cleanup(registered?.pid); }
});

test('failed registration holds after reaping and never exposes hook error text', async () => {
  const f = fixture();
  let registered: OwnedProcessInfo | undefined;
  try {
    const r = await routeEffort({ ...f.opts, onSpawn: (info) => {
      registered = info;
      throw new Error('PRIVATE registration failure');
    } });
    assert.equal(r.status, 'hold');
    assert.equal(r.reason, 'registration_failed');
    assert.equal(r.effort, undefined);
    assert.equal(r.process?.reaped, true);
    assert.equal(groupAlive(registered!.pid), false);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  } finally { await cleanup(registered?.pid); }
});

test('routing skips never register a spawning phase; beforeSpawn rejection holds without launching', async () => {
  const f = fixture('reply');
  let calls = 0;
  const hooks = { beforeSpawn: () => { calls++; }, onSpawn: () => { calls++; } };
  for (const opts of [
    { ...f.opts, config: { ...f.opts.config, enabled: false } },
    { ...f.opts, settings: defaultAgentSettings({ effortOwnership: 'native' }) },
    { ...f.opts, task: { ...f.opts.task, attempts: 2 } },
    { ...f.opts, settings: defaultAgentSettings({ minimumEffort: 'high' }) },
    { ...f.opts, config: { ...f.opts.config, bindings: [{ ...f.opts.config.bindings[0]!, cacheImpact: 'unknown' as const }] } },
  ]) {
    await routeEffort({ ...opts, ...hooks });
  }
  assert.equal(calls, 0);
  assert.equal(existsSync(f.ready), false);
  const r = await routeEffort({ ...f.opts, beforeSpawn: () => { throw new Error('PRIVATE write failure'); }, onSpawn: hooks.onSpawn });
  assert.equal(r.status, 'hold');
  assert.equal(r.reason, 'registration_failed');
  assert.equal(r.process, undefined);
  assert.equal(calls, 0);
  assert.equal(existsSync(f.ready), false);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});

test('a judge that survives termination returns an explicit hold instead of timeout fallback', async () => {
  const f = fixture();
  let registered: OwnedProcessInfo | undefined;
  const originalKill = process.kill;
  try {
    const pending = routeEffort({ ...f.opts, onSpawn: (info) => {
      registered = info;
      // Fault injection only for this fake judge group: emulate signals accepted but unable to stop it.
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        // Both original-group and new inherited-marker cleanup must be unable to stop this exact judge.
        if ((pid === -info.pid || pid === info.pid) && (signal === 'SIGTERM' || signal === 'SIGKILL')) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill;
    } });
    await until(() => existsSync(f.ready), Boolean);
    const r = await pending;
    assert.equal(r.status, 'hold');
    assert.equal(r.reason, 'process_unreaped');
    assert.equal(r.effort, undefined);
    assert.equal(r.process?.reaped, false);
    assert.equal(r.process?.reap.status, 'survived');
    assert.equal(groupAlive(registered!.pid), true);
  } finally {
    process.kill = originalKill;
    await cleanup(registered?.pid);
  }
});
