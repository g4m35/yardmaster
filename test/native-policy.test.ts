import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claude, codex, commandAdapter, cursor, gemini, mock, opencode } from '../src/adapters/builtin.ts';
import type { AdapterContext } from '../src/adapters/types.ts';
import { defaultAgentSettings, EffortRoutingSchema, resolveConfig, type AgentSettings, type Tier } from '../src/config.ts';
import { describeEffort, EffortPolicyError, launchEffort, launchIdentity, launchIdentityChanges, resolveEffort, type RoutedEffort } from '../src/effort.ts';
import { routeEffort, routedEffortOf } from '../src/jev.ts';
import { runOneShot } from '../src/oneshot.ts';
import { UsageMeter } from '../src/usage.ts';
import { tempDir } from './helpers.ts';
process.env.YARDMASTER_HOME = join(tempDir('ym-native-owner-home-'), 'home');

type Ctx = AdapterContext & { routedEffort?: RoutedEffort };
const ctx = (settings: Partial<AgentSettings> = {}, over: Partial<Ctx> = {}): Ctx =>
  ({ prompt: 'do the thing', cwd: '/w', model: 'm', settings: defaultAgentSettings(settings), ...over });
const claudeEffort = (args: string[]) => args.flatMap((a, i) => (a === '--effort' ? [args[i + 1]] : a.startsWith('--effort=') ? [a.slice(9)] : []));
const codexEffort = (args: string[]) => args.filter((a) => a.includes('model_reasoning_effort'));
const policyError = (code: string) => (err: unknown) => err instanceof EffortPolicyError && err.code === code;
const TIER_LIST: Tier[] = ['cheap', 'standard', 'strong'];

test('Claude native budget clamps a local ceiling without mutating manual configuration', () => {
  for (const budgetUsd of [.01, .023456, 1.000001]) {
    const args = claude.build(ctx({}, { budgetUsd })).args;
    assert.equal(Number(args[args.indexOf('--max-budget-usd') + 1]), budgetUsd);
    const manual = ['--max-budget-usd', String(budgetUsd + 1)];
    const clamped = claude.build(ctx({ extraArgs: manual }, { budgetUsd })).args;
    assert.equal(Number(clamped[clamped.indexOf('--max-budget-usd') + 1]), budgetUsd);
    assert.deepEqual(manual, ['--max-budget-usd', String(budgetUsd + 1)]);
  }
  const args = claude.build(ctx({ extraArgs: ['--max-budget-usd=0.01'] }, { budgetUsd: .02 })).args;
  assert.equal(args.filter(a => a.startsWith('--max-budget-usd')).length, 1);
});

// ---------- defaults stay backward compatible ----------

test('managed defaults keep the tier efforts on every Claude/Codex build path, including plan and review equivalents', () => {
  const expected = { cheap: 'low', standard: 'medium', strong: 'high' } as const;
  for (const tier of TIER_LIST) {
    for (const readOnly of [false, true]) {
      const c = ctx({}, { tier, readOnly });
      const cs = claude.build(c);
      assert.deepEqual(claudeEffort(cs.args), [expected[tier]], `claude ${tier} readOnly=${readOnly}`);
      assert.equal(launchEffort('claude', c, cs).source, 'tier-default');
      const xs = codex.build(c);
      assert.deepEqual(codexEffort(xs.args), [`model_reasoning_effort="${expected[tier]}"`]);
      assert.equal(launchEffort('codex', c, xs).effective, expected[tier]);
    }
  }
  // A launch without a tier (helper runs) still passes no effort, as before.
  const untiered = ctx();
  assert.deepEqual(claudeEffort(claude.build(untiered).args), []);
  assert.equal(launchEffort('claude', untiered, claude.build(untiered)).source, 'native');
});

// ---------- minimum (floor) ----------

test('a minimum raises generated tier defaults on cheap/standard/strong, plan (strong) and review (standard) builds', () => {
  for (const tier of TIER_LIST) {
    for (const readOnly of [false, true]) {
      const c = ctx({ minimumEffort: 'high' }, { tier, readOnly });
      assert.deepEqual(claudeEffort(claude.build(c).args), ['high']);
      assert.deepEqual(codexEffort(codex.build(c).args), ['model_reasoning_effort="high"']);
      const e = resolveEffort('claude', c);
      assert.equal(e.source, tier === 'strong' ? 'tier-default' : 'floor');
      if (tier === 'cheap') assert.equal(e.raisedFrom, 'low');
    }
  }
  // Higher floors and an untiered launch.
  assert.deepEqual(claudeEffort(claude.build(ctx({ minimumEffort: 'xhigh' }, { tier: 'strong' })).args), ['xhigh']);
  assert.deepEqual(claudeEffort(claude.build(ctx({ minimumEffort: 'high' })).args), ['high'], 'no tier: the minimum is passed');
  assert.match(describeEffort(resolveEffort('claude', ctx({ minimumEffort: 'high' }, { tier: 'cheap' }))), /effort high \(floor, raised from low, minimum high\)/);
  // Resume builds (Codex `exec resume`) carry the floor too.
  const resumed = codex.build(ctx({ minimumEffort: 'high' }, { tier: 'cheap', session: { resume: 'thread-1' } })).args;
  assert.deepEqual(codexEffort(resumed), ['model_reasoning_effort="high"']);
  assert.deepEqual(resumed.slice(-2), ['thread-1', '-']);
});

test('an unsupported or unknown floor fails clearly instead of being ignored', () => {
  assert.throws(() => claude.build(ctx({ minimumEffort: 'ultra' }, { tier: 'cheap' })), policyError('unsupported_floor'));
  assert.throws(() => claude.build(ctx({ minimumEffort: 'hgih' }, { tier: 'cheap' })), /not an effort Claude Code accepts/);
  assert.doesNotThrow(() => codex.build(ctx({ minimumEffort: 'ultra' }, { tier: 'cheap' })), 'Codex documents ultra');
  for (const adapter of [opencode, cursor, gemini, commandAdapter('aider', 'aider --yes')]) {
    assert.throws(() => adapter.build(ctx({ minimumEffort: 'high' }, { tier: 'cheap' })), policyError('unsupported_floor'), adapter.name);
    // Without a minimum nothing changes for agents that have no effort flag.
    const spec = adapter.build(ctx({}, { tier: 'cheap' }));
    assert.equal(launchEffort(adapter.name, ctx({}, { tier: 'cheap' }), spec).source, 'native');
    // An operator attestation of the agent's own configuration satisfies the floor; still no flag is invented.
    const attested = ctx({ minimumEffort: 'high', attestedEffort: 'xhigh' }, { tier: 'cheap' });
    const a = adapter.build(attested);
    assert.equal(launchEffort(adapter.name, attested, a).source, 'native-attested');
    assert.ok(!a.args.some((x) => /effort/.test(x)));
    assert.throws(() => adapter.build(ctx({ minimumEffort: 'high', attestedEffort: 'medium' }, { tier: 'cheap' })), policyError('below_floor'));
  }
});

// ---------- native ownership ----------

test('native ownership emits no generated effort flag; a floor needs an attestation at or above it', () => {
  for (const tier of TIER_LIST) {
    for (const readOnly of [false, true]) {
      const c = ctx({ effortOwnership: 'native' }, { tier, readOnly });
      assert.deepEqual(claudeEffort(claude.build(c).args), []);
      assert.deepEqual(codexEffort(codex.build(c).args), []);
      const e = resolveEffort('codex', c);
      assert.deepEqual([e.source, e.effective, e.evidence, e.emitted], ['native', null, 'unknown', null]);
    }
  }
  assert.throws(() => claude.build(ctx({ effortOwnership: 'native', minimumEffort: 'high' }, { tier: 'strong' })), policyError('native_floor_unattested'));
  assert.throws(() => codex.build(ctx({ effortOwnership: 'native', minimumEffort: 'high', attestedEffort: 'low' }, { tier: 'strong' })), policyError('below_floor'));
  const ok = ctx({ effortOwnership: 'native', minimumEffort: 'high', attestedEffort: 'high' }, { tier: 'cheap' });
  const spec = claude.build(ok);
  assert.deepEqual(claudeEffort(spec.args), []);
  assert.deepEqual([launchEffort('claude', ok, spec).source, launchEffort('claude', ok, spec).effective], ['native-attested', 'high']);
  // A routed decision can never sneak a flag into a native-owned launch.
  assert.throws(() => claude.build(ctx({ effortOwnership: 'native' }, { tier: 'cheap', routedEffort: { level: 'low', by: 'jev' } })), policyError('conflicting_effort'));
});

// ---------- explicit manual choices ----------

test('explicit manual effort maps are preserved, including "" (native), and never overridden by the floor', () => {
  // Manual wins over ownership and the tier default.
  assert.deepEqual(claudeEffort(claude.build(ctx({ effort: { cheap: 'xhigh' } }, { tier: 'cheap' })).args), ['xhigh']);
  assert.deepEqual(claudeEffort(claude.build(ctx({ effort: { cheap: 'max' }, effortOwnership: 'native' }, { tier: 'cheap' })).args), ['max']);
  assert.equal(resolveEffort('claude', ctx({ effort: { cheap: 'xhigh' } }, { tier: 'cheap' })).source, 'manual');
  // "" keeps the agent's own configuration for that tier only.
  const empty = ctx({ effort: { strong: '' } }, { tier: 'strong' });
  assert.deepEqual(claudeEffort(claude.build(empty).args), []);
  assert.deepEqual(claudeEffort(claude.build({ ...empty, tier: 'cheap' }).args), ['low']);
  assert.throws(() => claude.build(ctx({ effort: { strong: '' }, minimumEffort: 'high' }, { tier: 'strong' })), policyError('native_floor_unattested'));
  assert.doesNotThrow(() => claude.build(ctx({ effort: { strong: '' }, minimumEffort: 'high', attestedEffort: 'high' }, { tier: 'strong' })));
  // Values the CLI documents but Yardmaster never generates still pass through untouched without a floor.
  assert.deepEqual(codexEffort(codex.build(ctx({ effort: { cheap: 'minimal' } }, { tier: 'cheap' })).args), ['model_reasoning_effort="minimal"']);
  assert.deepEqual(claudeEffort(claude.build(ctx({ effort: { cheap: 'turbo' } }, { tier: 'cheap' })).args), ['turbo']);
  // Below the floor: refuse rather than silently changing what the user wrote.
  assert.throws(() => claude.build(ctx({ effort: { cheap: 'low' }, minimumEffort: 'high' }, { tier: 'cheap' })), policyError('below_floor'));
  assert.throws(() => codex.build(ctx({ effort: { standard: 'minimal' }, minimumEffort: 'low' }, { tier: 'standard' })), policyError('below_floor'));
  assert.throws(() => claude.build(ctx({ effort: { cheap: 'turbo' }, minimumEffort: 'high' }, { tier: 'cheap' })), policyError('unranked_effort'));
  assert.deepEqual(claudeEffort(claude.build(ctx({ effort: { cheap: 'max' }, minimumEffort: 'high' }, { tier: 'cheap' })).args), ['max']);
});

test('effort in extraArgs is the user\'s choice: no duplicate generated flag, conflicts and below-floor values are refused', () => {
  for (const flag of [['--effort', 'high'], ['--effort=high']]) {
    const c = ctx({ extraArgs: flag }, { tier: 'cheap' });
    const spec = claude.build(c);
    assert.deepEqual(claudeEffort(spec.args), ['high'], 'only the user\'s own flag remains');
    const e = launchEffort('claude', c, spec);
    assert.deepEqual([e.source, e.effective, e.emitted, e.evidence], ['extra-args', 'high', null, 'user-flag']);
  }
  for (const flag of [['-c', 'model_reasoning_effort="xhigh"'], ['--config', 'model_reasoning_effort=xhigh'], ['-cmodel_reasoning_effort=xhigh'], ['--config=model_reasoning_effort = \'xhigh\'']]) {
    const spec = codex.build(ctx({ extraArgs: flag }, { tier: 'cheap' }));
    assert.equal(codexEffort(spec.args).length, 1, `${flag.join(' ')} -> ${spec.args.join(' ')}`);
    assert.equal(resolveEffort('codex', ctx({ extraArgs: flag }, { tier: 'cheap' })).effective, 'xhigh');
  }
  // Unrelated config overrides are not mistaken for effort.
  assert.deepEqual(codexEffort(codex.build(ctx({ extraArgs: ['-c', 'model_verbosity="low"'] }, { tier: 'strong' })).args), ['model_reasoning_effort="high"']);
  assert.throws(() => claude.build(ctx({ extraArgs: ['--effort', 'high', '--effort', 'low'] }, { tier: 'cheap' })), policyError('conflicting_effort'));
  assert.throws(() => claude.build(ctx({ extraArgs: ['--effort', 'high'], effort: { cheap: 'medium' } }, { tier: 'cheap' })), policyError('conflicting_effort'));
  assert.doesNotThrow(() => claude.build(ctx({ extraArgs: ['--effort', 'high'], effort: { cheap: 'high' } }, { tier: 'cheap' })), 'the same value twice is not a conflict');
  assert.throws(() => codex.build(ctx({ extraArgs: ['-c', 'model_reasoning_effort=low'], minimumEffort: 'high' }, { tier: 'strong' })), policyError('below_floor'));
  assert.doesNotThrow(() => codex.build(ctx({ extraArgs: ['-c', 'model_reasoning_effort=high'], minimumEffort: 'high' }, { tier: 'cheap' })));
});

test('a custom command with a floor needs an attestation that it applies the flag', () => {
  assert.throws(() => claude.build(ctx({ command: '/opt/claude-wrapper', minimumEffort: 'high' }, { tier: 'cheap' })), policyError('custom_command_unattested'));
  const c = ctx({ command: '/opt/claude-wrapper', minimumEffort: 'high', attestedEffort: 'high' }, { tier: 'cheap' });
  const spec = claude.build(c);
  assert.equal(spec.command, '/opt/claude-wrapper');
  assert.deepEqual(claudeEffort(spec.args), ['high']);
  assert.equal(launchEffort('claude', c, spec).customCommand, true);
  // Without a floor, custom commands keep their previous behavior.
  assert.deepEqual(claudeEffort(claude.build(ctx({ command: '/opt/claude-wrapper' }, { tier: 'cheap' })).args), ['low']);
});

// ---------- routed effort and JEV ----------

test('routed effort is recorded as routed, clamped to the floor, and cannot replace an explicit choice', () => {
  const routed = (level: string): RoutedEffort => ({ level, by: 'jev' });
  const r = ctx({}, { tier: 'strong', routedEffort: routed('medium') });
  assert.deepEqual(claudeEffort(claude.build(r).args), ['medium']);
  assert.equal(launchEffort('claude', r, claude.build(r)).source, 'jev');
  const low = ctx({ minimumEffort: 'high' }, { tier: 'strong', routedEffort: routed('low') });
  assert.deepEqual(codexEffort(codex.build(low).args), ['model_reasoning_effort="high"']);
  assert.deepEqual([resolveEffort('codex', low).source, resolveEffort('codex', low).raisedFrom], ['floor', 'low']);
  assert.throws(() => claude.build(ctx({ effort: { strong: 'high' } }, { tier: 'strong', routedEffort: routed('low') })), policyError('conflicting_effort'));
});

function router(reply: 'low' | 'medium' | 'fail') {
  const root = tempDir('ym-native-jev-');
  const script = join(root, 'router.mjs');
  const capture = join(root, 'request.json');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
const q = JSON.parse(input);
writeFileSync(${JSON.stringify(capture)}, input);
if (${JSON.stringify(reply)} === 'fail') process.exit(3);
const level = ${JSON.stringify(reply)};
console.log(JSON.stringify({ v:1, requestId:q.requestId, sessionId:q.sessionId, providerInstanceId:q.providerInstanceId, model:q.model,
  status:'apply', reason:'difficulty_lower', level, patch:{ optionId:q.capability.optionId, value:level }, judge:null }));
`);
  return { root, capture, command: [process.execPath, script] };
}

const jevTask = { id: 't-native', title: 'Tidy', prompt: 'Tidy a helper.', attempts: 1, agent_session: null, retry_note: null, review_rounds: 0, conflict_rounds: 0 };
const binding = { agent: 'claude', model: 'm', efforts: ['low', 'medium', 'high'], cacheImpact: 'preserves-prefix' };

test('JEV honors the floor: lower options are withheld, replies below it fall back, a fixed floor skips the call', async () => {
  const run = async (reply: 'low' | 'medium' | 'fail', settings: Partial<AgentSettings>, tier: Tier, extra: Record<string, unknown> = {}) => {
    const r = router(reply);
    const config = EffortRoutingSchema.parse({ enabled: true, mode: 'active', command: r.command, timeoutMs: 5000, bindings: [binding], ...extra });
    const s = defaultAgentSettings(settings);
    const decision = await routeEffort({ config, agent: 'claude', model: 'm', settings: s, tier, task: { ...jevTask, ...(extra.task as object) }, repoPath: r.root });
    const request = existsSync(r.capture) ? JSON.parse(readFileSync(r.capture, 'utf8')) as { baseline: string; capability: { values: string[] } } : null;
    const c = ctx(settings, { tier, routedEffort: routedEffortOf(decision) });
    return { decision, request, args: claudeEffort(claude.build(c).args), source: resolveEffort('claude', c).source };
  };
  // No floor: unchanged behavior, the routed low is applied and recorded as JEV.
  const plain = await run('low', {}, 'standard');
  assert.deepEqual([plain.decision.status, plain.args, plain.source], ['apply', ['low'], 'jev']);
  assert.deepEqual(plain.request!.capability.values, ['low', 'medium', 'high']);
  // Floor medium on strong work: low is withheld, a medium reply applies.
  const applied = await run('medium', { minimumEffort: 'medium' }, 'strong');
  assert.deepEqual(applied.request!.capability.values, ['medium', 'high']);
  assert.deepEqual([applied.decision.status, applied.args, applied.source], ['apply', ['medium'], 'jev']);
  // A reply below the floor falls back to the baseline.
  const below = await run('low', { minimumEffort: 'medium' }, 'strong');
  assert.deepEqual([below.decision.status, below.decision.reason, below.args], ['fallback', 'below_floor', ['high']]);
  // Floor at or above the baseline leaves nothing to choose: no router call, the floor is passed.
  const fixed = await run('low', { minimumEffort: 'high' }, 'cheap');
  assert.deepEqual([fixed.decision.status, fixed.decision.reason, fixed.decision.managed, fixed.request, fixed.args, fixed.source], ['skipped', 'at_floor', true, null, ['high'], 'floor']);
  // Router failure and retries keep the floor-raised default.
  const failed = await run('fail', { minimumEffort: 'medium' }, 'strong');
  assert.deepEqual([failed.decision.status, failed.args], ['fallback', ['high']]);
  const retry = await run('low', { minimumEffort: 'medium' }, 'cheap', { task: { attempts: 2 } });
  assert.deepEqual([retry.decision.status, retry.decision.reason, retry.request, retry.args], ['skipped', 'recovery', null, ['medium']]);
  // Shadow suggests only; the launch keeps the floor-raised default.
  const shadow = await run('medium', { minimumEffort: 'medium' }, 'strong', { mode: 'shadow' });
  assert.deepEqual([shadow.decision.status, shadow.args, shadow.source], ['shadow', ['high'], 'tier-default']);
  // Native ownership: no call and no host-routing suppression; the native client keeps effort.
  const native = await run('low', { effortOwnership: 'native' }, 'strong');
  assert.deepEqual([native.decision.status, native.decision.reason, native.decision.managed, native.request, native.args], ['skipped', 'native_ownership', false, null, []]);
  // Explicit manual settings still bypass classification.
  const manual = await run('low', { effort: { strong: 'high' } }, 'strong');
  assert.deepEqual([manual.decision.reason, manual.request], ['explicit_settings', null]);
  // A floor JEV cannot represent is not routed (the build reports the precise error).
  const odd = await run('low', { minimumEffort: 'max' }, 'strong');
  assert.deepEqual([odd.decision.status, odd.decision.reason, odd.request], ['skipped', 'unsupported_floor', null]);
  // The legacy bridge (decision written into settings.effort) is still at or above the floor.
  assert.deepEqual(claudeEffort(claude.build(ctx({ minimumEffort: 'medium', effort: { strong: applied.decision.effort! } }, { tier: 'strong' })).args), ['medium']);
  assert.equal(routedEffortOf(shadow.decision), undefined);
});

// ---------- oneshot (plan/review) launches go through the policy ----------

test('one-shot plan/review launches apply the floor through the adapter and report cache writes', async () => {
  const root = tempDir('ym-native-oneshot-');
  const fake = join(root, 'fake-claude.sh');
  const argsFile = join(root, 'args.txt');
  writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
cat > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":10,"cache_creation_input_tokens":4,"cache_read_input_tokens":2,"output_tokens":3},"total_cost_usd":0.01}'
`);
  chmodSync(fake, 0o755);
  const config = (agent: Record<string, unknown>) => resolveConfig([{ agents: { claude: { command: fake, ...agent } } }]);
  for (const [tier, label] of [['standard', 'review'], ['strong', 'plan']] as const) {
    rmSync(argsFile, { force: true });
    const r = await runOneShot({ agent: 'claude', config: config({ minimumEffort: 'xhigh', attestedEffort: 'xhigh' }), prompt: 'review this', cwd: root, readOnly: true, tier, timeoutMs: 20_000 });
    assert.equal(r.ok, true, `${label}: ${r.error}`);
    assert.deepEqual(claudeEffort(readFileSync(argsFile, 'utf8').trim().split('\n')), ['xhigh'], label);
    assert.equal(r.usage.cacheWriteTokens, 4);
    assert.equal(r.usage.cacheReadTokens, 2);
  }
  // A floor the launch cannot prove stops it before anything is spawned.
  rmSync(argsFile, { force: true });
  let outcome: unknown;
  try {
    outcome = await runOneShot({ agent: 'claude', config: config({ minimumEffort: 'high' }), prompt: 'review this', cwd: root, readOnly: true, tier: 'standard', timeoutMs: 20_000 });
  } catch (err) {
    outcome = err;
  }
  if (outcome instanceof Error) assert.ok(policyError('custom_command_unattested')(outcome), String(outcome));
  else assert.equal((outcome as { ok: boolean }).ok, false);
  assert.equal(existsSync(argsFile), false, 'the CLI never started');
});

// ---------- usage telemetry ----------

test('Claude and OpenCode report cache writes when present; missing values stay unknown, missing OpenCode cost stays unpriced', () => {
  const assistant = claude.parse(JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [], usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 7 } } }));
  assert.deepEqual(assistant, [{ type: 'usage', tokensIn: 105, cachedIn: 900, cacheWriteIn: 100, tokensOut: 7, cumulative: false, id: 'msg-1' }]);
  const noWrite = claude.parse(JSON.stringify({ type: 'assistant', message: { id: 'msg-2', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }))[0]!;
  assert.ok(noWrite.type === 'usage' && !Object.hasOwn(noWrite, 'cacheWriteIn'), 'absent means unknown');
  const result = claude.parse(JSON.stringify({ type: 'result', subtype: 'success', result: 'x', total_cost_usd: 0.2, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 3, output_tokens: 2 } }))[0]!;
  assert.ok(result.type === 'usage' && result.cacheWriteIn === 0 && result.costUsd === 0.2, 'a reported zero is kept');

  const step = (part: Record<string, unknown>) => opencode.parse(JSON.stringify({ type: 'step_finish', part }))[0]!;
  const priced = step({ cost: 0.03, tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 50, write: 20 } } });
  assert.deepEqual(priced, { type: 'usage', tokensIn: 30, cachedIn: 50, cacheWriteIn: 20, tokensOut: 5, costUsd: 0.03, cumulative: false });
  const unpriced = step({ tokens: { input: 10, output: 4, cache: { read: 50 } } });
  assert.ok(unpriced.type === 'usage' && !Object.hasOwn(unpriced, 'costUsd') && !Object.hasOwn(unpriced, 'cacheWriteIn'));
  const free = step({ cost: 0, tokens: { input: 1, output: 1 } });
  assert.ok(free.type === 'usage' && free.costUsd === 0, 'a reported $0 is an actual figure');

  const meter = new UsageMeter({ inPerM: 1, outPerM: 2 });
  if (unpriced.type === 'usage') meter.add(unpriced);
  const snap = meter.snapshot();
  assert.equal(snap.provenance, 'estimated', 'missing cost is estimated from list prices, not recorded as actual $0');
  assert.ok(snap.costUsd > 0);
  assert.equal(snap.cacheWriteTokens, null);
  const known = new UsageMeter({ inPerM: 1, outPerM: 2 });
  if (priced.type === 'usage') known.add(priced);
  assert.deepEqual([known.snapshot().provenance, known.snapshot().cacheWriteTokens, known.snapshot().cacheReadTokens], ['actual', 20, 50]);
});

// ---------- launch identity ----------

test('launch identity ignores volatile and secret inputs and changes with model, effort, tools, MCP and context', () => {
  const base = { model: 'opus', tier: 'strong' as const };
  const id = (settings: Partial<AgentSettings> = {}, over: Partial<Ctx> = {}) => {
    const c = ctx(settings, { ...base, ...over });
    return launchIdentity('claude', c, claude.build(c));
  };
  const a = id({}, { prompt: 'first prompt', session: { pin: 'aaaa' }, budgetUsd: 3, cwd: '/wt/task-1' });
  const b = id({}, { prompt: 'second prompt', session: { resume: 'bbbb' }, budgetUsd: 0.5, cwd: '/wt/task-2', maxTurns: 4 });
  assert.equal(a.fingerprint, b.fingerprint, 'prompt, session, task worktree and budget are not identity');
  assert.match(a.fingerprint, /^lf1:[0-9a-f]{32}$/);
  assert.deepEqual([a.identity.effort, a.identity.nativeEffort, a.identity.model], ['high', false, 'opus']);

  const cases: [string, ReturnType<typeof id>][] = [
    ['model', id({}, { model: 'sonnet' })],
    ['effort', id({}, { tier: 'standard' })],
    ['effort', id({ minimumEffort: 'xhigh' })],
    ['tools', id({ tools: ['Read'] })],
    ['mcpConfig', id({ mcpConfig: '/me/mcp.json' })],
    ['context', id({ context: 'full' })],
    ['readOnly', id({}, { readOnly: true })],
    ['extraArgs', id({ extraArgs: ['--verbose'] })],
    ['command', id({ command: '/opt/claude' })],
  ];
  for (const [field, other] of cases) {
    assert.notEqual(other.fingerprint, a.fingerprint, field);
    assert.ok(launchIdentityChanges(a.identity, other.identity).includes(field as never), `${field}: ${launchIdentityChanges(a.identity, other.identity).join(',')}`);
  }
  assert.deepEqual(launchIdentityChanges(a.identity, b.identity), []);
  // Same effective effort from a different source (floor vs tier default) is the same provider launch.
  assert.equal(id({ minimumEffort: 'high' }).fingerprint, a.fingerprint);
  // Native effort is flagged: the native configuration is outside what the fingerprint can see.
  assert.deepEqual([id({ effortOwnership: 'native' }).identity.effort, id({ effortOwnership: 'native' }).identity.nativeEffort], [null, true]);

  const secret = id({ extraArgs: ['--api-key', 'sk-SECRET-VALUE'] }, { prompt: 'PRIVATE-PROMPT' });
  const text = JSON.stringify(secret);
  assert.ok(!text.includes('sk-SECRET-VALUE') && !text.includes('PRIVATE-PROMPT'), text);
  assert.deepEqual(secret.identity.extraArgs.count, 2);
  assert.deepEqual(secret.identity.env, ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER'], 'env names only');
  const withHost = launchIdentity('claude', ctx({}, base), claude.build(ctx({}, base)), { hostVersion: '2.1.319' });
  assert.notEqual(withHost.fingerprint, a.fingerprint);
});

test('the mock agent records the effective effort so runner-level tests can check the policy', () => {
  const spec = mock.build(ctx({ minimumEffort: 'high' }, { tier: 'cheap' }));
  assert.equal(JSON.parse(spec.env!.YM_MOCK_ARGS!).effort, 'high');
});
