import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeEffort } from '../src/jev.ts';
import { defaultAgentSettings, EffortRoutingSchema, loadConfig, resolveConfig } from '../src/config.ts';
import { claude, codex } from '../src/adapters/builtin.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { isAlive } from '../src/proc.ts';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { runAttempt, Semaphore, type RunContext, type StopReason } from '../src/runner.ts';
import type { Client } from '../src/api.ts';

const task = { id: 't-fixture', title: 'Fix a typo', prompt: 'Correct spelling in README.', attempts: 1,
  agent_session: null, retry_note: null, review_rounds: 0, conflict_rounds: 0 };

function fixture(mode = 'apply', extra: Record<string, unknown> = {}) {
  const root = tempDir('ym-jev-');
  const script = join(root, 'router.mjs');
  const capture = join(root, 'request.json');
  const ready = join(root, 'ready');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = ${JSON.stringify(mode)};
let input = ''; for await (const c of process.stdin) input += c;
const q = JSON.parse(input);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ q, env: { token: process.env.YARDMASTER_TOKEN, hub: process.env.YARDMASTER_HUB, git: process.env.GIT_DIR } }));
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'descendant') { spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' }); }
else if (mode === 'flood') process.stdout.write('x'.repeat(70000));
else if (mode === 'stderr') { process.stderr.write('PRIVATE-PROMPT'); process.exitCode = 1; }
else if (mode === 'malformed') process.stdout.write('PRIVATE-PROMPT');
else {
  let r = { v:1, requestId:q.requestId, sessionId:q.sessionId, providerInstanceId:q.providerInstanceId, model:q.model,
    status:'apply', reason:'difficulty_lower', level:'low', patch:{optionId:q.capability.optionId,value:'low'}, judge:{status:'ok',latencyMs:1,attempts:1} };
  if (mode === 'shadow') r.status = 'shadow';
  if (mode === 'hold') r = {...r,status:'hold',reason:'disabled',level:null,patch:null};
  if (mode === 'identity') r.requestId = 'stale';
  if (mode === 'model') r.model = 'other';
  if (mode === 'option') r.patch.optionId = 'permissions';
  if (mode === 'value') r.patch.value = 'ultra';
  if (mode === 'raise') { r.level = 'high'; r.patch.value = 'high'; }
  if (mode === 'extra') r.permissions = 'bypass';
  if (mode === 'hold-patch') r.status = 'hold';
  if (mode === 'secret-reason') r = {...r,status:'hold',reason:'PRIVATE-PROMPT',level:null,patch:null};
  console.log(JSON.stringify(r));
}
`);
  const config = EffortRoutingSchema.parse({ enabled: true, mode: 'active', command: [process.execPath, script], timeoutMs: 1500,
    bindings: [{ agent: 'claude', model: 'test-model', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' }], ...extra });
  const opts = { config, agent: 'claude', model: 'test-model', settings: defaultAgentSettings(), tier: 'standard' as const, task, repoPath: root };
  return { root, capture, ready, opts };
}

test('JEV is optional; configuration validates command, timeout and capabilities', async () => {
  assert.equal(resolveConfig([]).effortRouting.enabled, false);
  assert.equal(EffortRoutingSchema.parse({ enabled: true }).mode, 'shadow');
  for (const bad of [{ command: [] }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { bindings: [{ agent: 'claude', model: 'x', efforts: ['ultra'] }] }])
    assert.equal(EffortRoutingSchema.safeParse(bad).success, false);
  const f = fixture();
  assert.equal((await routeEffort({ ...f.opts, config: EffortRoutingSchema.parse({}) })).status, 'disabled');
  assert.equal(existsSync(f.capture), false);
});

test('JEV receives original task, actual baseline and local repo; only effort reaches adapter', async () => {
  const f = fixture();
  const previous = { token: process.env.YARDMASTER_TOKEN, hub: process.env.YARDMASTER_HUB, git: process.env.GIT_DIR };
  Object.assign(process.env, { YARDMASTER_TOKEN: 'private-token', YARDMASTER_HUB: 'private-hub', GIT_DIR: '/wrong/git' });
  try {
    const r = await routeEffort(f.opts);
    assert.equal(r.effort, 'low');
    const { q, env } = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.deepEqual(env, {}, 'hub credentials and git redirects never reach JEV');
    assert.equal(q.prompt, `${task.title}\n\n${task.prompt}`);
    assert.equal(q.projectDir, f.root);
    assert.equal(q.baseline, 'medium');
    assert.equal(q.previousLevel, 'medium', 'actual JEV limits downshifts from previousLevel; null would start at xhigh and prevent medium -> low');
    assert.equal(q.manualSelection, false);
    const context = { prompt: 'FULL ORIGINAL BRIEF', cwd: '/work', model: 'test-model', settings: f.opts.settings, tier: f.opts.tier, budgetUsd: 1, session: { pin: 'same-session' } };
    const before = claude.build(context);
    const after = claude.build({ ...context, settings: { ...context.settings, effort: { standard: r.effort! } } });
    const normalized = after.args.map((x, i, all) => all[i - 1] === '--effort' ? 'medium' : x);
    assert.deepEqual(normalized, before.args, 'model, permissions, tools, session and budget unchanged');
    assert.equal(after.stdin, before.stdin);
  } finally {
    for (const [key, value] of Object.entries({ YARDMASTER_TOKEN: previous.token, YARDMASTER_HUB: previous.hub, GIT_DIR: previous.git })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('shadow and disabled JEV preserve default effort', async () => {
  for (const [mode, config, status] of [['apply', { mode: 'shadow' }, 'shadow'], ['shadow', {}, 'shadow'], ['hold', {}, 'hold']] as const) {
    const f = fixture(mode, config);
    const r = await routeEffort(f.opts);
    assert.equal(r.status, status);
    assert.equal(r.effort, undefined);
  }
});

test('explicit settings, unsupported models, recovery and unverified caches never invoke JEV', async () => {
  const f = fixture();
  const variants = [
    { agent: 'opencode' }, { model: null }, { model: 'not-bound' },
    { settings: defaultAgentSettings({ effort: { standard: '' } }) },
    { settings: defaultAgentSettings({ effort: { standard: 'high' } }) },
    { settings: defaultAgentSettings({ extraArgs: ['-c', 'model_reasoning_effort="high"'] }) },
    { settings: defaultAgentSettings({ command: 'custom-claude' }) },
    ...[{ attempts: 2 }, { agent_session: 'resume-me' }, { retry_note: 'try again' }, { review_rounds: 1 }, { conflict_rounds: 1 }].map((over) => ({ task: { ...task, ...over } })),
    { config: { ...f.opts.config, bindings: [{ ...f.opts.config.bindings[0]!, cacheImpact: 'unknown' as const }] } },
    { config: { ...f.opts.config, bindings: [{ ...f.opts.config.bindings[0]!, cacheImpact: 'may-reset' as const }] } },
  ];
  for (const over of variants) {
    assert.equal((await routeEffort({ ...f.opts, ...over })).effort, undefined);
    assert.equal(existsSync(f.capture), false, JSON.stringify(over));
  }
  const recovery = await routeEffort({ ...f.opts, task: { ...task, attempts: 2 } });
  assert.equal(recovery.managed, true, 'a native Claude hook cannot undo recovery effort');
});

test('invalid, stale, out-of-capability and above-ceiling decisions fall back without exposing output', async () => {
  for (const mode of ['malformed', 'identity', 'model', 'option', 'value', 'raise', 'extra', 'hold-patch', 'stderr', 'secret-reason']) {
    const f = fixture(mode);
    const r = await routeEffort(f.opts);
    assert.equal(r.effort, undefined, mode);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
    assert.equal(r.status, mode === 'secret-reason' ? 'hold' : 'fallback', mode);
  }
  const missing = fixture();
  const r = await routeEffort({ ...missing.opts, config: { ...missing.opts.config, command: [join(missing.root, 'not-installed')] } });
  assert.equal(r.reason, 'command_failed');
});

test('Codex gets its own effort binding and flag, without changing the selected model', async () => {
  const f = fixture();
  const config = { ...f.opts.config, bindings: [{ ...f.opts.config.bindings[0]!, agent: 'codex' as const }] };
  const r = await routeEffort({ ...f.opts, config, agent: 'codex' });
  assert.equal(r.effort, 'low');
  assert.equal(JSON.parse(readFileSync(f.capture, 'utf8')).q.capability.optionId, 'model_reasoning_effort');
  const spec = codex.build({ prompt: 'p', cwd: '/work', model: 'test-model', tier: 'standard', settings: defaultAgentSettings({ effort: { standard: r.effort! } }) });
  assert.ok(spec.args.includes('model_reasoning_effort="low"'));
  assert.equal(spec.args[spec.args.indexOf('-m') + 1], 'test-model');
});

test('router timeout, output flood and cancellation are bounded and kill the owned process', async () => {
  for (const [mode, reason] of [['hang', 'timeout'], ['descendant', 'timeout'], ['flood', 'output_limit']] as const) {
    const f = fixture(mode, { timeoutMs: 400 });
    const started = Date.now();
    const r = await routeEffort(f.opts);
    assert.equal(r.reason, reason);
    assert.ok(Date.now() - started < 2500);
    if (existsSync(f.ready)) await until(() => isAlive(Number(readFileSync(f.ready, 'utf8'))), (alive) => !alive, 3000, 'router exit');
  }
  const f = fixture('hang', { timeoutMs: 10000 });
  const abort = new AbortController();
  const pending = routeEffort({ ...f.opts, signal: abort.signal });
  await until(() => existsSync(f.ready), Boolean);
  abort.abort();
  assert.equal((await pending).reason, 'canceled');
  await until(() => isAlive(Number(readFileSync(f.ready, 'utf8'))), (alive) => !alive, 3000, 'canceled router exit');
});

async function runnerFixture(mode = 'apply') {
  const f = fixture(mode);
  const box = sandbox({ effortRouting: f.opts.config, agents: { claude: { enabled: true, models: { standard: 'test-model' } } }, review: { mode: 'never' }, worktree: { warmStart: 'off' } });
  const hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok', machineId: 'm-test', quiet: true });
  const project = await hub.coord.registerProject(box.repo);
  const t = hub.coord.addTasks(project.id, [{ title: task.title, prompt: task.prompt, agent: 'claude', tier: 'standard', files: ['answer.txt'] }], 'test').created[0]!;
  const claim = await hub.client['worker.claim']({ machineId: 'm-test', agents: ['claude'], repos: { [project.id]: box.repo }, runningByAgent: {} });
  assert.equal(claim?.task.id, t.id);
  const capture = join(box.root, 'agent.json');
  const agent = join(box.root, 'agent.mjs');
  writeFileSync(agent, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ spec: JSON.parse(process.argv[2]), managed: process.env.JEV_ROUTER_HOST_ROUTING }));
writeFileSync('answer.txt', 'works');
console.log(JSON.stringify({type:'result',subtype:'success',result:'done',usage:{},total_cost_usd:0}));
`);
  registerAdapter({ ...claude, build(ctx) { const spec = claude.build(ctx); return { ...spec, command: process.execPath, args: [agent, JSON.stringify(spec)] }; } });
  const ctx: RunContext = { api: hub.client, machineId: 'm-test', task: claim!.task, project, repoPath: box.repo, agent: 'claude', model: 'test-model',
    config: loadConfig(box.repo), startPoint: claim!.startPoint!, verifySlots: new Semaphore(1), installed: [] };
  return { ...f, ...box, hub, ctx, agentCapture: capture };
}

test('runner applies JEV once, preserves the coding brief, verifies and commits the result', async () => {
  const s = await runnerFixture();
  try {
    assert.equal((await runAttempt(s.ctx)).status, 'ready');
    const { spec, managed } = JSON.parse(readFileSync(s.agentCapture, 'utf8'));
    assert.equal(spec.args[spec.args.indexOf('--effort') + 1], 'low');
    assert.equal(managed, '1');
    assert.match(spec.stdin, /## Rules/);
    assert.match(spec.stdin, /Correct spelling/);
    const q = JSON.parse(readFileSync(s.capture, 'utf8')).q;
    assert.equal(q.projectDir, s.repo);
    assert.doesNotMatch(q.prompt, /## Rules/);
    const latest = s.hub.coord.latestRun(s.ctx.task.id)!;
    assert.equal(latest.status, 'succeeded');
    assert.match((await s.hub.client['task.logs']({ id: s.ctx.task.id })), /JEV effort: apply/);
    assert.equal(sh(s.hub.coord.getTask(s.ctx.task.id)!.worktree!, 'git', ['show', 'HEAD:answer.txt']), 'works');
  } finally { registerAdapter(claude); s.hub.coord.db.close(); }
});

test('cancellation or ownership loss during routing and run.start never launches an agent', async () => {
  for (const boundary of ['routing', 'run.start'] as const) {
    for (const action of ['cancel', 'reclaim'] as const) {
      const s = await runnerFixture(boundary === 'routing' ? 'hang' : 'apply');
      try {
        if (boundary === 'run.start') {
          s.ctx.api = new Proxy(s.hub.client, { get(target, key: keyof Client) {
            if (key !== 'run.start') return target[key];
            return async (p: Parameters<Client['run.start']>[0]) => {
              const id = await target['run.start'](p);
              if (action === 'cancel') s.hub.coord.control(s.ctx.task.id, 'cancel', 'test');
              else s.hub.coord.updateTask(s.ctx.task.id, { attempts: 2, assignee: 'machine:other' });
              return id;
            };
          } }) as Client;
        }
        const pending = runAttempt(s.ctx);
        if (boundary === 'routing') {
          await until(() => existsSync(s.ready), Boolean);
          if (action === 'cancel') s.hub.coord.control(s.ctx.task.id, 'cancel', 'test');
          else s.hub.coord.updateTask(s.ctx.task.id, { attempts: 2, assignee: 'machine:other' });
        }
        assert.equal((await pending).status, action === 'cancel' ? 'canceled' : 'superseded');
        assert.equal(existsSync(s.agentCapture), false);
      } finally { registerAdapter(claude); s.hub.coord.db.close(); }
    }
  }
});

test('shutdown during JEV wait aborts routing and returns the claimed task to the queue', async () => {
  const s = await runnerFixture('hang');
  let stop: ((reason: StopReason, message: string) => void) | undefined;
  s.ctx.onSpawn = (fn) => { stop = fn; };
  try {
    const pending = runAttempt(s.ctx);
    await until(() => existsSync(s.ready), Boolean);
    stop!('shutdown', 'test shutdown');
    assert.equal((await pending).status, 'queued');
    assert.equal(existsSync(s.agentCapture), false);
    assert.equal(s.hub.coord.getTask(s.ctx.task.id)!.attempts, 0);
  } finally { registerAdapter(claude); s.hub.coord.db.close(); }
});

test('a retry skips JEV and keeps baseline effort with native routing suppressed', async () => {
  const s = await runnerFixture();
  try {
    const retried = s.hub.coord.updateTask(s.ctx.task.id, { attempts: 2, retry_note: 'Earlier check failed; repair the change.' });
    s.ctx.task = retried;
    assert.equal((await runAttempt(s.ctx)).status, 'ready');
    assert.equal(existsSync(s.capture), false, 'no new judge call on recovery');
    const { spec, managed } = JSON.parse(readFileSync(s.agentCapture, 'utf8'));
    assert.equal(spec.args[spec.args.indexOf('--effort') + 1], 'medium');
    assert.equal(managed, '1', 'native plugin cannot downshift the recovery prompt');
  } finally { registerAdapter(claude); s.hub.coord.db.close(); }
});

test('shutdown during startup bookkeeping is replayed to the spawned agent', async () => {
  const s = await runnerFixture();
  let stop: ((reason: StopReason, message: string) => void) | undefined;
  s.ctx.onSpawn = (fn) => { stop = fn; };
  const agent = join(s.root, 'slow-agent.mjs');
  writeFileSync(agent, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(s.agentCapture)}, String(process.pid)); setInterval(()=>{},1000);`);
  registerAdapter({ ...claude, build(ctx) { const spec = claude.build(ctx); return { ...spec, command: process.execPath, args: [agent] }; } });
  s.ctx.api = new Proxy(s.hub.client, { get(target, key: keyof Client) {
    if (key !== 'run.update') return target[key];
    return async (p: Parameters<Client['run.update']>[0]) => {
      if (p.patch.pid) {
        await until(() => existsSync(s.agentCapture), Boolean);
        stop!('shutdown', 'shutdown while recording pid');
      }
      return target['run.update'](p);
    };
  } }) as Client;
  try {
    assert.equal((await runAttempt(s.ctx)).status, 'queued');
    const pid = Number(readFileSync(s.agentCapture, 'utf8'));
    await until(() => isAlive(pid), (alive) => !alive, 3000, 'agent stopped');
  } finally { registerAdapter(claude); s.hub.coord.db.close(); }
});
