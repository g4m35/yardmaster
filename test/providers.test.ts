import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProviderPluginSchema, ProviderOperationSchema, ServicesConfigSchema } from '../src/provider-contract.ts';
import { planService, providerInventory, runService } from '../src/providers.ts';
import { loadPlugins, scaffoldPlugin, testPlugin } from '../src/plugins.ts';
import { resolveConfig, unknownSettings } from '../src/config.ts';

const root = mkdtempSync(join(tmpdir(), 'ym-providers-'));
const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 });
const previousHome = process.env.YARDMASTER_HOME;
process.env.YARDMASTER_HOME = home;
after(() => { if (previousHome === undefined) delete process.env.YARDMASTER_HOME; else process.env.YARDMASTER_HOME = previousHome; rmSync(root, { recursive: true, force: true }); });
const env = { PATH: process.env.PATH, HOME: home };
const fixture = join(root, 'provider with spaces.mjs');
const marker = join(root, 'fallback-dispatched');
writeFileSync(fixture, `
import { writeFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
if (request.input.mode === 'invalid') { console.log('not json'); process.exit(0); }
if (request.input.mode === 'hang') { setInterval(() => {}, 1000); }
else if (request.input.mode === 'exit') process.exit(7);
else { console.log(JSON.stringify({ status:'passed', summary:'Verified 🚲 ' + (process.env.SERVICE_SECRET ?? ''), data:{request, secret: process.env.SERVICE_SECRET, unrelated:process.env.UNRELATED_SECRET, owner:process.env.YARDMASTER_TOKEN}, artifacts:[], costUsd:null })); }
`);
const op = ProviderOperationSchema.parse({ service: 'ci', command: [process.execPath, fixture], locality: 'remote', cost: 'included', requiredEnv: ['SERVICE_SECRET'] });
const plugin = ProviderPluginSchema.parse({ kind: 'provider', apiVersion: 1, name: 'existing-ci', capabilities: { verify: op } });
const local = ProviderOperationSchema.parse({ service: 'ci', command: [process.execPath, '-e', 'console.log("local check")'], protocol: 'command', locality: 'local', cost: 'free' });

test('service config is backward compatible and rejects unsupported contracts', () => {
  assert.deepEqual(resolveConfig([{}]).services, { providers: {}, routes: {}, local: {} });
  assert.deepEqual(unknownSettings({ services: { providers: { 'existing-ci': { enabled: true, options: { project: 'test' } } }, routes: { verify: { prefer: ['existing-ci'] } }, local: { verify: local } } }), []);
  assert.throws(() => ProviderOperationSchema.parse({ ...op, protocol: 'command' }), /exit-code protocol/);
  assert.throws(() => ProviderPluginSchema.parse({ ...plugin, name: 'local' }), /reserved/);
  assert.throws(() => ProviderPluginSchema.parse({ ...plugin, apiVersion: 2 }));
});

test('account-free local commands work without plugins or a route; inherited keys are not capabilities', () => {
  const config = ServicesConfigSchema.parse({ local: { verify: local } });
  assert.equal(planService('verify', config, [], root, env).selected, 'local');
  assert.equal(planService('constructor', config, [], root, env).selected, null);
  assert.equal(planService('toString', config, [], root, env).selected, null);
  assert.equal(providerInventory(config, [], root, env).categories.length, 9);
});

test('fallback uses explicit order and explains missing prerequisites without leaking credential values', () => {
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': {} }, local: { verify: local }, routes: { verify: { prefer: ['not-installed', 'existing-ci', 'local'], allowedCosts: ['free', 'included'] } } });
  const absent = planService('verify', config, [plugin], root, env);
  assert.equal(absent.selected, 'local');
  assert.match(absent.candidates[0]!.reasons.join(' '), /missing environment variable SERVICE_SECRET/);
  assert.equal(absent.unavailable[0]!.provider, 'not-installed');
  const configured = planService('verify', config, [plugin], root, { ...env, SERVICE_SECRET: 'credential-value' });
  assert.equal(configured.selected, 'existing-ci');
  assert.equal(configured.candidates[0]!.authentication, 'not-checked');
  assert(!JSON.stringify(configured).includes('credential-value'));
  assert.equal(planService('verify', ServicesConfigSchema.parse({ providers: { 'existing-ci': {} } }), [plugin], root, env).selected, null, 'installation/enabling alone does not opt in a route');
});

test('remote-only and cost constraints cannot be weakened by local fallback', () => {
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': {} }, local: { verify: local }, routes: { verify: { prefer: ['existing-ci', 'local'], locality: 'remote' } } });
  const plan = planService('verify', config, [plugin], root, { ...env, SERVICE_SECRET: 'present' });
  assert.equal(plan.selected, null);
  assert.match(plan.candidates[0]!.reasons.join(' '), /excludes included/);
  assert.match(plan.candidates[1]!.reasons.join(' '), /requires remote/);
});

test('missing executables, disabled plugins and forbidden credentials are excluded before dispatch', () => {
  const plugins = [ProviderPluginSchema.parse({ ...plugin, capabilities: { verify: { ...op, command: [join(root, 'not-installed')] } } })];
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': { enabled: false } }, local: { verify: local }, routes: { verify: { prefer: ['existing-ci', 'local'], allowedCosts: ['included', 'free'] } } });
  const plan = planService('verify', config, plugins, root, { ...env, SERVICE_SECRET: 'present' });
  assert.equal(plan.selected, 'local');
  assert.match(plan.candidates[0]!.reasons.join(' '), /not enabled/);
  assert.match(plan.candidates[0]!.reasons.join(' '), /executable is missing/);
  const forbidden = ProviderPluginSchema.parse({ ...plugin, capabilities: { verify: { ...op, requiredEnv: ['YARDMASTER_TOKEN'] } } });
  const enabled = ServicesConfigSchema.parse({ providers: { 'existing-ci': {} }, routes: { verify: { prefer: ['existing-ci'], allowedCosts: ['included'] } } });
  assert.equal(planService('verify', enabled, [forbidden], root, { ...env, YARDMASTER_TOKEN: 'owner-secret' }).selected, null);
});

test('JSON adapters receive structured input/options and only declared environment; all returned credential strings are redacted', async () => {
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': { options: { project: 'demo' } } }, routes: { verify: { prefer: ['existing-ci'], allowedCosts: ['included'] } } });
  const result = await runService('verify', { text: 'not shell: $(touch /unowned) 🚲' }, config, [plugin], { cwd: root, env: { ...env, SERVICE_SECRET: 'quoted-"-credential', UNRELATED_SECRET: 'unrelated', YARDMASTER_TOKEN: 'privileged' } });
  assert.equal(result.result.status, 'passed');
  assert.equal(result.execution.reaped, true);
  assert.match(result.result.summary, /🚲 \[redacted\]/);
  assert(!JSON.stringify(result).includes('quoted-\\"-credential'));
  const data = result.result.data as { request: { input: { text: string }; options: { project: string } }; secret: string; unrelated?: string; owner?: string };
  assert.equal(data.request.options.project, 'demo');
  assert.match(data.request.input.text, /\$\(touch/);
  assert.equal(data.secret, '[redacted]'); assert.equal(data.unrelated, undefined); assert.equal(data.owner, undefined);
  assert.equal(result.result.costUsd, null, 'unreported cost is unknown, even on included allowance');
});

test('a dispatched invalid result or failure never triggers another provider', async () => {
  const fallback = ProviderOperationSchema.parse({ ...local, command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] });
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': {} }, routes: { verify: { prefer: ['existing-ci', 'local'], allowedCosts: ['included', 'free'] } }, local: { verify: fallback } });
  for (const mode of ['invalid', 'exit']) {
    const result = await runService('verify', { mode }, config, [plugin], { cwd: root, env: { ...env, SERVICE_SECRET: 'fixture-secret' } });
    assert.equal(result.provider, 'existing-ci'); assert.equal(result.result.status, 'unknown'); assert.equal(result.dispatched, true);
    assert.equal(existsSync(marker), false);
  }
});

test('local exit-code checks preserve success and failure, and refuse ignored JSON inputs', async () => {
  const config = ServicesConfigSchema.parse({ local: { verify: local, broken: { ...local, command: [process.execPath, '-e', 'process.exit(17)'] } } });
  assert.equal((await runService('verify', {}, config, [], { cwd: root, env })).result.status, 'passed');
  const failed = await runService('broken', {}, config, [], { cwd: root, env });
  assert.equal(failed.result.status, 'failed'); assert.equal(failed.execution.code, 17);
  await assert.rejects(runService('verify', { ignored: true }, config, [], { cwd: root, env }), /do not consume JSON/);
});

test('timeout and cancellation return unknown rather than a passing check', async () => {
  const shortPlugin = ProviderPluginSchema.parse({ ...plugin, capabilities: { verify: { ...op, timeoutMs: 300 } } });
  const config = ServicesConfigSchema.parse({ providers: { 'existing-ci': {} }, routes: { verify: { prefer: ['existing-ci'], allowedCosts: ['included'] } } });
  const timed = await runService('verify', { mode: 'hang' }, config, [shortPlugin], { cwd: root, env: { ...env, SERVICE_SECRET: 'fixture' } });
  assert.equal(timed.result.status, 'unknown'); assert.equal(timed.execution.end, 'timeout'); assert.equal(timed.execution.reaped, true);
  const canceled = new AbortController(); canceled.abort();
  const stopped = await runService('verify', {}, config, [plugin], { cwd: root, env: { ...env, SERVICE_SECRET: 'fixture' }, signal: canceled.signal });
  assert.equal(stopped.result.status, 'unknown'); assert.equal(stopped.dispatched, false);
});

test('provider scaffold validates without executing and duplicate identifiers are disabled', async () => {
  const dir = scaffoldPlugin('fixture-provider', 'provider');
  assert.equal((await testPlugin(dir)).ok, true);
  const plugins = join(home, 'plugins');
  const duplicate = join(plugins, 'duplicate'); mkdirSync(duplicate);
  writeFileSync(join(duplicate, 'index.mjs'), `export default ${JSON.stringify({ ...plugin, name: 'fixture-provider' })};`);
  const loaded = await loadPlugins(plugins);
  assert.equal(loaded.providers.length, 0); assert.match(loaded.errors[0]!.error, /Duplicate/);
});

test('CLI routes without hub/account setup, supports JSON and refuses accidental options', () => {
  const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'yardmaster.json'), JSON.stringify({ services: { local: { verify: local } } }));
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, 'providers', ...args], { cwd: project, env: { ...env, YARDMASTER_HOME: join(root, 'cli-home') }, encoding: 'utf8', timeout: 15000 });
  const plan = cli(['plan', 'verify', '--json']); assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).selected, 'local');
  const run = cli(['run', 'verify', '--json']); assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).result.status, 'passed');
  const typo = cli(['run', 'verify', '--provider', 'missing']); assert.notEqual(typo.status, 0); assert.match(typo.stderr, /Unknown provider option/);
  const dry = cli(['run', 'verify', '--dry-run', '--input', '/not-a-real-file']); assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).selected, 'local');
});
