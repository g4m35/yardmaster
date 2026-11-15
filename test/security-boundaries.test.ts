import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, get, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { hookClient } from '../src/hookclient.ts';
import { remoteClient } from '../src/rpc.ts';
import { saveWorkerCredential } from '../src/fleet-client.ts';
import { bundleRetryDelay, httpTransport } from '../src/transport.ts';
import { paths, machineId } from '../src/paths.ts';
import { buildMethods, dispatch, localClient } from '../src/api.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { Hub } from '../src/hub.ts';
import { cleanEnv, runShell } from '../src/proc.ts';
import { MAX_VERDICT_LENGTH } from '../src/run-schema.ts';
import { loadConfig } from '../src/config.ts';
import { checkCommit } from '../src/ci/gate.ts';
import { runReview } from '../src/review.ts';
import { verifyArtifact } from '../src/verification.ts';
import { runOneShot } from '../src/oneshot.ts';
import { inScope, matches, scopesOverlap } from '../src/scope.ts';
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
    for (const hub of ['https://remote.invalid', 'http://remote.invalid']) for (const command of ['status', 'mcp']) {
      assert.throws(() => execFileSync(process.execPath, ['src/cli.ts', command, '--hub', hub], {
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

test('the hub this machine published on its own overlay address stays owner-local; stale or foreign hub.info does not', async () => {
  const box = sandbox(); chmodSync(box.home, 0o700);
  writeFileSync(join(box.home, 'token'), 'fixture-owner');
  // An address this machine holds right now, like the overlay IP of `ym hub run --host 100.x`.
  const own = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.1';
  const publish = (url: string, pid: number) => writeFileSync(paths.hubInfo(), JSON.stringify({ url, pid, startedAt: Date.now() }));
  const restore = envFixture({ YARDMASTER_HUB: undefined, YARDMASTER_TOKEN: undefined, YARDMASTER_PROJECT_ID: undefined, YARDMASTER_PRIVATE_NETWORK: undefined });
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return Response.json({ ok: true, result: {} }); };
  try {
    publish(`http://${own}:7777`, process.pid);
    await hookClient()!['board.status']({});
    assert.equal(requests[0]!.url, `http://${own}:7777/api/rpc/board.status`);
    assert.equal((requests[0]!.init!.headers as Record<string, string>).authorization, 'Bearer fixture-owner');
    // A hub.info left by a crashed hub, or rewritten to a host this machine does not hold, never receives the owner token.
    publish(`http://${own}:7777`, 2 ** 22 + 12345);
    assert.equal(hookClient(), null);
    publish('http://100.64.0.5:7777', process.pid);
    assert.equal(hookClient(), null);
    assert.throws(() => remoteClient('http://100.64.0.5:7777', 'fixture-owner', { ownerLocal: true }), /Non-loopback HTTP requires/);
    assert.equal(requests.length, 1);
    // The same address supplied by the environment is a remote endpoint: no owner token.
    process.env.YARDMASTER_HUB = `http://${own}:7777`; process.env.YARDMASTER_PRIVATE_NETWORK = '1';
    assert.throws(() => hookClient(), /Remote hubs require an explicit credential/);
  } finally { globalThis.fetch = original; restore(); }
});

test('agents keep cloud-provider sign-in, and region, profile and user-only URLs are not treated as secrets', () => {
  const restore = envFixture({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: undefined, AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-fixture', AWS_SECRET_ACCESS_KEY: 'aws-fixture', AZURE_OPENAI_API_KEY: 'azure-fixture',
    GOOGLE_APPLICATION_CREDENTIALS: '/fixture/adc.json', REPO_URL: 'ssh://git@github.com/acme/app.git', DB_URL: 'postgres://app:hunter2@db/app',
    MIRROR_URL: 'https://deploy@git.example/acme/app.git', AZURE_OPENAI_ENDPOINT: 'https://svc:hunter2@gateway.example', ORIGIN_URL: 'https://ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/acme/app.git' });
  try {
    const claude = cleanEnv({}, { agent: 'claude' });
    // Bedrock is switched on, so AWS credentials are Claude Code's own sign-in.
    assert.equal(claude.AWS_BEARER_TOKEN_BEDROCK, 'bedrock-fixture'); assert.equal(claude.AWS_SECRET_ACCESS_KEY, 'aws-fixture');
    assert.equal(claude.AZURE_OPENAI_API_KEY, undefined);
    const codex = cleanEnv({}, { agent: 'codex' });
    assert.equal(codex.AZURE_OPENAI_API_KEY, 'azure-fixture');
    assert.equal(codex.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(codex.AWS_BEARER_TOKEN_BEDROCK, undefined);
    const check = cleanEnv();
    assert.equal(check.AWS_PROFILE, 'dev'); assert.equal(check.AWS_REGION, 'us-east-1');
    // An endpoint name is not a secret, but a password in its value still is.
    assert.equal(check.AZURE_OPENAI_ENDPOINT, undefined); assert.equal(codex.AZURE_OPENAI_ENDPOINT, undefined);
    assert.equal(check.REPO_URL, 'ssh://git@github.com/acme/app.git');
    assert.equal(check.DB_URL, undefined); assert.equal(check.AWS_SECRET_ACCESS_KEY, undefined);
    // A token written as the URL user is a secret; a short account name is not.
    assert.equal(check.ORIGIN_URL, undefined); assert.equal(check.MIRROR_URL, 'https://deploy@git.example/acme/app.git');
    process.env.CLAUDE_CODE_USE_BEDROCK = ''; process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const vertex = cleanEnv({}, { agent: 'claude' });
    assert.equal(vertex.GOOGLE_APPLICATION_CREDENTIALS, '/fixture/adc.json'); assert.equal(vertex.AWS_SECRET_ACCESS_KEY, undefined);
  } finally { restore(); }
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
      { touched: '[' }, { touched: [1] }, { touched: ['a\0b'] }, { touched: Array(2001).fill('x') },
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
  assert.equal(matches('x', '*'.repeat(65)), true, 'legacy oversized globs conservatively match');
  assert.equal(matches('x', 'a'.repeat(1025)), true, 'legacy input never throws in matching');
  assert.deepEqual(scopesOverlap(Array(4097).fill('a'), ['b']), ['scope exceeds safe matching limits']);
});

test('worker paths are literal: glob characters in real file names are matched as themselves, oversized input is refused', async () => {
  const f = await runFixture();
  try {
    for (const files of [['x'.repeat(1025)], ['a\0b']]) {
      await assert.rejects(dispatch(f.methods, 'task.touched', { taskId: f.task.id, runId: f.run.id, owner: f.owner, files }));
      await assert.rejects(dispatch(f.methods, 'lock.check', { projectId: f.project.id, paths: files }));
    }
    await assert.rejects(dispatch(f.methods, 'lock.claim', { projectId: f.project.id, holder: 'test', patterns: ['*'.repeat(65)] }));
    await assert.rejects(dispatch(f.methods, 'task.setScope', { id: f.task.id, scope: Array(201).fill('a') }));
    assert.deepEqual(f.coord.getRun(f.run.id)!.touched, []);
    // A template repository's real file name keeps live overlap telemetry and pre-edit locking working.
    const template = '{{cookiecutter.slug}}/app.py';
    await dispatch(f.methods, 'task.touched', { taskId: f.task.id, runId: f.run.id, owner: f.owner, files: [template, '*literally*.md'] });
    assert.deepEqual(f.coord.getRun(f.run.id)!.touched, [template, '*literally*.md']);
    const held = await dispatch(f.methods, 'hook.check', { projectId: f.project.id, paths: [template], cwd: f.box.repo, sessionId: 'session:other' }) as { holder: string } | null;
    assert.equal(held?.holder, f.task.id);
    assert.equal(await dispatch(f.methods, 'hook.check', { projectId: f.project.id, paths: ['docs/app.py'], cwd: f.box.repo, sessionId: 'session:other' }), null);
    // yard_who / lock.check ask about folders and patterns, so a folder that contains someone's file is not free.
    await dispatch(f.methods, 'lock.claim', { projectId: f.project.id, holder: 'session:a', patterns: ['lib/auth/x.ts'] });
    const folder = await dispatch(f.methods, 'lock.check', { projectId: f.project.id, paths: ['lib/'] }) as { holder: string }[];
    assert.deepEqual(folder.map(h => h.holder), ['session:a']);
    // A file edited in a session that is literally named lib/*.ts reserves that one file, not every .ts in lib.
    await dispatch(f.methods, 'hook.reserve', { projectId: f.project.id, sessionName: 'b', cwd: f.box.repo, paths: ['lib/*.ts'] });
    assert.deepEqual((await dispatch(f.methods, 'lock.check', { projectId: f.project.id, paths: ['lib/other.ts'] }) as unknown[]).length, 0);
    const literal = await dispatch(f.methods, 'hook.check', { projectId: f.project.id, paths: ['lib/*.ts'], cwd: f.box.repo, sessionId: 'session:c' }) as { detail: string } | null;
    assert.match(literal!.detail, /reserved lib\/\*\.ts/);
  } finally { f.coord.db.close(); }
});

test('child environments remove unrelated secrets and retain only the selected adapter authentication', () => {
  const secrets = { SERVICE_TOKEN: 'fixture', PRIVATE_SECRET: 'fixture', SIGNING_KEY: 'fixture', PASSWORD: 'fixture', MY_CREDENTIAL: 'fixture',
    AWS_ACCESS_KEY_ID: 'fixture', AZURE_TENANT_ID: 'fixture', GOOGLE_APPLICATION_CREDENTIALS: 'fixture', GH_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', NPM_TOKEN: 'fixture',
    DATABASE_URL: 'postgres://user:pass@db.test/app', OPAQUE_URL: 'redis://:pass@cache.test', YARDMASTER_TOKEN: 'fixture', YARDMASTER_HUB: 'https://hub.invalid',
    ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', CODEX_AUTH_TOKEN: 'codex', CODEX_HOME: '/tmp/fixture-codex', CURSOR_API_KEY: 'cursor', GEMINI_API_KEY: 'gemini' };
  const restore = envFixture({ ...secrets, HTTPS_PROXY: 'http://proxy.test', LANG: 'en_CA.UTF-8', NODE_EXTRA_CA_CERTS: '/tmp/fixture-ca', PATH: process.env.PATH });
  try {
    for (const key of Object.keys(secrets)) assert.equal(cleanEnv()[key], undefined, key);
    const safe = cleanEnv(); assert.equal(safe.HTTPS_PROXY, 'http://proxy.test'); assert.equal(safe.LANG, 'en_CA.UTF-8'); assert.equal(safe.NODE_EXTRA_CA_CERTS, '/tmp/fixture-ca'); assert.ok(safe.PATH);
    for (const [agent, allowed] of Object.entries({ claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY', 'CODEX_AUTH_TOKEN', 'CODEX_HOME'], cursor: ['CURSOR_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] })) {
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
    const verified = await verifyArtifact(box.repo, [`${process.execPath} -e 'process.exit(!process.env.AGENT_SECRET && !!process.env.CHECK_SECRET && !process.env.UNRELATED_TOKEN && !process.env.OPENAI_API_KEY ? 0 : 1)'`], 1, undefined, undefined, { envPass: config.env.checks.pass });
    assert.equal(verified.ok, true, verified.output);
    assert.throws(() => loadConfig(box.repo, { env: { pass: ['INVALID=NAME'] } }));
  } finally { restore(); }
});

type BundleSender = { sendBaseBundle(res: ServerResponse, project: string, have: string | null, guard?: () => void, workerId?: string): Promise<void> };
async function bundleFixture(bytes = 2 * 1024 * 1024) {
  const box = sandbox();
  writeFileSync(join(box.repo, 'large.bin'), randomBytes(bytes));
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
  } finally {
    release();
    for (const response of await Promise.allSettled(pending)) if (response.status === 'fulfilled') await response.value.body?.cancel().catch(() => undefined);
    server.closeAllConnections(); await f.done();
    await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close();
  }
});


test('base-bundle clients retry 429 without losing task preparation and cancel during backoff', async () => {
  const box = sandbox();
  const local = join(box.root, 'worker'); mkdirSync(local);
  sh(local, 'git', ['init', '-q', '-b', 'main']);
  writeFileSync(join(box.repo, 'new.txt'), 'remote commit');
  sh(box.repo, 'git', ['add', '.']); sh(box.repo, 'git', ['commit', '-qm', 'remote base']);
  const sha = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  const bundle = join(box.root, 'base.bundle'); sh(box.repo, 'git', ['bundle', 'create', bundle, 'refs/heads/main']);
  const project = { id: 'p-test', name: 'test', root: box.repo, base_branch: 'main', created_at: Date.now() };
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    requests++;
    return requests === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } })
      : new Response(readFileSync(bundle), { headers: { 'x-yardmaster-branch': 'main' } });
  };
  try {
    const transport = httpTransport('http://127.0.0.1:7777', 'fixture', 'm-test');
    await transport.fetchBase(project, local, sha);
    assert.equal(requests, 2);
    assert.equal(sh(local, 'git', ['rev-parse', 'refs/yardmaster/hub/main']), sha);
    const abort = new AbortController();
    globalThis.fetch = async () => { requests++; queueMicrotask(() => abort.abort()); return new Response('busy', { status: 429, headers: { 'retry-after': '60' } }); };
    const started = performance.now();
    await assert.rejects(transport.fetchBase(project, local, sha, abort.signal), /abort/i);
    assert.equal(requests, 3); assert.ok(performance.now() - started < 1000);
  } finally { globalThis.fetch = original; }
});


test('legacy oversized scopes hold their task without breaking unrelated claims', async () => {
  const f = await runFixture();
  try {
    const bad = f.coord.addTasks(f.project.id, [{ title: 'Legacy oversized scope', agent: 'mock', priority: 10 }], 'test').created[0]!;
    f.coord.updateTask(bad.id, { scope: Array.from({ length: 4097 }, (_, i) => `legacy/file-${i}`) });
    const good = f.coord.addTasks(f.project.id, [{ title: 'Unrelated valid scope', agent: 'mock', files: ['docs/**'] }], 'test').created[0]!;
    assert.match(f.coord.blocker(f.coord.getTask(bad.id)!)!, /Stored scope exceeds/);
    assert.equal(f.coord.claimNext({ machineId: 'm-two', agents: ['mock'], repos: { [f.project.id]: f.box.repo }, runningByAgent: {} })!.task.id, good.id);
    f.coord.updateTask(f.task.id, { scope: ['*'.repeat(100)] });
    assert.deepEqual(f.coord.activeScopes(f.project.id).find(a => a.task.id === f.task.id)!.scope, ['**']);
    const legacy = f.coord.getTask(bad.id)!;
    assert.equal(inScope('unrelated/file', legacy.scope), true);
    new Coordinator(f.coord.db).blocker(legacy);
    f.coord.blocker(legacy);
    const warnings = f.coord.eventsSince(0, f.project.id, 1000).filter(e => e.kind === 'task.scope_legacy');
    assert.equal(warnings.filter(e => e.task_id === bad.id).length, 1);
    assert.equal(warnings.filter(e => e.task_id === f.task.id).length, 1);
  } finally { f.coord.db.close(); }
});

test('CLI verify and both CI check paths honor named check-only secret exceptions', async () => {
  const box = sandbox();
  const command = `${process.execPath} -e 'process.exit(!!process.env.DATABASE_URL && !!process.env.NPM_TOKEN && !process.env.AGENT_SECRET && !process.env.UNRELATED_TOKEN ? 0 : 1)'`;
  writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: [command], env: { pass: ['AGENT_SECRET'], checks: { pass: ['DATABASE_URL', 'NPM_TOKEN'] } }, worktree: { warmStart: 'off' } }));
  sh(box.repo, 'git', ['add', '.']); sh(box.repo, 'git', ['commit', '-qm', 'check env config']);
  const sha = sh(box.repo, 'git', ['rev-parse', 'HEAD']);
  const restore = envFixture({ DATABASE_URL: 'postgres://fixture:fixture@db.invalid/test', NPM_TOKEN: 'fixture', AGENT_SECRET: 'fixture', UNRELATED_TOKEN: 'fixture' });
  try {
    const config = loadConfig(box.repo);
    assert.equal((await checkCommit(box.repo, box.repo, sha, [command], config)).ok, true);
    writeFileSync(join(box.repo, 'untracked.txt'), 'force isolated check');
    assert.equal((await checkCommit(box.repo, box.repo, sha, [command], config)).ok, true);
    sh(box.repo, 'git', ['clean', '-f', '--', 'untracked.txt']);
    const result = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'verify', '--json'], { cwd: box.repo, env: { ...process.env }, encoding: 'utf8', timeout: 15000 }));
    assert.equal(result.ok, true);
  } finally { restore(); }
});

test('oversized review output follows the unreadable result path before run persistence', async () => {
  const f = await runFixture();
  try {
    const script = join(f.box.root, 'review.mjs');
    writeFileSync(script, `for await (const c of process.stdin) {} console.log(JSON.stringify({verdict:'approve',issues:Array(201).fill({severity:'minor',note:'fixture issue'})}));`);
    const config = loadConfig(f.box.repo, { agents: { 'review-fixture': { command: `${process.execPath} ${script}` } }, review: { reviewers: ['review-fixture'], crossFamily: false } });
    const result = await runReview({ task: f.task, config, implementer: 'mock', installed: ['review-fixture'], cwd: f.box.repo, base: sh(f.box.repo, 'git', ['rev-parse', 'HEAD']) });
    assert.ok('reason' in result && result.reason === 'unreadable');
  } finally { f.coord.db.close(); }
});


test('MCP startup sends only the selected explicit credential and honors private transport acknowledgment', () => {
  const box = sandbox();
  const capture = join(box.root, 'requests.json');
  const preload = join(box.root, 'capture.mjs');
  writeFileSync(join(box.home, 'token'), 'fixture-owner');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => { writeFileSync(${JSON.stringify(capture)}, JSON.stringify({url:String(url),authorization:init.headers.authorization,redirect:init.redirect})); return Response.json({ok:true,result:'session-fixture'}); };`);
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const env = { ...process.env, YARDMASTER_HOME: box.home, YARDMASTER_TOKEN: '', YARDMASTER_HUB: '', YARDMASTER_TASK_ID: '', YARDMASTER_PROJECT_ID: '' };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => execFileSync(process.execPath, ['--import', preload, cli, 'mcp', ...args], {
    cwd: box.repo, env: { ...env, ...extra }, encoding: 'utf8', input: '', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.throws(() => run(['--hub', 'https://remote.invalid']), /No saved worker credential|Remote hubs require/);
  assert.equal(existsSync(capture), false, 'missing remote credentials launch no authenticated request');
  assert.throws(() => run([], { YARDMASTER_HUB: 'https://remote.invalid' }), /No saved worker credential|Remote hubs require/);
  assert.equal(existsSync(capture), false);
  run(['--hub', 'https://remote.invalid'], { YARDMASTER_TOKEN: 'fixture-explicit' });
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {url:'https://remote.invalid/api/rpc/session.register',authorization:'Bearer fixture-explicit',redirect:'error'});
  run(['--hub', 'http://remote.invalid', '--private-network', '--token', 'fixture-cli']);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {url:'http://remote.invalid/api/rpc/session.register',authorization:'Bearer fixture-cli',redirect:'error'});
});

test('bundle retries honor Retry-After with bounded exponential backoff and positive jitter', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(bundleRetryDelay('60', 0, now, () => 0), 60000);
  assert.equal(bundleRetryDelay('9'.repeat(400), 0, now, () => 0), Infinity, 'huge delays wait for cancellation rather than overflowing a Node timer');
  assert.equal(bundleRetryDelay(new Date(now + 60000).toUTCString(), 0, now, () => 0), 60000);
  assert.equal(bundleRetryDelay('0', 0, now, () => 0), 250);
  assert.equal(bundleRetryDelay(null, 1, now, () => 0), 500);
  assert.equal(bundleRetryDelay('invalid', 100, now, () => 0), 5000);
  assert.equal(bundleRetryDelay('60', 0, now, () => 0.999), 60062);
  assert.equal(bundleRetryDelay(null, 100, now, () => 0.999), 6248);
});

test('six concurrent task base downloads survive per-worker contention', { timeout: 60000 }, async () => {
  const f = await bundleFixture(65536);
  const sha = sh(f.box.repo, 'git', ['rev-parse', 'HEAD']);
  const clients = Array.from({ length: 6 }, (_, i) => {
    const repo = join(f.box.root, `worker-${i}`); mkdirSync(repo); sh(repo, 'git', ['init', '-q', '-b', 'main']); return repo;
  });
  let rejected = 0;
  let release: () => void = () => {};
  const first = new Promise<void>(r => { release = r; });
  const head = f.hub.integrator.head;
  let admitted = 0;
  f.hub.integrator.head = async id => { if (++admitted === 1) await first; return head(id); };
  const server = createServer((_req, res) => {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'retry-after' ? '0' : value);
    res.on('finish', () => { if (res.statusCode === 429 && ++rejected >= 5) release(); });
    void f.sender.sendBaseBundle(res, f.project.id, null, undefined, 'm-shared').catch(() => res.destroy());
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = httpTransport(`http://127.0.0.1:${address.port}`, 'fixture', 'm-shared');
  try {
    await Promise.all(clients.map(repo => transport.fetchBase(f.project, repo, sha, AbortSignal.timeout(45000))));
    assert.ok(rejected >= 5, 'contention was exercised rather than bypassed');
    assert.equal(admitted, 6);
    for (const repo of clients) assert.equal(sh(repo, 'git', ['rev-parse', 'refs/yardmaster/hub/yardmaster/integration']), sha);
  } finally { release(); server.closeAllConnections(); await f.done(); await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close(); }
});

test('base-bundle unlink failures release both admission counters', async () => {
  const f = await bundleFixture(65536);
  const remove = fs.rmSync;
  const leftovers: string[] = [];
  let cleanupErrors = 0;
  fs.rmSync = (path, options) => {
    if (String(path).startsWith(join(f.box.home, 'tmp')) && String(path).endsWith('.bundle')) { leftovers.push(String(path)); throw new Error('fixture unlink failure'); }
    return remove(path, options);
  };
  syncBuiltinESMExports();
  const server = createServer((_req, res) => {
    void f.sender.sendBaseBundle(res, f.project.id, null, undefined, 'm-same').catch(() => { cleanupErrors++; res.destroy(); });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (let i = 1; i <= 5; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      assert.equal(response.status, 200, 'a failed unlink must not leave the hub or worker busy');
      await response.arrayBuffer(); await f.done();
      assert.equal(cleanupErrors, i);
    }
  } finally {
    fs.rmSync = remove; syncBuiltinESMExports();
    for (const file of leftovers) remove(file, { force: true });
    server.closeAllConnections(); await f.done(); await new Promise<void>(r => server.close(() => r())); f.hub.coord.db.close();
  }
});

test('finished reviews at the shared serialized bound persist and larger reviews are unreadable', async () => {
  const f = await runFixture();
  try {
    const script = join(f.box.root, 'bounded-review.mjs');
    const review = { verdict:'approve', issues:Array.from({length:5}, () => ({severity:'minor',note:'x'.repeat(19000)})), summary:'' };
    review.summary = 's'.repeat(MAX_VERDICT_LENGTH - JSON.stringify(review).length);
    assert.equal(JSON.stringify(review).length, MAX_VERDICT_LENGTH);
    const write = () => writeFileSync(script, `for await(const chunk of process.stdin) {} console.log(${JSON.stringify(JSON.stringify(review))});`);
    write();
    const config = loadConfig(f.box.repo, { agents:{'bounded-review':{command:`${process.execPath} ${script}`}}, review:{reviewers:['bounded-review'],crossFamily:false} });
    const opts = {task:f.task,config,implementer:'mock',installed:['bounded-review'],cwd:f.box.repo,base:sh(f.box.repo,'git',['rev-parse','HEAD'])};
    const accepted = await runReview(opts);
    assert.ok('review' in accepted);
    await dispatch(f.methods, 'run.update', {runId:f.run.id,owner:f.owner,patch:{verdict:JSON.stringify(accepted.review)}});
    assert.equal(f.coord.getRun(f.run.id)!.verdict!.length, MAX_VERDICT_LENGTH);
    review.summary += 's'; write();
    const rejected = await runReview(opts);
    assert.ok('reason' in rejected && rejected.reason === 'unreadable');
  } finally { f.coord.db.close(); }
});

test('new configuration scope input is bounded before it reaches matching', () => {
  const box = sandbox();
  assert.throws(() => loadConfig(box.repo, { hotFiles:['*'.repeat(65)] }));
  assert.throws(() => loadConfig(box.repo, { hotFiles:Array(201).fill('file') }));
  assert.throws(() => loadConfig(box.repo, { policies:[{when:{files:['x'.repeat(1025)]},set:{review:'always'}}] }));
});
