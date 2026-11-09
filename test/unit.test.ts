import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferScope, matches, patternsOverlap, scopesOverlap } from '../src/scope.ts';
import { findCycle } from '../src/graph.ts';
import { Watchdog } from '../src/watchdog.ts';
import { errorFingerprint, jaccard, wordSet } from '../src/text.ts';
import { chooseAgent, escalate, inferTier, isSmallCheckedTask } from '../src/router.ts';
import { agentSettings, resolveConfig, unknownSettings } from '../src/config.ts';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/db.ts';
import { claude, codex, opencode } from '../src/adapters/builtin.ts';
import { changedLineCount } from '../src/review.ts';
import { priceFor } from '../src/config.ts';
import { execFileSync } from 'node:child_process';
import { rmSync as rmrf, writeFileSync as write } from 'node:fs';
import { tempDir } from './helpers.ts';
import { taskChecks, verifyCommands } from '../src/runner.ts';
import { planGoal } from '../src/planner.ts';
import { createServer } from 'node:http';
import { remoteClient, RPC_TIMEOUT_MS, rpcDeadline } from '../src/rpc.ts';
import { acquireHubLock, HubAlreadyRunning } from '../src/hublock.ts';
import { cleanEnv } from '../src/proc.ts';
import { dispatch } from '../src/api.ts';
import { yardHome } from '../src/paths.ts';

const wd = { repeatThreshold: 4, oscillationCycles: 3, sameToolErrorLimit: 3, stallMinutes: 1, awaitingInputMinutes: 0.5, maxRuntimeMinutes: 10 };

test('glob matching', () => {
  assert.ok(matches('src/auth/login.ts', 'src/auth/**'));
  assert.ok(matches('src/auth/login.ts', 'src/auth'));
  assert.ok(matches('src/a.ts', 'src/*.ts'));
  assert.ok(!matches('src/x/a.ts', 'src/*.ts'));
  assert.ok(matches('packages/web/src/x.tsx', '**/*.tsx'));
  assert.ok(matches('a/b.json', 'a/{b,c}.json'));
});

test('scope overlap is conservative but not blind', () => {
  assert.ok(patternsOverlap('src/auth/**', 'src/auth/login.ts'));
  assert.ok(patternsOverlap('src/**', 'src/ui/**'));
  assert.ok(patternsOverlap('**/*.ts', 'docs/x.ts'));
  assert.ok(!patternsOverlap('src/auth/**', 'src/ui/**'));
  assert.ok(!patternsOverlap('README.md', 'src/index.ts'));
  assert.deepEqual(scopesOverlap(['a/**'], ['b/**', 'c.txt']), []);
});

test('scope inference from plain-language requests', () => {
  assert.deepEqual(inferScope('Fix the typo in README.md and update docs/setup.md'), ['README.md', 'docs/setup.md']);
  assert.deepEqual(inferScope('Refactor src/auth/ to use JWT'), ['src/auth/**']);
  assert.deepEqual(inferScope('make the login page nicer, e.g. bigger buttons'), []);
});

test('dependency cycles are found', () => {
  assert.equal(findCycle(new Map([['a', ['b']], ['b', ['c']]])), null);
  assert.deepEqual(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]])), ['a', 'b', 'c', 'a']);
});

test('watchdog: identical consecutive calls are a loop', () => {
  const w = new Watchdog(wd, 0);
  let v = null;
  for (let i = 0; i < 4 && !v; i++) v = w.feed({ type: 'tool', name: 'Read', input: { file_path: 'a' }, write: false }, i);
  assert.equal(v?.kind, 'loop');
});

test('watchdog: re-reading a file between edits is not a loop', () => {
  const w = new Watchdog(wd, 0);
  for (let i = 0; i < 12; i++) {
    assert.equal(w.feed({ type: 'tool', name: 'Read', input: { file_path: 'a' }, write: false }, i), null);
    assert.equal(w.feed({ type: 'tool', name: 'Edit', input: { file_path: 'a', n: i }, write: true }, i), null);
  }
});

test('watchdog: A-B-A-B oscillation', () => {
  const w = new Watchdog(wd, 0);
  let v = null;
  for (let i = 0; i < 6 && !v; i++) v = w.feed({ type: 'tool', name: 'Bash', input: { command: i % 2 ? 'undo' : 'do' }, write: false }, i);
  assert.equal(v?.kind, 'oscillation');
});

test('watchdog: same tool error repeatedly, with a permission hint', () => {
  const w = new Watchdog(wd, 0);
  let v = null;
  for (let i = 0; i < 3 && !v; i++) v = w.feed({ type: 'tool_result', ok: false, text: `Permission denied: npm test (attempt at 12:0${i}:01)` }, i);
  assert.equal(v?.kind, 'repeated_error');
  assert.match(v!.message, /permission/i);
});

test('watchdog: stall, question, and runtime limit', () => {
  const w = new Watchdog(wd, 0);
  w.feed({ type: 'text', text: 'Should I also migrate the database?' }, 1000);
  assert.equal(w.tick(20_000), null);
  assert.equal(w.tick(40_000)?.kind, 'awaiting_input');
  const s = new Watchdog(wd, 0);
  s.feed({ type: 'tool', name: 'Bash', input: 'npm test', write: false }, 0);
  assert.equal(s.tick(61_000)?.kind, 'stall');
  assert.equal(new Watchdog(wd, 0).tick(11 * 60_000)?.kind, 'timeout');
});

test('error fingerprints ignore timing noise', () => {
  const a = 'FAIL src/a.test.ts:12:5\n  expected 1 to be 2\nTests: 1 failed (312ms) at 2026-11-03T10:00:00Z';
  const b = 'FAIL src/a.test.ts:14:9\n  expected 1 to be 2\nTests: 1 failed (95ms) at 2026-11-03T10:05:12Z';
  assert.equal(errorFingerprint(a), errorFingerprint(b));
  assert.notEqual(errorFingerprint(a), errorFingerprint('totally different failure'));
});

test('duplicate detection via word overlap', () => {
  assert.ok(jaccard(wordSet('Add dark mode toggle to settings page'), wordSet('add a dark-mode toggle to the settings page')) >= 0.6);
  assert.ok(jaccard(wordSet('Add dark mode'), wordSet('Fix login redirect bug')) < 0.2);
});

test('tier inference and escalation', () => {
  assert.equal(inferTier('Fix typo in README'), 'cheap');
  assert.equal(inferTier('Redesign the authentication architecture'), 'strong');
  assert.equal(inferTier('Add a CSV export button'), 'standard');
  assert.equal(escalate('cheap'), 'standard');
  assert.equal(escalate('strong'), 'strong');
});

test('routing skips busy and consistently failing agents', () => {
  const config = resolveConfig([{ routing: { standard: ['claude', 'codex'] }, agents: { claude: { maxParallel: 1 } } }]);
  const base = { config, tier: 'standard' as const, forced: null, installed: ['claude', 'codex'] };
  assert.equal(chooseAgent({ ...base, runningByAgent: {}, stats: {} })?.agent, 'claude');
  assert.equal(chooseAgent({ ...base, runningByAgent: { claude: 1 }, stats: {} })?.agent, 'codex');
  const st = (agent: string, runs: number, verified: number, cost: number) => ({ runs, verified, cost, ms: 0,
    byTier: { standard: { runs, verified, cost } },
    byModel: { [JSON.stringify(agentSettings(config, agent).models.standard ?? null)]: { standard: { runs, verified, cost } } } });
  // Learned routing: claude keeps failing here, codex keeps passing.
  assert.equal(chooseAgent({ ...base, runningByAgent: {}, stats: { claude: st('claude', 5, 0, 1), codex: st('codex', 5, 5, 1) }, random: () => 0.99 })?.agent, 'codex');
  // Equal success: the cheaper agent wins.
  const pick = chooseAgent({ ...base, runningByAgent: {}, stats: { claude: st('claude', 6, 6, 6), codex: st('codex', 6, 6, 1) }, random: () => 0.99 });
  assert.equal(pick?.agent, 'codex');
  assert.match(pick!.reason, /6\/6 verified/);
  // Exploration gives an agent with no history a chance.
  const cfg2 = resolveConfig([{ routing: { standard: ['claude', 'codex'] }, learning: { explore: 0.5 } }]);
  assert.equal(chooseAgent({ ...base, config: cfg2, runningByAgent: {}, stats: { claude: st('claude', 6, 6, 1) }, random: () => 0.1 })?.agent, 'codex');
  assert.equal(chooseAgent({ ...base, installed: [], runningByAgent: {}, stats: {} }), null);
});

test('presets layer under user config', () => {
  const c = resolveConfig([{ preset: 'careful', maxParallel: 4 }]);
  assert.equal(c.integration.requireApproval, true);
  assert.equal(c.maxParallel, 4);
  assert.equal(resolveConfig([{ preset: 'frugal' }]).defaultTier, 'cheap');
  assert.throws(() => resolveConfig([{ preset: 'turbo' }]), /Unknown preset/);
});

const fixture = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures/agent-samples', f), 'utf8').split('\n').filter(Boolean);

test('claude adapter parses real stream-json', () => {
  const events = fixture('claude.jsonl').flatMap((l) => claude.parse(l));
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'Read'));
  const result = events.find((e) => e.type === 'result');
  assert.deepEqual(result, { type: 'result', ok: true, text: 'DONE' });
  const final = events.filter((e) => e.type === 'usage' && e.cumulative);
  assert.equal(final.length, 1);
  assert.ok(final[0]!.type === 'usage' && final[0]!.costUsd! > 0);
});

test('codex adapter parses real exec --json', () => {
  const events = fixture('codex.jsonl').flatMap((l) => codex.parse(l));
  assert.equal(events.filter((e) => e.type === 'tool' && e.name === 'shell').length, 2);
  assert.ok(events.some((e) => e.type === 'tool_result' && e.ok));
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'DONE'));
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage' && usage.cachedIn === 35072);
});

test('opencode adapter parses real run --format json', () => {
  const events = fixture('oc.jsonl').flatMap((l) => opencode.parse(l));
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'DONE'));
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage' && usage.costUsd! > 0);
});

test('adapters never put prompts through a shell and close stdin for codex', () => {
  const settings = { enabled: true, models: {}, maxParallel: 1, extraArgs: [], autonomy: 'workspace' as const };
  const spec = codex.build({ prompt: 'rm -rf / $(evil)', cwd: '/tmp/x', model: null, settings });
  assert.equal(spec.stdin, 'rm -rf / $(evil)');
  assert.equal(spec.args.at(-1), '-');
  assert.ok(spec.args.includes('workspace-write'));
  const c = claude.build({ prompt: 'p', cwd: '/tmp/x', model: 'haiku', settings });
  assert.ok(c.args.includes('acceptEdits'));
  assert.ok(!c.args.includes('--bare'), 'user config, hooks and MCP servers must be preserved');
});

test('hub calls give up when the hub stops answering; task.wait gets its own wait plus slack', async () => {
  assert.equal(rpcDeadline('task.get', {}), RPC_TIMEOUT_MS);
  assert.equal(rpcDeadline('task.wait', { timeoutSec: 600 }), 615_000);
  assert.equal(rpcDeadline('task.wait', {}), 75_000);
  assert.equal(rpcDeadline('task.wait', { timeoutSec: 1.0005 }), 16_001, 'whole milliseconds only');
  assert.doesNotThrow(() => AbortSignal.timeout(rpcDeadline('task.wait', { timeoutSec: 1.5 })));
  assert.equal(rpcDeadline('task.wait', { timeoutSec: 600 }, 1500), 1500, 'an explicit timeout wins (hooks use 1.5 s)');
  // A hub that accepts the request and never answers.
  const server = createServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = remoteClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 't', { timeoutMs: 200 });
    const t = Date.now();
    await assert.rejects(client['task.get']({ id: 't-x' } as never), /timeout|aborted/i);
    assert.ok(Date.now() - t < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the hub lock lets one hub run per home, survives races, and takes over a dead or reused owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ym-lock-'));
  try {
    const file = join(dir, 'hub.lock');
    const release = await acquireHubLock(file);
    await assert.rejects(acquireHubLock(file), HubAlreadyRunning);
    release();
    (await acquireHubLock(file))();

    // Two hubs starting at the same moment: exactly one wins.
    const both = await Promise.allSettled([acquireHubLock(file), acquireHubLock(file)]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of both) if (r.status === 'fulfilled') r.value();

    // Three hubs at once over a stale lock: still exactly one winner, never two.
    writeFile(file, '999999999 1\n');
    const three = await Promise.allSettled([acquireHubLock(file), acquireHubLock(file), acquireHubLock(file)]);
    assert.equal(three.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of three) if (r.status === 'fulfilled') r.value();

    // The owner exited.
    writeFile(file, '999999999 1\n');
    const dead = await acquireHubLock(file);
    assert.equal(readFileSync(file, 'utf8').split(' ')[0], String(process.pid));
    dead();

    // The pid is alive but belongs to a process that started later than the lock says (a reused pid).
    writeFile(file, `${process.ppid} 1\n`);
    (await acquireHubLock(file))();

    // A half-written lock from someone starting right now is respected.
    writeFile(file, '');
    await assert.rejects(acquireHubLock(file), HubAlreadyRunning);
    rmSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task's own checks run in addition to the project's, never instead of them", () => {
  assert.deepEqual(verifyCommands({ verify: null }, { verify: ['npm test'] }), ['npm test']);
  assert.deepEqual(verifyCommands({ verify: ['true'] }, { verify: ['npm test'] }), ['npm test', 'true']);
  assert.deepEqual(verifyCommands({ verify: ['npm test', 'npm run e2e'] }, { verify: ['npm test'] }), ['npm test', 'npm run e2e']);
  assert.ok(resolveConfig([{}]).hotFiles.includes('yardmaster.json'), 'changes to the checks themselves always get a review');
});

test('a plan printed over many lines by a plain CLI agent is read whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ym-plan-'));
  try {
    const script = join(dir, 'plan.sh');
    writeFile(script, `cat > /dev/null\nprintf '{\\n  "tasks": [\\n    {"key": "a", "title": "Add the CSV export", "prompt": "Add CSV export to reports", "files": ["src/report.ts"]}\\n  ]\\n}\\n'\n`);
    const config = resolveConfig([{ agents: { planbot: { command: `sh ${script}` } } }]);
    const plan = await planGoal('add csv export', { cwd: dir, agent: 'planbot', config });
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0]!.title, 'Add the CSV export');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quick checks still run for a task that adds its own checks', () => {
  const config = resolveConfig([{ verify: ['npm test'], verifyQuick: ['eslint {files}'] }]);
  const task = { verify: ['npm run e2e'] } as Parameters<typeof taskChecks>[0];
  assert.deepEqual(taskChecks(task, config, ['a.ts']), ['eslint a.ts', 'npm run e2e']);
});

test('Ctrl-C during planning stops the planner instead of leaving it running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ym-plan-int-'));
  try {
    const script = join(dir, 'slow.sh');
    writeFile(script, 'cat > /dev/null\nsleep 30\n');
    const config = resolveConfig([{ agents: { slowbot: { command: `sh ${script}` } } }]);
    const started = Date.now();
    const plan = planGoal('anything', { cwd: dir, agent: 'slowbot', config });
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 500);
    await assert.rejects(plan, /interrupted/);
    assert.ok(Date.now() - started < 10_000, 'it stopped right away, not after the agent finished');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package.json and src/version.ts carry the same version (release tags must match both)', async () => {
  const { VERSION } = await import('../src/version.ts');
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test('config typos are reported with the setting that was probably meant', () => {
  const problems = unknownSettings({ budget: { daily: 1 }, maxparallel: 9, reveiw: { mode: 'never' }, agents: { claude: { modle: 'x' } }, $schema: 'x', '// note': 'ok', retry: { escalate: true } });
  assert.deepEqual(problems, [
    '"budget.daily" is not a Yardmaster setting; did you mean "budget.dailyUsd"?',
    '"maxparallel" is not a Yardmaster setting; did you mean "maxParallel"?',
    '"reveiw" is not a Yardmaster setting; did you mean "review"?',
    '"agents.claude.modle" is not a Yardmaster setting; did you mean "agents.claude.models"?',
  ]);
  assert.deepEqual(unknownSettings({ zzzzqqq: 1 }), ['"zzzzqqq" is not a Yardmaster setting']);
  const inList = unknownSettings({ policies: [{ set: { teir: 'strong' } }] });
  assert.equal(inList.length, 1);
  assert.match(inList[0]!, /"policies\[0\]\.set\.teir" is not a Yardmaster setting; did you mean "policies\[0\]\.set\.tier"\?/);
  assert.deepEqual(unknownSettings({ maxParallel: 2, budget: { dailyUsd: 5 } }), []);
});

test('many processes opening a new database at once all succeed; a newer schema is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ym-db-'));
  try {
    const file = join(dir, 'y.db');
    const src = join(import.meta.dirname, '..', 'src', 'db.ts');
    const code = `import { openDb } from ${JSON.stringify(src)}; openDb(${JSON.stringify(file)}).close();`;
    const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise<number>((res) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
      p.on('close', (c) => res(c ?? 1));
    })));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    const db = openDb(file);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    db.close();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    raw.close();
    assert.throws(() => openDb(file), /newer Yardmaster/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('small tasks with checks start cheap; broad, unchecked or long ones do not', () => {
  assert.equal(isSmallCheckedTask(['src/a.ts'], 'Fix the off-by-one in the pager', true), true);
  assert.equal(isSmallCheckedTask(['src/a.ts', 'src/b.ts', 'test/a.test.ts'], 'Add a flag', true), true);
  assert.equal(isSmallCheckedTask(['src/a.ts'], 'Fix it', false), false, 'without checks a cheap model has no safety net');
  assert.equal(isSmallCheckedTask(['src/**'], 'Fix it', true), false, 'a whole tree is not small');
  assert.equal(isSmallCheckedTask(['a', 'b', 'c', 'd'], 'Fix it', true), false);
  assert.equal(isSmallCheckedTask([], 'Fix it', true), false, 'unknown scope is not small');
  assert.equal(isSmallCheckedTask(['src/a.ts'], 'x'.repeat(601), true), false);
});

test('agents never get the hub token; method names come only from the API; the home folder is private', async () => {
  process.env.YARDMASTER_TOKEN = 'secret-value';
  try {
    assert.equal(cleanEnv().YARDMASTER_TOKEN, undefined);
  } finally {
    delete process.env.YARDMASTER_TOKEN;
  }
  await assert.rejects(dispatch({} as never, 'constructor', {}), /Unknown method constructor/);
  await assert.rejects(dispatch({} as never, 'toString', {}), /Unknown method/);
  const before = process.env.YARDMASTER_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'ym-home-'));
  process.env.YARDMASTER_HOME = join(dir, 'h');
  try {
    assert.equal(statSync(yardHome()).mode & 0o777, 0o700);
  } finally {
    if (before === undefined) delete process.env.YARDMASTER_HOME;
    else process.env.YARDMASTER_HOME = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex output tokens already include reasoning, so reasoning is not added again', () => {
  const [ev] = codex.parse(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 300, reasoning_output_tokens: 120 } }));
  assert.deepEqual(ev, { type: 'usage', tokensIn: 200, cachedIn: 800, tokensOut: 300, cumulative: false });
  const config = resolveConfig([{}]);
  assert.equal(priceFor(config, 'codex', 'gpt-6-luna').inPerM, 0.1, 'the cheap Codex model has its own price');
  assert.equal(priceFor(config, 'codex', null).outPerM, 10);
});

test('lockfile churn does not make a change "large" for review', async () => {
  const dir = tempDir('ym-review-');
  try {
    const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@e.com'); sh('config', 'user.name', 'T');
    write(join(dir, 'a.js'), 'x\n'); sh('add', '-A'); sh('commit', '-qm', 'base');
    write(join(dir, 'package-lock.json'), Array.from({ length: 5000 }, (_, i) => `"line${i}"`).join('\n'));
    write(join(dir, 'a.js'), 'x\ny\n'); sh('add', '-A'); sh('commit', '-qm', 'bump');
    assert.equal(await changedLineCount(dir, 'HEAD~1'), 1);
  } finally {
    rmrf(dir, { recursive: true, force: true });
  }
});
