import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sandbox, sh, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { remoteClient, type Client } from '../src/api.ts';
import { WorkerLoop } from '../src/worker.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import { EffortRoutingSchema, loadConfig, resolveConfig } from '../src/config.ts';
import { claudePreTool } from '../src/hook.ts';
import { claude } from '../src/adapters/builtin.ts';
import { registerAdapter } from '../src/adapters/index.ts';

let hub: Hub | null = null;
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await hub?.stop();
});

test('a second machine runs the work and ships it back as a git bundle', async () => {
  const box = sandbox();
  // The hub machine has no usable agent here, so every task must run on the "remote" worker.
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok', machineId: 'm-hub', port: 0, host: '127.0.0.1', includeMock: false, tickMs: 150, quiet: true });
  const url = await hub.start();
  const project = await hub.coord.registerProject(box.repo);

  const clone = join(box.root, 'laptop-clone');
  sh(box.root, 'git', ['clone', '-q', box.repo, clone]);
  sh(clone, 'git', ['config', 'user.name', 'Laptop']);
  sh(clone, 'git', ['config', 'user.email', 'laptop@example.com']);

  const client = remoteClient(url, 'tok');
  const worker = new WorkerLoop({
    client,
    machineId: 'm-laptop',
    name: 'laptop',
    repos: () => ({ [project.id]: clone }),
    agents: () => ['mock'],
    localConfig: () => resolveConfig([loadConfig(), { worktreeRoot: join(box.root, 'laptop-worktrees') }]),
    transport: httpTransport(url, 'tok', 'm-laptop'),
    verifySlots: new Semaphore(1),
  });
  const timer = setInterval(() => void worker.heartbeat().then(() => worker.tick()).catch(() => undefined), 200);
  // Stop the worker whatever happens: a failed assertion must not leave agents running and the test process alive.
  const stop = async () => {
    clearInterval(timer);
    worker.stopAll('shutdown', 'test over');
    await worker.drain();
  };
  try {
    const { created } = hub.coord.addTasks(project.id, [
      { key: 'one', title: 'Add the remote module', prompt: '@mock write remote/one.js export const one = 1', files: ['remote/one.js'], agent: 'mock' },
      { title: 'Build on the remote module', prompt: '@mock write remote/two.js export const two = 2', files: ['remote/two.js'], after: ['one'], agent: 'mock' },
    ], 'test');
    const done = await until(() => created.map((t) => hub!.coord.getTask(t.id)!), (ts) => ts.every((t) => ['done', 'needs_human', 'failed'].includes(t.status)), 90_000, 'remote tasks').catch((err: Error) => {
      // A rare stall on busy CI machines: show what each task last did, so the next failure is diagnosable.
      const trail = created.map((t) => hub!.coord.eventsSince(0, null, 50, t.id).map((e) => `${t.id} ${e.kind}: ${e.message}`).join('\n')).join('\n');
      const runs = created.map((t) => JSON.stringify(hub!.coord.latestRun(t.id) ?? null)).join('\n');
      // Every process this test still has running, with its command line: shows what is stuck (agent, git, ...).
      const tree = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' }).stdout
        .split('\n').filter((l) => l.trim() && (l.includes(box.root) || l.includes(`${process.pid} `))).join('\n');
      throw new Error(`${err.message.slice(0, 300)}\nEvents:\n${trail}\nRuns:\n${runs}\nWorker: ${JSON.stringify([...worker.active.keys()])}\nProcesses:\n${tree}`);
    });
    assert.deepEqual(done.map((t) => t.status), ['done', 'done'], JSON.stringify(done.map((t) => t.attention)));
    for (const t of done) assert.equal(hub.coord.latestRun(t.id)!.machine_id, 'm-laptop');
    assert.equal(sh(box.repo, 'git', ['show', 'yardmaster/integration:remote/two.js']), 'export const two = 2');
    // The second task needed the first task's merge commit, which only existed on the hub.
    const fetched = sh(clone, 'git', ['for-each-ref', '--format=%(refname)', 'refs/yardmaster/hub/']);
    assert.match(fetched, /refs\/yardmaster\/hub\/yardmaster\/integration/);
    assert.equal(sh(clone, 'git', ['branch', '--show-current']), 'main', "the laptop's checkout was not switched");
    const machines = hub.coord.listMachines().map((m) => m.id).sort();
    assert.deepEqual(machines, ['m-hub', 'm-laptop']);
  } finally {
    await stop();
  }
});

test('an agent that exits while the hub is slow to answer is still seen as finished', async () => {
  const box = sandbox();
  await hub?.stop();
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok3', machineId: 'm-hub3', port: 0, host: '127.0.0.1', includeMock: false, tickMs: 150, quiet: true });
  const url = await hub.start();
  const project = await hub.coord.registerProject(box.repo);
  const clone = join(box.root, 'slow-clone');
  sh(box.root, 'git', ['clone', '-q', box.repo, clone]);
  const real = remoteClient(url, 'tok3');
  // Every "run started" update takes 0.8 s, so the mock agent always exits before the runner hears back.
  const slow = new Proxy(real, {
    get: (t, name: string) => name === 'run.update'
      ? async (p: unknown) => { await new Promise((r) => setTimeout(r, 800)); return (t as unknown as Record<string, (p: unknown) => unknown>)[name]!(p); }
      : (t as unknown as Record<string, unknown>)[name],
  });
  const worker = new WorkerLoop({
    client: slow, machineId: 'm-slow', name: 'slow', repos: () => ({ [project.id]: clone }), agents: () => ['mock'],
    localConfig: () => resolveConfig([loadConfig(), { worktreeRoot: join(box.root, 'slow-worktrees') }]),
    transport: httpTransport(url, 'tok3', 'm-slow'), verifySlots: new Semaphore(1),
  });
  const timer = setInterval(() => void worker.heartbeat().then(() => worker.tick()).catch(() => undefined), 200);
  try {
    const { created } = hub.coord.addTasks(project.id, [{ title: 'Quick change', prompt: '@mock write quick.js export const q = 1', files: ['quick.js'], agent: 'mock' }], 'test');
    const [t] = await until(() => created.map((c) => hub!.coord.getTask(c.id)!), (ts) => ts.every((x) => ['done', 'needs_human', 'failed'].includes(x.status)), 30_000, 'quick task');
    assert.equal(t!.status, 'done', t!.attention ?? '');
  } finally {
    clearInterval(timer);
    worker.stopAll('shutdown', 'test over');
    await worker.drain();
  }
});

test('remote workers use only their own JEV command and bindings, including disabled defaults', async () => {
  await hub?.stop();
  hub = null;
  for (const enabled of [true, false]) {
    const box = sandbox({
      agents: { claude: { enabled: true, models: { standard: 'worker-test-model' } } },
      review: { mode: 'never' }, worktree: { warmStart: 'off' },
    });
    const hubMarker = join(box.root, 'hub-router-ran');
    const workerCapture = join(box.root, 'worker-request.json');
    const agentCapture = join(box.root, 'agent-launch.json');
    const hubRouter = join(box.root, 'hub-router.mjs');
    const workerRouter = join(box.root, 'worker-router.mjs');
    const fakeAgent = join(box.root, 'fake-agent.mjs');
    writeFileSync(hubRouter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(hubMarker)}, 'wrong machine');`);
    writeFileSync(workerRouter, `import { writeFileSync } from 'node:fs';
let input=''; for await (const c of process.stdin) input += c;
const q=JSON.parse(input); writeFileSync(${JSON.stringify(workerCapture)}, JSON.stringify(q));
console.log(JSON.stringify({v:1,requestId:q.requestId,sessionId:q.sessionId,providerInstanceId:q.providerInstanceId,model:q.model,
status:'apply',reason:'difficulty_lower',level:'low',patch:{optionId:q.capability.optionId,value:'low'},judge:null}));
`);
    writeFileSync(fakeAgent, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(agentCapture)}, process.argv[2]);
writeFileSync('remote-result.txt', 'remote verified');
console.log(JSON.stringify({type:'result',subtype:'success',result:'done',usage:{},total_cost_usd:0}));
`);
    const binding = { agent: 'claude', model: 'worker-test-model', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' };
    const baseConfig = JSON.parse(readFileSync(join(box.home, 'config.json'), 'utf8'));
    writeFileSync(join(box.home, 'config.json'), JSON.stringify({ ...baseConfig,
      effortRouting: { enabled: true, mode: 'active', command: [process.execPath, hubRouter], bindings: [{ ...binding, model: 'hub-only-model' }] },
    }));
    const testHub = new Hub({ db: openDb(join(box.home, 'worker-config.db')), token: 'tok', machineId: 'm-hub', quiet: true });
    const project = await testHub.coord.registerProject(box.repo);
    const clone = join(box.root, 'worker-clone');
    sh(box.root, 'git', ['clone', '-q', box.repo, clone]);
    const local = resolveConfig([loadConfig(), {
      worktreeRoot: join(box.root, 'worker-worktrees'),
      effortRouting: enabled
        ? EffortRoutingSchema.parse({ enabled: true, mode: 'active', command: [process.execPath, workerRouter], bindings: [binding] })
        : EffortRoutingSchema.parse({}),
    }]);
    registerAdapter({ ...claude, build(ctx) {
      const spec = claude.build(ctx);
      return { ...spec, command: process.execPath, args: [fakeAgent, JSON.stringify(spec)] };
    } });
    const worker = new WorkerLoop({
      client: testHub.client, machineId: 'm-worker', repos: () => ({ [project.id]: clone }), agents: () => ['claude'],
      localConfig: () => local, verifySlots: new Semaphore(1),
    });
    try {
      const task = testHub.coord.addTasks(project.id, [{ title: 'Fix remote spelling', prompt: 'Correct a spelling error.', files: ['remote-result.txt'], agent: 'claude', tier: 'standard' }], 'test').created[0]!;
      await worker.tick();
      const done = await until(() => testHub.coord.getTask(task.id)!, (t) => ['ready', 'needs_human', 'failed'].includes(t.status), 30000, 'remote JEV task');
      assert.equal(done.status, 'ready', done.attention ?? '');
      assert.equal(existsSync(hubMarker), false, 'hub executable never runs on the worker');
      assert.equal(existsSync(workerCapture), enabled, 'a worker with default disabled JEV never inherits the hub binding');
      const launch = JSON.parse(readFileSync(agentCapture, 'utf8'));
      assert.equal(launch.args[launch.args.indexOf('--effort') + 1], enabled ? 'low' : 'medium');
      if (enabled) {
        const request = JSON.parse(readFileSync(workerCapture, 'utf8'));
        assert.equal(request.projectDir, clone, 'JEV checks scope against the worker-local checkout');
        assert.equal(request.model, 'worker-test-model');
      }
      assert.equal(testHub.coord.latestRun(task.id)!.machine_id, 'm-worker');
      assert.equal(sh(done.worktree!, 'git', ['show', 'HEAD:remote-result.txt']), 'remote verified');
    } finally {
      worker.stopAll('shutdown', 'test over');
      await worker.drain();
      registerAdapter(claude);
      testHub.coord.db.close();
    }
  }
});

test('shutdown during remote base fetch prevents JEV and coding-agent launch afterward', async () => {
  await hub?.stop();
  hub = null;
  const box = sandbox({ review: { mode: 'never' }, worktree: { warmStart: 'off' } });
  const testHub = new Hub({ db: openDb(join(box.home, 'fetch-stop.db')), token: 'tok', machineId: 'm-hub', quiet: true });
  const project = await testHub.coord.registerProject(box.repo);
  const clone = join(box.root, 'fetch-clone');
  sh(box.root, 'git', ['clone', '-q', box.repo, clone]);
  // Create a new hub commit after cloning, forcing the worker through fetchBase.
  writeFileSync(join(box.repo, 'later.txt'), 'new base');
  sh(box.repo, 'git', ['add', 'later.txt']);
  sh(box.repo, 'git', ['commit', '-q', '-m', 'new base']);
  const agentMarker = join(box.root, 'agent-started');
  const routerMarker = join(box.root, 'router-started');
  const agentScript = join(box.root, 'never-agent.mjs');
  const routerScript = join(box.root, 'never-router.mjs');
  writeFileSync(agentScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(agentMarker)}, 'unexpected');`);
  writeFileSync(routerScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(routerMarker)}, 'unexpected');`);
  // Force a Claude route without requiring any installed provider binary or live inference.
  registerAdapter({ ...claude, build(ctx) { const spec = claude.build(ctx); return { ...spec, command: process.execPath, args: [agentScript] }; } });
  const local = resolveConfig([loadConfig(), {
    agents: { claude: { enabled: true, models: { standard: 'fetch-test-model' } } },
    worktreeRoot: join(box.root, 'fetch-worktrees'),
    effortRouting: { enabled: true, mode: 'active', command: [process.execPath, routerScript],
      bindings: [{ agent: 'claude', model: 'fetch-test-model', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' }] },
  }]);
  // The claim uses the hub's configured agents, while execution uses this worker's installation.
  const config = JSON.parse(readFileSync(join(box.home, 'config.json'), 'utf8'));
  writeFileSync(join(box.home, 'config.json'), JSON.stringify({ ...config, agents: { claude: { enabled: true, models: { standard: 'fetch-test-model' } } } }));
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchStarted = false;
  let uploads = 0;
  const worker = new WorkerLoop({
    client: testHub.client, machineId: 'm-fetch', repos: () => ({ [project.id]: clone }), agents: () => ['claude'],
    localConfig: () => local, verifySlots: new Semaphore(1),
    transport: {
      async fetchBase() {
        fetchStarted = true;
        await fetchGate;
        sh(clone, 'git', ['fetch', '-q', 'origin', 'main']);
      },
      async uploadBranch() { uploads++; },
    },
  });
  try {
    const task = testHub.coord.addTasks(project.id, [{ title: 'Fix a remote typo', prompt: 'Correct a typo.', files: ['answer.txt'], agent: 'claude', tier: 'standard' }], 'test').created[0]!;
    await worker.tick();
    await until(() => fetchStarted, Boolean, 10000, 'base fetch gate');
    worker.stopAll('shutdown', 'stop during fetch');
    releaseFetch();
    await until(() => worker.active.size, (n) => n === 0, 15000, 'worker drain after fetch stop');
    const current = testHub.coord.getTask(task.id)!;
    assert.equal(current.status, 'queued', current.attention ?? '');
    assert.equal(current.attempts, 0, 'shutdown does not consume a coding attempt');
    assert.equal(existsSync(routerMarker), false);
    assert.equal(existsSync(agentMarker), false);
    assert.equal(uploads, 0);
  } finally {
    releaseFetch();
    worker.stopAll('shutdown', 'test over');
    await worker.drain();
    registerAdapter(claude);
    testHub.coord.db.close();
  }
});

test('shutdown while a remote claim is in flight returns the claim without launching work', async () => {
  await hub?.stop();
  hub = null;
  const box = sandbox({ agents: { claude: { enabled: true, models: { standard: 'claim-test-model' } } }, review: { mode: 'never' }, worktree: { warmStart: 'off' } });
  const testHub = new Hub({ db: openDb(join(box.home, 'claim-stop.db')), token: 'tok', machineId: 'm-hub', quiet: true });
  const project = await testHub.coord.registerProject(box.repo);
  const routerMarker = join(box.root, 'claim-router-started');
  const agentMarker = join(box.root, 'claim-agent-started');
  const routerScript = join(box.root, 'claim-router.mjs');
  const agentScript = join(box.root, 'claim-agent.mjs');
  writeFileSync(routerScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(routerMarker)}, 'unexpected');`);
  writeFileSync(agentScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(agentMarker)}, 'unexpected');`);
  registerAdapter({ ...claude, build(ctx) { const spec = claude.build(ctx); return { ...spec, command: process.execPath, args: [agentScript] }; } });
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let claimReady = false;
  const client = new Proxy(testHub.client, {
    get(target, key: keyof Client) {
      if (key !== 'worker.claim') return target[key];
      return async (p: Parameters<Client['worker.claim']>[0]) => {
        const claim = await target['worker.claim'](p);
        claimReady = true;
        await claimGate;
        return claim;
      };
    },
  });
  let transportCalls = 0;
  const worker = new WorkerLoop({
    client, machineId: 'm-claim', repos: () => ({ [project.id]: box.repo }), agents: () => ['claude'], verifySlots: new Semaphore(1),
    localConfig: () => resolveConfig([loadConfig(), {
      effortRouting: { enabled: true, mode: 'active', command: [process.execPath, routerScript],
        bindings: [{ agent: 'claude', model: 'claim-test-model', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' }] },
    }]),
    transport: {
      async fetchBase() { transportCalls++; },
      async uploadBranch() { transportCalls++; },
    },
  });
  try {
    const task = testHub.coord.addTasks(project.id, [{ title: 'Fix claim spelling', prompt: 'Correct spelling.', files: ['answer.txt'], agent: 'claude', tier: 'standard' }], 'test').created[0]!;
    const ticking = worker.tick();
    await until(() => claimReady, Boolean, 10000, 'claim response gate');
    assert.equal(testHub.coord.getTask(task.id)!.status, 'running', 'the hub has already reserved this task');
    worker.stopAll('shutdown', 'stop while claiming');
    releaseClaim();
    await ticking;
    assert.equal(worker.active.size, 0);
    const current = testHub.coord.getTask(task.id)!;
    assert.equal(current.status, 'queued', current.attention ?? '');
    assert.equal(current.attempts, 0);
    assert.equal(current.assignee, null);
    assert.equal(current.lease_until, null);
    assert.equal(testHub.coord.latestRun(task.id), null);
    assert.equal(existsSync(routerMarker), false);
    assert.equal(existsSync(agentMarker), false);
    assert.equal(transportCalls, 0);
  } finally {
    releaseClaim();
    worker.stopAll('shutdown', 'test over');
    await worker.drain();
    registerAdapter(claude);
    testHub.coord.db.close();
  }
});

test('the MCP server lets an interactive agent queue, wait for, and coordinate work', async () => {
  const box = sandbox();
  await hub?.stop();
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok2', machineId: 'm-hub2', port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  const url = await hub.start();
  const project = await hub.coord.registerProject(box.repo);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'mcp'],
    cwd: box.repo,
    env: { ...(process.env as Record<string, string>), YARDMASTER_HUB: url, YARDMASTER_TOKEN: 'tok2', YARDMASTER_SESSION: 'claude-test' },
    stderr: 'pipe',
  });
  const mcp = new McpClient({ name: 'test-client', version: '1.0.0' });
  await mcp.connect(transport);
  cleanups.push(() => mcp.close());

  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['yard_add_tasks', 'yard_claim_files', 'yard_control', 'yard_finish_task', 'yard_inbox', 'yard_learn', 'yard_release_files', 'yard_send', 'yard_status', 'yard_take_task', 'yard_task', 'yard_wait', 'yard_who']);
  const textOf = (r: Awaited<ReturnType<typeof mcp.callTool>>) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

  // The interactive session reserves a file first; background work on that file must wait for it.
  const claimed = textOf(await mcp.callTool({ name: 'yard_claim_files', arguments: { patterns: ['docs/guide.md'], reason: 'editing by hand' } }));
  assert.match(claimed, /Reserved docs\/guide.md/);

  const added = textOf(await mcp.callTool({
    name: 'yard_add_tasks',
    arguments: { tasks: [
      { key: 'api', title: 'Write the API client', prompt: '@mock write api/client.js export const get = () => 1', files: ['api/**'], agent: 'mock' },
      { title: 'Document the API client', prompt: '@mock write docs/guide.md how to use the client', files: ['docs/guide.md'], after: ['api'], agent: 'mock' },
    ] },
  }));
  const ids = [...added.matchAll(/\+ (t-[a-z0-9]+)/g)].map((m) => m[1]!);
  assert.equal(ids.length, 2, added);

  const firstDone = textOf(await mcp.callTool({ name: 'yard_wait', arguments: { ids: [ids[0]], timeoutSec: 30 } }));
  assert.match(firstDone, /\[Done\]/);
  const status = textOf(await mcp.callTool({ name: 'yard_status', arguments: {} }));
  assert.match(status, /claude-test has reserved docs\/guide.md/, status);

  // A Claude Code edit hook from another folder sees the reservation and blocks the edit.
  const blocked = await claudePreTool(JSON.stringify({ cwd: join(box.root), tool_name: 'Edit', tool_input: { file_path: join(box.repo, 'docs/guide.md') } }), async () => remoteClient(url, 'tok2'));
  assert.equal(blocked.code, 0, 'outside the repo the hook stays out of the way');
  mkdirSync(join(box.repo, 'packages'), { recursive: true });
  const otherSession = await claudePreTool(JSON.stringify({ cwd: join(box.repo, 'packages'), tool_name: 'Write', tool_input: { file_path: join(box.repo, 'docs/guide.md') } }), async () => remoteClient(url, 'tok2'));
  assert.equal(otherSession.code, 2);
  assert.match(otherSession.message!, /claude-test/);

  textOf(await mcp.callTool({ name: 'yard_release_files', arguments: {} }));
  const both = textOf(await mcp.callTool({ name: 'yard_wait', arguments: { ids, timeoutSec: 30 } }));
  assert.equal((both.match(/\[Done\]/g) ?? []).length, 2, both);

  const sent = textOf(await mcp.callTool({ name: 'yard_send', arguments: { to: '*', body: 'API client uses GET only for now' } }));
  assert.equal(sent, 'Sent.');
  assert.equal(hub.coord.inbox(project.id, 'session:someone-else').length, 1);
});
