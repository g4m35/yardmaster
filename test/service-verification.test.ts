import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, sh } from './helpers.ts';
import { ServicesConfigSchema } from '../src/provider-contract.ts';
import { builtinProviders } from '../src/provider-builtins.ts';
import { planService, runService } from '../src/providers.ts';
import { BrowserbaseOptionsSchema, runBrowserbase } from '../src/browserbase-provider.ts';
import { verifyArtifact } from '../src/verification.ts';
import { loadConfig } from '../src/config.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { runAttempt, Semaphore } from '../src/runner.ts';
import { createHash, randomUUID } from 'node:crypto';
import { beginService } from '../src/service-holds.ts';
import { loadPluginFile } from '../src/plugins.ts';
import { collectReceiptArchive } from '../scripts/collect-hosted-verification.mjs';

const key = 'fixture-account-credential';
const connect = `wss://connect.browserbase.com?apiKey=${key}&sessionId=session-fixture`;
function api(options: { createStatus?: number; releaseStatus?: number; connectUrl?: string; onRelease?: () => void; terminalStatus?: string; releasePending?: boolean; allowStatusAfterReleaseError?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const release = body?.status === 'REQUEST_RELEASE';
    if (release) options.onRelease?.();
    return new Response(JSON.stringify(release ? { status: options.releasePending ? 'RUNNING' : options.terminalStatus ?? 'COMPLETED' }
      : init?.method === 'GET' ? { status: options.terminalStatus ?? 'COMPLETED' }
      : { id: 'session-fixture', projectId: 'project-fixture', connectUrl: options.connectUrl ?? connect }),
      { status: release ? options.releaseStatus ?? 200 : init?.method === 'GET'
        ? (options.releaseStatus && !options.allowStatusAfterReleaseError ? options.releaseStatus : 200) : options.createStatus ?? 201 });
  }) as typeof fetch;
  return { calls, fetcher };
}
function browserFixture(code = 'console.log("browser assertions ran")') {
  const s = sandbox();
  const evidenceDir = join(s.home, 'browser-evidence'); mkdirSync(evidenceDir);
  const options = BrowserbaseOptionsSchema.parse({ command: [process.execPath, '-e', code], timeoutSeconds: 60 });
  const ctx = { command: process.execPath, cwd: s.repo, env: { PATH: process.env.PATH, HOME: s.home, BROWSERBASE_API_KEY: key },
    evidenceDir, input: {}, sha: sh(s.repo, 'git', ['rev-parse', 'HEAD']) };
  return { ...s, options, ctx };
}
function services(script: string) {
  return ServicesConfigSchema.parse({ local: { 'browser.verify': { service: 'browser',
    command: [process.execPath, '-e', script], protocol: 'json', locality: 'local', cost: 'free' } }, verify: [{ capability: 'browser.verify' }] });
}
const pass = `let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);console.log(JSON.stringify({status:'passed',summary:'Browser fixture passed',data:{sha:r.context.sha,pending:JSON.parse((await import('node:fs')).readFileSync(r.context.evidenceDir+'/result.json','utf8')).state}}));`;
// -e uses CommonJS unless explicitly asked for module syntax. The async wrapper keeps both runtimes valid.
const asyncCode = (s: string) => `(async()=>{${s}})().catch(()=>process.exit(1));`;

test('built-in Browserbase requires explicit opt-in, executable, credential and cost policy; missing prerequisites select local', () => {
  const s = sandbox(), plugins = builtinProviders();
  const cfg = ServicesConfigSchema.parse({ providers: { browserbase: { options: { command: [process.execPath, '-e', 'process.exit(0)'] } } },
    routes: { 'browser.verify': { prefer: ['browserbase', 'local'], allowedCosts: ['free', 'unknown'] } },
    local: { 'browser.verify': { service: 'browser', command: [process.execPath, '-e', 'process.exit(0)'], protocol: 'command', locality: 'local', cost: 'free' } } });
  assert.equal(planService('browser.verify', cfg, plugins, s.repo, {}).selected, 'local');
  assert.equal(planService('browser.verify', cfg, plugins, s.repo, { BROWSERBASE_API_KEY: key }).selected, 'browserbase');
  cfg.routes['browser.verify']!.allowedCosts = ['free'];
  assert.equal(planService('browser.verify', cfg, plugins, s.repo, { BROWSERBASE_API_KEY: key }).selected, 'local');
  assert.equal(planService('browser.verify', ServicesConfigSchema.parse({}), plugins, s.repo, { BROWSERBASE_API_KEY: key }).selected, null);
});

test('browser connector passes the connection to a real owned test process, saves redacted evidence and confirms release', async () => {
  const s = browserFixture(`const fs=require('node:fs');console.log(JSON.stringify({url:process.env.BROWSERBASE_CDP_URL,key:process.env.BROWSERBASE_API_KEY,sha:process.env.YARDMASTER_VERIFY_SHA}));fs.writeFileSync(process.env.YARDMASTER_ARTIFACT_DIR+'/assertions.txt','actual fixture assertions');`);
  const mock = api();
  const result = await runBrowserbase(s.options, s.ctx, mock.fetcher);
  assert.equal(result.result.status, 'passed'); assert.equal(result.execution.reaped, true);
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[0]!.body!.keepAlive, false);
  assert.equal(mock.calls[0]!.body!.timeout, 60); assert.equal(mock.calls[1]!.body!.status, 'REQUEST_RELEASE');
  const log = readFileSync(join(s.ctx.evidenceDir, 'command.log'), 'utf8');
  assert(!log.includes(key)); assert(log.includes('[redacted]')); assert(log.includes(s.ctx.sha));
  assert.equal(JSON.parse(log).key, undefined);
  assert.equal(JSON.parse(readFileSync(join(s.ctx.evidenceDir, 'session.json'), 'utf8')).state, 'released');
  assert(result.result.artifacts.some(file => file.endsWith('assertions.txt')));
});

test('browser command failure remains failed after releasing its one session', async () => {
  const s = browserFixture('process.exit(17)'), mock = api();
  const result = await runBrowserbase(s.options, s.ctx, mock.fetcher);
  assert.equal(result.result.status, 'failed'); assert.equal(mock.calls.length, 2);
});

test('built-in dispatch uses the browser connector and completes its private receipt', async () => {
  const s = browserFixture(), mock = api(), previousFetch = globalThis.fetch;
  globalThis.fetch = mock.fetcher;
  try {
    const cfg = ServicesConfigSchema.parse({ providers: { browserbase: { options: s.options } }, routes: { 'browser.verify': { prefer: ['browserbase'], allowedCosts: ['unknown'] } } });
    const result = await runService('browser.verify', {}, cfg, builtinProviders(), { cwd: s.repo, env: s.ctx.env, context: { sha: s.ctx.sha } });
    assert.equal(result.result.status, 'passed'); assert.equal(result.provider, 'browserbase'); assert.equal(mock.calls.length, 2);
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    assert.equal(receipt.state, 'completed'); assert.equal(receipt.context.sha, s.ctx.sha);
    assert(!JSON.stringify(receipt).includes(key));
  } finally { globalThis.fetch = previousFetch; }
});

test('release confirmation polls the same session; ERROR and TIMED_OUT sessions cannot pass', async () => {
  const s = browserFixture(), mock = api({ releasePending: true });
  assert.equal((await runBrowserbase(s.options, s.ctx, mock.fetcher)).result.status, 'passed');
  assert.equal(mock.calls.length, 3); assert.equal(mock.calls[2]!.body, undefined);
  const closed = browserFixture(), already = api({ releaseStatus: 409, allowStatusAfterReleaseError: true });
  assert.equal((await runBrowserbase(closed.options, closed.ctx, already.fetcher)).result.status, 'passed', 'an already completed session is confirmed through GET');
  for (const terminalStatus of ['ERROR', 'TIMED_OUT']) {
    const t = browserFixture(), end = api({ terminalStatus });
    assert.equal((await runBrowserbase(t.options, t.ctx, end.fetcher)).result.status, 'unknown');
  }
});

test('authentication failure creates no replacement session and returns unknown', async () => {
  const s = browserFixture(), mock = api({ createStatus: 401 });
  const result = await runBrowserbase(s.options, s.ctx, mock.fetcher);
  assert.equal(result.result.status, 'unknown'); assert.equal(mock.calls.length, 1);
});

test('malformed connection data still releases the known session', async () => {
  const s = browserFixture(), mock = api({ connectUrl: 'wss://untrusted.example' });
  const result = await runBrowserbase(s.options, s.ctx, mock.fetcher);
  assert.equal(result.result.status, 'unknown'); assert.equal(mock.calls.length, 2);
});

test('unconfirmed remote release prevents a passing browser result', async () => {
  const s = browserFixture(), mock = api({ releaseStatus: 503 });
  const result = await runBrowserbase(s.options, s.ctx, mock.fetcher);
  assert.equal(result.result.status, 'unknown');
  assert.equal(JSON.parse(readFileSync(join(s.ctx.evidenceDir, 'session.json'), 'utf8')).state, 'release-unconfirmed');
});

test('additional declared browser credentials are forwarded explicitly and redacted from the saved log', async () => {
  const s = browserFixture('console.log(process.env.APP_FIXTURE_SECRET)');
  s.options.requiredEnv = ['APP_FIXTURE_SECRET'];
  const mock = api(), secret = 'private-app-fixture';
  const result = await runBrowserbase(s.options, { ...s.ctx, env: { ...s.ctx.env, APP_FIXTURE_SECRET: secret } }, mock.fetcher);
  assert.equal(result.result.status, 'passed');
  assert.equal(readFileSync(join(s.ctx.evidenceDir, 'command.log'), 'utf8').trim(), '[redacted]');
  const cfg = ServicesConfigSchema.parse({ providers: { browserbase: { options: { command: [process.execPath], requiredEnv: ['YARDMASTER_TOKEN'] } } },
    routes: { 'browser.verify': { prefer: ['browserbase'], allowedCosts: ['unknown'] } } });
  assert.equal(planService('browser.verify', cfg, builtinProviders(), s.repo, { BROWSERBASE_API_KEY: key, YARDMASTER_TOKEN: secret }).selected, null);
});

test('cancellation before creation does not dispatch, and cancellation during release cannot pass', async () => {
  const s = browserFixture(), stop = new AbortController(), mock = api(); stop.abort();
  const before = await runBrowserbase(s.options, { ...s.ctx, signal: stop.signal }, mock.fetcher);
  assert.equal(before.dispatched, false); assert.equal(mock.calls.length, 0); assert.equal(before.result.status, 'unknown');
  const t = browserFixture(), later = new AbortController(), end = api({ onRelease: () => later.abort() });
  const during = await runBrowserbase(t.options, { ...t.ctx, signal: later.signal }, end.fetcher);
  assert.equal(during.result.status, 'unknown'); assert.equal(end.calls.length, 2);
});

test('cancellation reaps the browser test process and releases the remote session', async () => {
  const s = browserFixture('setInterval(()=>{},1000)'), stop = new AbortController(), mock = api();
  const result = await runBrowserbase(s.options, { ...s.ctx, signal: stop.signal, onSpawn: () => { stop.abort(); } }, mock.fetcher);
  assert.equal(result.result.status, 'unknown'); assert.equal(result.execution.reaped, true); assert.equal(mock.calls.length, 2);
});

test('provider-only verification binds the receipt to HEAD and persists its pending state before dispatch', async () => {
  const s = sandbox(), cfg = services(asyncCode(pass));
  let receipt = '';
  const result = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services: cfg, onServiceResult: run => { receipt = run.receiptPath; } });
  assert.equal(result.ok, true, result.output); assert.equal(result.sha, sh(s.repo, 'git', ['rev-parse', 'HEAD']));
  const record = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(record.state, 'completed'); assert.equal(record.context.sha, result.sha);
  assert.equal(record.result.data.pending, 'running'); assert.equal(record.result.data.sha, result.sha);
  assert(!receipt.startsWith(s.repo)); assert.equal(sh(s.repo, 'git', ['status', '--porcelain']), '');
});

test('provider verification preserves changed files and never accepts the old commit', async () => {
  const s = sandbox(), cfg = services(`require('node:fs').appendFileSync('README.md','changed');console.log(JSON.stringify({status:'passed',summary:'pretend pass'}));`);
  const result = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services: cfg });
  assert.equal(result.ok, false); assert.equal(result.serviceStatus, 'unknown'); assert.match(readFileSync(join(s.repo, 'README.md'), 'utf8'), /changed/);
});

test('unknown provider verification stops later checks without fallback or replay', async () => {
  const s = sandbox(), marker = join(s.home, 'never-ran'), cfg = services('console.log("invalid result")');
  cfg.local.other = { ...cfg.local['browser.verify']!, command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'replayed')`] };
  cfg.verify.push({ capability: 'other', input: {} });
  const result = await verifyArtifact(s.repo, [], 1, undefined, undefined, { services: cfg });
  assert.equal(result.serviceStatus, 'unknown'); assert.equal(existsSync(marker), false);
});

for (const status of ['passed', 'unknown'] as const) test(`managed task provider ${status} reaches the correct gate and durable dashboard event`, async () => {
  const cfg = services(status === 'passed' ? asyncCode(pass) : 'console.log("invalid result")');
  const s = sandbox({ services: cfg, review: { mode: 'never' }, worktree: { warmStart: 'off' }, integration: { trainSize: 1, syncBase: false } });
  const db = openDb(join(s.home, 'test.sqlite')), hub = new Hub({ db, token: 'fixture', machineId: 'm-fixture', includeMock: true });
  try {
    const project = await hub.coord.registerProject(s.repo);
    const task = hub.coord.addTasks(project.id, [{ title: 'Implement browser-tested fixture', prompt: '@mock write result.txt correct', agent: 'mock' }], 'test').created[0]!;
    const claim = hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [project.id]: s.repo }, runningByAgent: {} })!;
    const outcome = await runAttempt({ api: hub.client, machineId: 'm-fixture', task: claim.task, project, repoPath: s.repo,
      agent: 'mock', model: null, config: loadConfig(s.repo), startPoint: (await hub.integrator.head(project.id))!, verifySlots: new Semaphore(1), installed: ['mock'] });
    assert.equal(outcome.status, status === 'passed' ? 'ready' : 'needs_human');
    const detail = await hub.client['task.get']({ id: task.id });
    const result = detail.events.find(event => event.kind === 'service.result');
    assert(result); assert.match(result.message, /Receipt on the executing machine/);
    const inventory = await hub.client['providers.list']({ projectId: project.id });
    assert.equal(inventory.verification[0]!.selected, 'local');
    if (status === 'passed') {
      await hub.integrator.step(project.id);
      assert.equal(hub.coord.getTask(task.id)!.status, 'done');
      assert.equal(hub.coord.eventsSince(0, project.id, 100, task.id).filter(event => event.kind === 'service.result').length, 2, 'combined commit gets its own provider acceptance result');
    }
  } finally { await hub.integrator.stop(); db.close(); }
});

test('ym verify resolves project configuration from a subdirectory without starting a hub', () => {
  const s = sandbox(), cfg = services(asyncCode(pass));
  writeFileSync(join(s.repo, 'yardmaster.json'), JSON.stringify({ verify: [], services: cfg }));
  sh(s.repo, 'git', ['add', 'yardmaster.json']); sh(s.repo, 'git', ['commit', '-qm', 'provider acceptance']);
  const nested = join(s.repo, 'src'); mkdirSync(nested);
  const result = spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, 'verify', '--json'], {
    cwd: nested, env: { ...process.env, YARDMASTER_HOME: s.home, YARDMASTER_HUB: '', YARDMASTER_TOKEN: '' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(JSON.parse(result.stdout).receipts.length, 1); assert.equal(existsSync(join(s.home, 'hub.json')), false);
});

test('an unknown combined provider result holds the whole merge train without individual replay', async () => {
  const s = sandbox({ verifyQuick: ['node -e "process.exit(0)"'], review: { mode: 'never' }, worktree: { warmStart: 'off' }, integration: { trainSize: 2, syncBase: false } });
  const counter = join(s.home, 'dispatches');
  const cfg = services(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'dispatch\\n');console.log('invalid result');`);
  writeFileSync(join(s.home, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8')), services: cfg }));
  const db = openDb(join(s.home, 'train.sqlite')), hub = new Hub({ db, token: 'fixture', machineId: 'm-fixture', includeMock: true });
  try {
    const project = await hub.coord.registerProject(s.repo), base = sh(s.repo, 'git', ['rev-parse', 'HEAD']);
    await hub.integrator.head(project.id);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const file = `independent-${i}.txt`;
      const task = hub.coord.addTasks(project.id, [{ title: `Independent fixture ${i}`, prompt: `Implement ${file}`, files: [file], agent: 'mock' }], 'test', { force: true }).created[0]!;
      const claim = hub.coord.claimNext({ machineId: 'm-fixture', agents: ['mock'], repos: { [project.id]: s.repo }, runningByAgent: {} });
      assert.equal(claim?.task.id, task.id);
      const branch = `fixture-${i}`, worktree = join(s.root, `artifact-${i}`);
      sh(s.repo, 'git', ['worktree', 'add', '-qb', branch, worktree, base]);
      writeFileSync(join(worktree, file), 'verified fixture\n');
      sh(worktree, 'git', ['add', file]); sh(worktree, 'git', ['commit', '-qm', 'artifact']);
      hub.coord.updateTask(task.id, { status: 'ready', branch, worktree, base_sha: base, head_sha: sh(worktree, 'git', ['rev-parse', 'HEAD']), ready_at: Date.now() + i });
      ids.push(task.id);
    }
    await hub.integrator.step(project.id);
    assert(ids.every(id => hub.coord.getTask(id)!.status === 'needs_human'));
    assert.equal(readFileSync(counter, 'utf8'), 'dispatch\n');
    await hub.integrator.step(project.id);
    assert.equal(readFileSync(counter, 'utf8'), 'dispatch\n');
    assert.equal(sh(hub.integrator.integrationPath(project, hub.coord.configFor(project.id)), 'git', ['rev-parse', 'HEAD']), base);
  } finally { await hub.integrator.stop(); db.close(); }
});

test('receipt download validation rejects the truncated connector response before writing an archive', () => {
  const s = sandbox(), bytes = Buffer.from('complete receipt archive fixture'), target = join(s.home, 'receipts.tar.gz');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.throws(() => collectReceiptArchive({ result: { data: bytes.toString('base64').slice(0, 8) + '...[truncated]', size: bytes.length } }, digest, target), /truncated/);
  assert.equal(existsSync(target), false);
  assert.throws(() => collectReceiptArchive({ data: bytes.toString('base64'), size: bytes.length + 1 }, digest, target), /byte count/);
  assert.throws(() => collectReceiptArchive({ data: bytes.toString('base64') }, '0'.repeat(64), target), /checksum/);
  assert.equal(collectReceiptArchive({ data: bytes.toString('base64'), size: bytes.length }, digest, target).status, 'verified');
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(collectReceiptArchive(bytes, digest, target).status, 'verified', 'native CLI downloads are raw binary');
});

test('large browser requests use a private input file instead of exceeding the OS environment limit', async () => {
  const s = browserFixture(`const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(process.env.YARDMASTER_VERIFY_INPUT,undefined);assert.equal(JSON.parse(fs.readFileSync(process.env.YARDMASTER_VERIFY_INPUT_FILE,'utf8')).payload.length,150000);console.log('large input assertions passed');`);
  const mock = api();
  const result = await runBrowserbase(s.options, { ...s.ctx, input: { payload: 'x'.repeat(150000) } }, mock.fetcher);
  assert.equal(result.result.status, 'passed'); assert.equal(existsSync(join(s.ctx.evidenceDir, 'input.json')), false);
});

test('unchanged plugin refreshes reuse one module and changed source loads one new version', async () => {
  const s = sandbox(), file = join(s.root, 'cached-provider.mjs'), counter = randomUUID();
  writeFileSync(file, `globalThis[${JSON.stringify(counter)}]=(globalThis[${JSON.stringify(counter)}]??0)+1;export default {kind:'provider',apiVersion:1,name:'cached',capabilities:{verify:{service:'ci',command:['node'],locality:'local',cost:'free'}}};`);
  await loadPluginFile(file); await loadPluginFile(file);
  assert.equal(Reflect.get(globalThis, counter), 1);
  writeFileSync(file, readFileSync(file, 'utf8') + '\n// changed source');
  await loadPluginFile(file); await loadPluginFile(file);
  assert.equal(Reflect.get(globalThis, counter), 2); Reflect.deleteProperty(globalThis, counter);
});

test('a durable pending service survives hub restart and blocks another worker until owner inspection and explicit retry', async () => {
  const s = sandbox(), file = join(s.home, 'restart.sqlite');
  let db = openDb(file), hub = new Hub({ db, token: 'fixture', machineId: 'm-old', includeMock: true });
  const project = await hub.coord.registerProject(s.repo);
  const task = hub.coord.addTasks(project.id, [{ title: 'Recover pending remote browser verification', prompt: 'Implement a small fixture', agent: 'mock' }], 'test').created[0]!;
  const requestId = randomUUID();
  beginService(db, `task:${task.id}`, { requestId, capability: 'browser.verify', provider: 'fixture-remote', receiptPath: '/private/old-worker-receipt.json' },
    { projectId: project.id, taskIds: [task.id], machineId: 'm-old' });
  db.close();
  db = openDb(file); hub = new Hub({ db, token: 'fixture', machineId: 'm-new', includeMock: true });
  try {
    assert.equal((await hub.client['providers.pending']({}))[0]!.requestId, requestId);
    assert.equal(hub.coord.claimNext({ machineId: 'm-new', agents: ['mock'], repos: { [project.id]: s.repo }, runningByAgent: {} }), null);
    assert.equal(hub.coord.getTask(task.id)!.status, 'needs_human');
    assert.throws(() => hub.coord.control(task.id, 'retry', 'test'), /pending provider/);
    await hub.client['providers.resolve']({ requestId, note: 'Inspected old worker and confirmed the remote session was terminated.' });
    assert.equal((await hub.client['providers.pending']({})).length, 0);
    assert.equal(hub.coord.getTask(task.id)!.status, 'needs_human', 'inspection does not dispatch another job');
    hub.coord.control(task.id, 'retry', 'test');
    assert.equal(hub.coord.claimNext({ machineId: 'm-new', agents: ['mock'], repos: { [project.id]: s.repo }, runningByAgent: {} })?.task.id, task.id);
  } finally { await hub.integrator.stop(); db.close(); }
});
