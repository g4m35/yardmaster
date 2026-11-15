import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, get, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hookClient } from '../src/hookclient.ts';
import { remoteClient } from '../src/rpc.ts';
import { saveWorkerCredential } from '../src/fleet-client.ts';
import { paths, machineId } from '../src/paths.ts';
import { buildMethods, dispatch, localClient } from '../src/api.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { Hub } from '../src/hub.ts';
import { cleanEnv, runShell } from '../src/proc.ts';
import { loadConfig } from '../src/config.ts';
import { runOneShot } from '../src/oneshot.ts';
import { matches, scopesOverlap } from '../src/scope.ts';
import { sandbox, sh } from './helpers.ts';

function envFixture(values: NodeJS.ProcessEnv): () => void {
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test('remote hook and CLI never fall back to the local owner token', async () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'token'), 'fixture-owner');
  const restore = envFixture({ YARDMASTER_HUB: 'https://remote.invalid', YARDMASTER_TOKEN: undefined, YARDMASTER_PROJECT_ID: undefined });
  try {
    assert.throws(() => hookClient(), /Remote hubs require an explicit credential/);
    process.env.YARDMASTER_HUB = 'http://remote.invalid';
    assert.throws(() => hookClient(), /Non-loopback HTTP requires/);
    for (const hub of ['https://remote.invalid', 'http://remote.invalid']) {
      assert.throws(() => execFileSync(process.execPath, ['src/cli.ts', 'status', '--hub', hub], {
        cwd: join(import.meta.dirname, '..'), env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      }), hub.startsWith('https') ? /No saved worker credential|Remote hubs require an explicit credential/ : /Non-loopback HTTP requires/);
    }
  } finally { restore(); }
});

test('hook credentials are exact-URL scoped and authenticated RPCs refuse redirects', async () => {
  const box = sandbox(); chmodSync(box.home, 0o700);
  writeFileSync(join(box.home, 'token'), 'fixture-owner');
  const restore = envFixture({ YARDMASTER_HUB: 'https://remote.invalid', YARDMASTER_TOKEN: undefined, YARDMASTER_PROJECT_ID: 'p-scope' });
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ ok: true, result: {} });
  };
  try {
    const token = `ymw_${'a'.repeat(43)}`;
    saveWorkerCredential({ version: 1, hub: 'https://remote.invalid', token, kind: 'worker', projectId: 'p-scope', machineId: machineId(), expiresAt: Date.now() + 60000 });
    await hookClient()!['fleet.identity']({});
    assert.equal((requests[0]!.init!.headers as Record<string, string>).authorization, `Bearer ${token}`);
    assert.equal(requests[0]!.init!.redirect, 'error');
    process.env.YARDMASTER_HUB = 'https://other.invalid';
    assert.throws(() => hookClient(), /No saved worker credential/);
    delete process.env.YARDMASTER_PROJECT_ID;
    process.env.YARDMASTER_HUB = 'http://localhost:7777';
    await hookClient()!['board.status']({});
    assert.equal((requests[1]!.init!.headers as Record<string, string>).authorization, 'Bearer fixture-owner');
    process.env.YARDMASTER_TOKEN = 'fixture-explicit';
    process.env.YARDMASTER_HUB = 'http://remote.invalid';
    assert.throws(() => hookClient(), /private-network/);
    process.env.YARDMASTER_PRIVATE_NETWORK = '1';
    await hookClient()!['board.status']({});
    assert.equal(requests[2]!.init!.redirect, 'error');
    assert.equal((requests[2]!.init!.headers as Record<string, string>).authorization, 'Bearer fixture-explicit');
  } finally { globalThis.fetch = original; delete process.env.YARDMASTER_PRIVATE_NETWORK; restore(); }

  let leaked = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirected') { leaked++; res.end('{}'); }
    else { res.writeHead(307, { location: '/redirected' }); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await assert.rejects(remoteClient(`http://127.0.0.1:${address.port}`, 'fixture')['board.status']({}));
    assert.equal(leaked, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

async function runFixture() {
  const box = sandbox();
  const coord = new Coordinator(openDb(join(box.home, 'security.db')));
  const project = await coord.registerProject(box.repo);
  const task = coord.addTasks(project.id, [{ title: 'Security regression', agent: 'mock', files: ['src/**'] }], 'test').created[0]!;
  const claim = coord.claimNext({ machineId: 'm-test', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!.task;
  const owner = { generation: claim.generation, assignee: claim.assignee! };
  const run = coord.startRun(claim, 'm-test', 'mock', null, '');
  const methods = buildMethods(coord, { machineId: 'm-hub' });
  return { box, coord, project, task, run, owner, methods };
}

test('run.update validates every telemetry value atomically before persistence', async () => {
  const f = await runFixture();
  try {
    for (const patch of [
      { touched: '[' }, { touched: [1] }, { touched: ['*a*a*a*a*a*a*a*a*a*a*b'] }, { touched: Array(2001).fill('x') },
      { touched: ['a'.repeat(1025)] }, { phases: [] }, { phases: { agent: -1 } }, { phases: { agent: Infinity } },
      { lessons: {} }, { lessons: ['x'.repeat(201)] }, { verdict: '[' }, { verdict: '{"verdict":"approve","issues":5}' },
      { pid: '123' }, { ended_at: -1 }, { tokens_in: NaN }, { cost_usd: Infinity }, { resumed: 'yes' }, { phase: {} },
    ]) {
      await assert.rejects(dispatch(f.methods, 'run.update', { runId: f.run.id, owner: f.owner, patch: { last_activity: 'must not persist', ...patch } }));
      assert.equal(f.coord.getRun(f.run.id)!.last_activity, null);
    }
    assert.throws(() => f.coord.updateRun(f.run.id, { touched: '[' as unknown as string[] }));
    await dispatch(f.methods, 'run.update', { runId: f.run.id, owner: f.owner, patch: {
      touched: ['src/app.ts', 'app/[id]/page.ts'], phases: { agent: 12 }, verdict: JSON.stringify({ verdict: 'approve', issues: [] }), pid: null, resumed: true,
    } });
    assert.deepEqual(f.coord.getRun(f.run.id)!.touched, ['src/app.ts', 'app/[id]/page.ts']);
  } finally { f.coord.db.close(); }
});

test('corrupt historical telemetry cannot break board.status or unrelated scheduling and warns once', async () => {
  const f = await runFixture();
  try {
    f.coord.db.prepare('UPDATE runs SET touched = ?, lessons = ?, phases = ?, verdict = ? WHERE id = ?').run('[', '{}', '[]', '[', f.run.id);
    const run = f.coord.getRun(f.run.id)!;
    assert.deepEqual([run.touched, run.lessons, run.phases, run.verdict], [[], [], {}, null]);
    const client = localClient(f.methods);
    await client['board.status']({ projectId: f.project.id });
    assert.ok(f.coord.activeScopes(f.project.id).length);
    f.coord.addTasks(f.project.id, [{ title: 'Unrelated second work', agent: 'mock', files: ['docs/**'] }], 'test');
    assert.ok(f.coord.claimNext({ machineId: 'm-two', agents: ['mock'], repos: { [f.project.id]: f.box.repo }, runningByAgent: {} }));
    const second = new Coordinator(f.coord.db);
    second.getRun(f.run.id); second.runsFor(f.task.id); second.runningRunsOn('m-test');
    assert.equal(second.eventsSince(0).filter(e => e.kind === 'run.corrupt').length, 1);
  } finally { f.coord.db.close(); }
});

test('glob matching stays bounded for repeated stars and preserves scope semantics', () => {
  const start = performance.now();
  const module = new URL('../src/scope.ts', import.meta.url).href;
  const hostile = execFileSync(process.execPath, ['--input-type=module', '-e', `import { matches } from ${JSON.stringify(module)}; process.stdout.write(String(matches('a'.repeat(100) + 'c', '*a'.repeat(32) + 'b')));`], { encoding: 'utf8', timeout: 2000 });
  assert.equal(hostile, 'false');
  assert.ok(performance.now() - start < 3000, 'a hostile glob must not stall the event loop');
  for (const [path, pattern, expected] of [
    ['src/app.ts', '**/*.ts', true], ['app.ts', '**/*.ts', true], ['src/x/app.ts', 'src/*.ts', false],
    ['src/app.ts', 'src/{app,lib}.ts', true], ['src/lib.ts', 'src/{app,lib}.ts', true], ['src/a.ts', 'src/?.ts', true],
    ['folder/child/file', 'folder', true], ['folder/file', 'folder/', true], ['a/x/z.ts', 'a/**/z.ts', true],
    ['a/z.ts', 'a/**/z.ts', true], ['src/app/[id].ts', 'src/app/[id].ts', true], ['abc', 'a**c', true],
  ] as const) assert.equal(matches(path, pattern), expected, `${pattern} on ${path}`);
  assert.throws(() => matches('x', '*'.repeat(65)), /limits/);
  assert.throws(() => matches('x', 'a'.repeat(1025)), /limits/);
  assert.throws(() => scopesOverlap(Array(4097).fill('a'), ['b']), /limits/);
});

test('worker paths are literal and scope RPCs reject oversized or wildcard-heavy input', async () => {
  const f = await runFixture();
  try {
    for (const files of [['**'], ['*a'.repeat(10) + 'b'], ['x'.repeat(1025)]]) {
      await assert.rejects(dispatch(f.methods, 'task.touched', { taskId: f.task.id, runId: f.run.id, owner: f.owner, files }));
      await assert.rejects(dispatch(f.methods, 'lock.check', { projectId: f.project.id, paths: files }));
    }
    await assert.rejects(dispatch(f.methods, 'lock.claim', { projectId: f.project.id, holder: 'test', patterns: ['*'.repeat(65)] }));
    await assert.rejects(dispatch(f.methods, 'task.setScope', { id: f.task.id, scope: Array(201).fill('a') }));
    assert.deepEqual(f.coord.getRun(f.run.id)!.touched, []);
  } finally { f.coord.db.close(); }
});

test('child environments remove unrelated secrets and retain only the selected adapter authentication', () => {
  const secrets = { SERVICE_TOKEN: 'fixture', PRIVATE_SECRET: 'fixture', SIGNING_KEY: 'fixture', PASSWORD: 'fixture', MY_CREDENTIAL: 'fixture',
    AWS_ACCESS_KEY_ID: 'fixture', AZURE_TENANT_ID: 'fixture', GOOGLE_APPLICATION_CREDENTIALS: 'fixture', GH_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', NPM_TOKEN: 'fixture',
    DATABASE_URL: 'postgres://user:pass@db.test/app', OPAQUE_URL: 'redis://user:pass@cache.test', YARDMASTER_TOKEN: 'fixture', YARDMASTER_HUB: 'https://hub.invalid',
    ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', CODEX_AUTH_TOKEN: 'codex', CURSOR_API_KEY: 'cursor', GEMINI_API_KEY: 'gemini' };
  const restore = envFixture({ ...secrets, HTTPS_PROXY: 'http://proxy.test', LANG: 'en_CA.UTF-8', NODE_EXTRA_CA_CERTS: '/tmp/fixture-ca', PATH: process.env.PATH });
  try {
    for (const key of Object.keys(secrets)) assert.equal(cleanEnv()[key], undefined, key);
    const safe = cleanEnv(); assert.equal(safe.HTTPS_PROXY, 'http://proxy.test'); assert.equal(safe.LANG, 'en_CA.UTF-8'); assert.equal(safe.NODE_EXTRA_CA_CERTS, '/tmp/fixture-ca'); assert.ok(safe.PATH);
    for (const [agent, allowed] of Object.entries({ claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY', 'CODEX_AUTH_TOKEN'], cursor: ['CURSOR_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] })) {
      const env = cleanEnv({}, { agent });
      for (const key of Object.keys(secrets)) assert.equal(env[key], allowed.includes(key) ? secrets[key as keyof typeof secrets] : undefined, `${agent}: ${key}`);
    }
    const explicit = cleanEnv({}, { pass: ['DATABASE_URL', 'YARDMASTER_TOKEN'] });
    assert.equal(explicit.DATABASE_URL, secrets.DATABASE_URL); assert.equal(explicit.YARDMASTER_TOKEN, undefined);
    assert.equal(cleanEnv({ NEW_SECRET: 'fixture' }).NEW_SECRET, undefined);
  } finally { restore(); }
});

test('agent and check config pass lists reach real subprocesses independently', async () => {
  const box = sandbox({ env: { pass: ['AGENT_SECRET'], checks: { pass: ['CHECK_SECRET'] } } });
  const restore = envFixture({ AGENT_SECRET: 'agent', CHECK_SECRET: 'check', UNRELATED_TOKEN: 'fixture', OPENAI_API_KEY: 'fixture' });
  try {
    const script = join(box.root, 'env-agent.mjs');
    writeFileSync(script, `for await (const c of process.stdin) {}\nconsole.log(JSON.stringify([!!process.env.AGENT_SECRET,!!process.env.CHECK_SECRET,!!process.env.UNRELATED_TOKEN,!!process.env.OPENAI_API_KEY]));`);
    const config = loadConfig(box.repo, { agents: { 'env-fixture': { command: `${process.execPath} ${script}` } } });
    const agent = await runOneShot({ agent: 'env-fixture', config, prompt: 'test', cwd: box.repo });
    assert.equal(agent.ok, true, agent.error); assert.deepEqual(JSON.parse(agent.text), [true, false, false, false]);
    const check = await runShell(`${process.execPath} -e 'console.log(JSON.stringify([!!process.env.AGENT_SECRET,!!process.env.CHECK_SECRET,!!process.env.UNRELATED_TOKEN,!!process.env.OPENAI_API_KEY]))'`, {
      cwd: box.repo, timeoutMs: 10000, env: cleanEnv({ CI: '1' }, { pass: config.env.checks.pass }),
    });
    assert.equal(check.code, 0); assert.deepEqual(JSON.parse(check.stdout), [false, true, false, false]);
    assert.throws(() => loadConfig(box.repo, { env: { pass: ['INVALID=NAME'] } }));
  } finally { restore(); }
});

type BundleSender = { sendBaseBundle(res: ServerResponse, project: string, have: string | null, guard?: () => void, workerId?: string): Promise<void> };
async function bundleFixture() {
  const box = sandbox();
  writeFileSync(join(box.repo, 'large.bin'), randomBytes(2 * 1024 * 1024));
  sh(box.repo, 'git', ['add', '.']); sh(box.repo, 'git', ['commit', '-qm', 'bundle fixture']);
  sh(box.repo, 'git', ['branch', 'yardmaster/integration']);
  const hub = new Hub({ db: openDb(join(box.home, 'bundles.db')), token: 'fixture', machineId: 'm-hub' });
  const project = await hub.coord.registerProject(box.repo);
  hub.integrator.head = async () => sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  const raw = hub as unknown as BundleSender;
  const handlers = new Set<Promise<void>>();
  const sender: BundleSender = { sendBaseBundle(...args) {
    const operation = raw.sendBaseBundle(...args); handlers.add(operation);
    void operation.then(() => handlers.delete(operation), () => handlers.delete(operation));
    return operation;
  } };
  return { box, hub, project, sender, done: () => Promise.allSettled([...handlers]) };
}

test('base-bundle authorization failures and aborted streams always remove temporary files', async () => {
  const f = await bundleFixture();
  let error = false;
  let failed = false;
  const server = createServer((req, res) => {
    const guard = req.url === '/denied' ? () => { assert.ok(readdirSync(paths.tmp()).some(n => n.endsWith('.bundle'))); throw new Error('revoked'); } : undefined;
    void f.sender.sendBaseBundle(res, f.project.id, null, guard, 'm-worker').catch(() => { failed = true; res.destroy(); }).finally(() => { error = true; });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await new Promise<void>(resolve => { const req = get(`http://127.0.0.1:${address.port}/denied`); req.on('error', () => resolve()); });
    assert.equal(failed, true); assert.equal(error, true);
    assert.deepEqual(readdirSync(paths.tmp()).filter(n => n.endsWith('.bundle')), []);
    error = false; failed = false;
    await new Promise<void>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${address.port}/abort`, res => {
        res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => resolve());
      }); req.on('error', reject);
    });
    // Wait for the handler's finally, not just the client's disconnect notification.
    const deadline = Date.now() + 5000;
    while (!error && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(error, true); assert.equal(failed, true);
    assert.deepEqual(readdirSync(paths.tmp()).filter(n => n.endsWith('.bundle')), []);
  } finally { await f.done(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close(); }
});

test('base-bundle creation failure releases its temporary file and concurrency slot', async () => {
  const f = await bundleFixture();
  const original = f.hub.integrator.withLock.bind(f.hub.integrator);
  f.hub.integrator.withLock = async (id, action) => original(id, async () => { await action(); throw new Error('creation interrupted'); });
  const server = createServer((_req, res) => {
    void f.sender.sendBaseBundle(res, f.project.id, null, undefined, 'm-worker').catch(() => { if (!res.headersSent) { res.writeHead(503); res.end(); } else res.destroy(); });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`)).status, 503);
    assert.deepEqual(readdirSync(paths.tmp()).filter(n => n.endsWith('.bundle')), []);
    f.hub.integrator.withLock = original;
    const retry = await fetch(`http://127.0.0.1:${address.port}`); assert.equal(retry.status, 200); await retry.arrayBuffer();
  } finally { await f.done(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close(); }
});

test('base-bundle requests are bounded per hub and per worker until finally releases slots', async () => {
  const f = await bundleFixture();
  let release: () => void = () => {};
  const held = new Promise<void>(r => { release = r; });
  const head = f.hub.integrator.head;
  let started = 0;
  f.hub.integrator.head = async id => { started++; await held; return head(id); };
  const server = createServer((req, res) => {
    void f.sender.sendBaseBundle(res, f.project.id, null, undefined, req.url!.slice(1)).catch(() => res.destroy());
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const pending: Promise<Response>[] = [];
  try {
    pending.push(fetch(`${url}/worker-1`));
    while (started < 1) await new Promise(r => setTimeout(r, 10));
    assert.equal((await fetch(`${url}/worker-1`, { signal: AbortSignal.timeout(2000) })).status, 429);
    for (let i = 2; i <= 4; i++) pending.push(fetch(`${url}/worker-${i}`));
    while (started < 4) await new Promise(r => setTimeout(r, 10));
    assert.equal((await fetch(`${url}/worker-5`, { signal: AbortSignal.timeout(2000) })).status, 429);
    release();
    for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.arrayBuffer(); }
    const retry = await fetch(`${url}/worker-1`); assert.equal(retry.status, 200); await retry.arrayBuffer();
  } finally { release(); await Promise.allSettled(pending); await f.done(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close(); }
});
