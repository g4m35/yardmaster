import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { git } from '../src/git.ts';
import { cloneTree } from '../src/fastfs.ts';
import { currentProcessScopeSignal, groupAlive, isAlive, run, runOwnedProcess, UtilityProcessError, withProcessScope, type OwnedRunResult, type ProcessScopeOptions } from '../src/proc.ts';

const dir = tempDir('ym-utility-life-');
const fixture = join(dir, 'fixture.mjs');
writeFileSync(fixture, `
import { writeFileSync } from 'node:fs';
if (process.env.FIXTURE_MODE === 'exit') {
  process.stdout.write('utility output');
  process.stderr.write('utility diagnostic');
  process.exit(Number(process.env.FIXTURE_CODE || 0));
}
process.on('SIGTERM', () => {});
if (process.env.FIXTURE_PID) writeFileSync(process.env.FIXTURE_PID, String(process.pid));
setInterval(() => {}, 1000);
`);
for (const name of ['git', 'cp', 'osascript']) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${fixture}'\n`);
  chmodSync(path, 0o755);
}
let seq = 0;
const pidFile = () => join(dir, `${++seq}.pid`);
async function ready(file: string) {
  const until = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`fixture did not start: ${file}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return Number(readFileSync(file, 'utf8'));
}
async function environment<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
function registry(options: ProcessScopeOptions = {}) {
  const intents = new Map<string, { pid?: number }>();
  const exits: OwnedRunResult[] = [];
  const tokens = new Set<string>();
  return { intents, exits, tokens, options: {
    termGraceMs: 60, killWaitMs: 2000, hookTimeoutMs: 500,
    beforeSpawn: (child) => { assert.equal(tokens.has(child.token), false); tokens.add(child.token); intents.set(child.token, {}); },
    onSpawn: (token, process) => { assert.ok(intents.has(token)); intents.set(token, { pid: process.pid }); },
    onExit: (token, result) => {
      assert.ok(result.reaped, result.reap.reason);
      if (result.pid) assert.equal(groupAlive(result.pid), false, 'exit acknowledgment follows group reap');
      intents.delete(token); exits.push(result);
    }, ...options,
  } satisfies ProcessScopeOptions };
}

test('scoped Git keeps result compatibility and separate records for parallel identity queries', async () => {
  const r = registry();
  await environment({ PATH: `${dir}:${process.env.PATH}`, FIXTURE_MODE: 'exit' }, async () => {
    const result = await withProcessScope(r.options, () => git(dir, ['commit', '-m', 'fixture']));
    assert.deepEqual(result, { code: 0, stdout: 'utility output', stderr: 'utility diagnostic' });
  });
  assert.equal(r.tokens.size, 3, 'two identity queries and the commit have their own tokens');
  assert.equal(r.exits.length, 3);
  assert.equal(r.intents.size, 0);
});

test('a TERM-resistant Git utility timeout reaps its group and cannot be swallowed by a helper', async () => {
  const file = pidFile();
  const r = registry({ timeoutMs: 250 });
  await environment({ PATH: `${dir}:${process.env.PATH}`, FIXTURE_MODE: 'hang', FIXTURE_PID: file }, async () => {
    await assert.rejects(withProcessScope(r.options, async () => {
      await git(dir, ['bundle', 'create', 'ignored']).catch(() => undefined);
    }), (err: unknown) => err instanceof UtilityProcessError && err.result.end === 'timeout' && err.result.reaped);
  });
  assert.equal(isAlive(await ready(file)), false);
  assert.equal(r.exits[0]?.reap.signal, 'SIGKILL');
  assert.equal(r.intents.size, 0);
});

test('aborting a copy stops its process and prevents fallback copy/deletion', async () => {
  const file = pidFile();
  const source = join(dir, 'source');
  const dest = join(dir, 'copy-target');
  mkdirSync(source);
  const controller = new AbortController();
  const r = registry({ signal: controller.signal });
  await environment({ PATH: `${dir}:${process.env.PATH}`, FIXTURE_MODE: 'hang', FIXTURE_PID: file }, async () => {
    const copy = withProcessScope(r.options, () => cloneTree(source, dest, { allowPlainCopy: true }));
    const rejection = assert.rejects(copy, (err: unknown) => err instanceof UtilityProcessError && err.result.end === 'aborted');
    const pid = await ready(file);
    controller.abort('stop copy');
    await rejection;
    assert.equal(isAlive(pid), false);
  });
  assert.equal(r.tokens.size, 1, 'no fallback subprocess starts after cancellation');
  assert.equal(r.intents.size, 0);
});

test('registration failure kills the utility and preserves hook failure for its caller', async () => {
  const file = pidFile();
  const r = registry({ onSpawn: async () => { await ready(file); throw new Error('registry offline'); } });
  await assert.rejects(withProcessScope(r.options, () => run(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_MODE: 'hang', FIXTURE_PID: file },
  })), (err: unknown) => err instanceof UtilityProcessError && err.result.end === 'hook_failed' && /registry offline/.test(err.message));
  assert.equal(isAlive(await ready(file)), false);
  assert.equal(r.intents.size, 0);
});

test('before-spawn failure cannot create a child', async () => {
  const file = pidFile();
  const r = registry({ beforeSpawn: () => { throw new Error('intent store unavailable'); } });
  await assert.rejects(withProcessScope(r.options, () => run(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_MODE: 'hang', FIXTURE_PID: file },
  })), /intent store unavailable/);
  assert.equal(existsSync(file), false);
  assert.equal(r.exits[0]?.pid, null);
});

for (const exitOffline of [false, true]) test(`a refused utility intent does not abort coding, even when exit acknowledgment is offline=${exitOffline}`, async () => {
  let attempted = 0;
  let spawned = 0;
  await withProcessScope({
    beforeSpawn: () => { attempted++; throw new Error('connect ECONNREFUSED'); },
    onSpawn: () => { spawned++; },
    onExit: (_token, result) => { assert.equal(result.pid, null); assert.equal(result.reaped, true); if (exitOffline) throw new Error('still offline'); },
  }, async () => {
    const coding = runOwnedProcess(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { signal: currentProcessScopeSignal() });
    await assert.rejects(run(process.execPath, ['-e', 'throw new Error("must not start")']), error => error instanceof Error && !(error instanceof UtilityProcessError) && /ECONNREFUSED/.test(error.message));
    assert.equal(currentProcessScopeSignal()!.aborted, false);
    assert.equal((await coding).end, 'exit');
  });
  assert.equal(attempted, 1); assert.equal(spawned, 0);
});

test('parallel utility tokens both survive registration until both groups are reaped', async () => {
  const files = [pidFile(), pidFile()];
  const controller = new AbortController();
  const r = registry({ signal: controller.signal });
  const work = withProcessScope(r.options, () => Promise.all(files.map((file) => run(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_MODE: 'hang', FIXTURE_PID: file },
  }))));
  const rejection = assert.rejects(work, UtilityProcessError);
  const pids = await Promise.all(files.map(ready));
  assert.equal(r.intents.size, 2);
  controller.abort('stop parallel utilities');
  await rejection;
  assert.equal(r.tokens.size, 2);
  assert.equal(r.exits.length, 2);
  assert.equal(r.intents.size, 0);
  for (const pid of pids) assert.equal(isAlive(pid), false);
});

test('exit RPC failure poisons a scope after physical reap and leaves the intent for recovery', async () => {
  const r = registry({ onExit: () => { throw new Error('exit registry offline'); } });
  await assert.rejects(withProcessScope(r.options, async () => {
    await run(process.execPath, ['-e', '']).catch(() => undefined);
  }), (err: unknown) => err instanceof UtilityProcessError && err.result.reaped && /exit registry offline/.test(err.message));
  assert.equal(r.intents.size, 1);
  for (const value of r.intents.values()) assert.equal(isAlive(value.pid), false);
});

test('input utilities obey scoped timeout and hung registration is bounded', async () => {
  const input = registry({ timeoutMs: 150 });
  await assert.rejects(withProcessScope(input.options, () => run(process.execPath, [fixture], {
    input: 'input', env: { ...process.env, FIXTURE_MODE: 'hang' },
  })), (err: unknown) => err instanceof UtilityProcessError && err.result.end === 'timeout' && err.result.reaped);
  const hung = registry({ hookTimeoutMs: 50, onSpawn: () => new Promise(() => undefined) });
  await assert.rejects(withProcessScope(hung.options, () => run(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_MODE: 'hang' },
  })), (err: unknown) => err instanceof UtilityProcessError && err.result.end === 'hook_failed' && err.result.reaped);
});
