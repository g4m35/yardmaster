import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { cloneTree, removeFast, removeWorktreeFast } from '../src/fastfs.ts';
import { clonesAreFree, lockHash, warmStart } from '../src/warmstart.ts';
import { claude, codex, CLAUDE_CODING_TOOLS } from '../src/adapters/builtin.ts';
import { UsageMeter } from '../src/usage.ts';
import { defaultAgentSettings, loadConfig, resolveConfig, verifySlotsFor } from '../src/config.ts';
import { importGraph } from '../src/imports.ts';
import { buildReport } from '../src/report.ts';
import { dedupeGroup, restoreLatest, scanDeps } from '../src/devdeps.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import type { Task } from '../src/types.ts';

/** Speed and cost: fast clones and deletes, lockfile-aware dependency reuse, lean launches, resume, accounting. */

let hub: Hub | null = null;
after(async () => {
  await hub?.stop();
});

function fakeInstall(dir: string, files: number, marker = 'v1') {
  for (let i = 0; i < files; i++) {
    const d = join(dir, 'node_modules', `pkg${i % 20}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${i}.js`), `module.exports = ${i}; // ${marker}\n`);
  }
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ name: 'demo', marker }));
}

// ---------- fast clone and delete ----------

test('cloneTree copies a whole folder and removeFast deletes without waiting', async () => {
  const root = tempDir('ym-fastfs-');
  fakeInstall(root, 400);
  const r = await cloneTree(join(root, 'node_modules'), join(root, 'copy', 'node_modules'), { allowPlainCopy: true });
  assert.equal(r.ok, true, r.error);
  if (process.platform === 'darwin') assert.equal(r.method, 'clonefile', 'APFS: one clonefile call for the whole tree');
  assert.equal(readFileSync(join(root, 'copy', 'node_modules', 'pkg3', 'f3.js'), 'utf8'), readFileSync(join(root, 'node_modules', 'pkg3', 'f3.js'), 'utf8'));
  // The clone is independent of the original.
  writeFileSync(join(root, 'copy', 'node_modules', 'pkg3', 'f3.js'), 'changed');
  assert.match(readFileSync(join(root, 'node_modules', 'pkg3', 'f3.js'), 'utf8'), /= 3;/);
  const trash = join(root, '.trash');
  const started = Date.now();
  removeFast(join(root, 'copy', 'node_modules'), trash);
  assert.ok(Date.now() - started < 500, 'the caller does not wait for the delete');
  assert.ok(!existsSync(join(root, 'copy', 'node_modules')));
  await until(() => readdirSync(trash).length, (n) => n === 0, 15_000, 'background delete');
});

test('removing a worktree fast forgets only its own git record', async () => {
  const root = tempDir('ym-wtfast-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['commit', '-q', '--allow-empty', '-m', 'init']);
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'a', join(root, 'wt', 'a')]);
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'b', join(root, 'wt', 'b')]);
  // Someone else's worktree that is merely missing (an unplugged drive): its record must survive.
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'c', join(root, 'elsewhere', 'c')]);
  sh(root, 'mv', [join(root, 'elsewhere'), join(root, 'unplugged')]);
  removeWorktreeFast(repo, join(root, 'wt', 'a'), join(root, '.trash'));
  const list = sh(repo, 'git', ['worktree', 'list']);
  assert.doesNotMatch(list, /wt\/a/);
  assert.match(list, /wt\/b/);
  assert.match(list, /elsewhere\/c/, 'other missing worktrees are not pruned');
  sh(repo, 'git', ['branch', '-D', 'a']);
});

// ---------- lockfile-aware dependency reuse ----------

test('warm start takes dependencies from a checkout with the same lockfiles, and says when none match', async () => {
  const box = sandbox();
  const config = loadConfig(box.repo);
  writeFileSync(join(box.repo, 'package-lock.json'), '{"lockfileVersion":3,"v":"old"}');
  fakeInstall(box.repo, 30, 'old');
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n');
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-q', '-m', 'deps']);
  // A sibling worktree that already installed the new lockfile.
  const group = join(box.root, 'worktrees', 'demo');
  sh(box.repo, 'git', ['worktree', 'add', '-q', '-b', 'newdeps', join(group, 'w1')]);
  writeFileSync(join(group, 'w1', 'package-lock.json'), '{"lockfileVersion":3,"v":"new"}');
  fakeInstall(join(group, 'w1'), 30, 'new');
  sh(join(group, 'w1'), 'git', ['commit', '-qam', 'bump']);
  // New task worktree on that commit: it must get the matching (new) install, not the checkout's old one.
  sh(box.repo, 'git', ['worktree', 'add', '-q', '-b', 'task', join(group, 'w2'), 'newdeps']);
  const r = await warmStart(box.repo, join(group, 'w2'), config, { candidates: [join(group, 'w1')] });
  assert.equal(r.source, join(group, 'w1'));
  assert.equal(r.stale, false);
  assert.match(readFileSync(join(group, 'w2', 'node_modules', '.package-lock.json'), 'utf8'), /new/);
  assert.equal(lockHash(join(group, 'w2')), lockHash(join(group, 'w1')));
  // No candidate matches: falls back to the checkout and flags it.
  sh(box.repo, 'git', ['worktree', 'add', '-q', '-b', 'task2', join(group, 'w3'), 'newdeps']);
  const fallback = await warmStart(box.repo, join(group, 'w3'), config);
  assert.equal(fallback.source, box.repo);
  assert.equal(fallback.stale, true);
});

// ---------- lean, effort, budget and resume flags ----------

test('Claude Code runs lean by default: no MCP, skills or optional tools; effort follows the tier', () => {
  const settings = defaultAgentSettings({ models: { cheap: 'haiku' } });
  const spec = claude.build({ prompt: 'x', cwd: '/w', model: 'haiku', settings, tier: 'cheap', budgetUsd: 2.5, session: { pin: 'abc' } });
  const a = spec.args.join(' ');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--session-id abc', '--effort low', '--max-budget-usd 2.50']) assert.ok(a.includes(f), `missing ${f} in ${a}`);
  assert.ok(a.includes(`--tools ${CLAUDE_CODING_TOOLS.join(',')}`));
  assert.equal(spec.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  const full = claude.build({ prompt: 'x', cwd: '/w', model: null, settings: defaultAgentSettings({ context: 'full', effort: { strong: '' } }), tier: 'strong', session: { resume: 'prev' } });
  const b = full.args.join(' ');
  assert.ok(b.includes('--resume prev'));
  assert.ok(!b.includes('--strict-mcp-config') && !b.includes('--tools') && !b.includes('--effort'), 'full context and an empty effort leave everything to the user');
  const mcp = claude.build({ prompt: 'x', cwd: '/w', model: null, settings: defaultAgentSettings({ mcpConfig: '/me/mcp.json' }) }).args.join(' ');
  assert.ok(mcp.includes('--mcp-config /me/mcp.json'), 'chosen MCP servers can be kept in lean runs');
});

test('Codex resumes with exec resume and gets effort and sandbox as config', () => {
  const fresh = codex.build({ prompt: 'x', cwd: '/w', model: 'gpt-5.5', settings: defaultAgentSettings(), tier: 'strong' }).args;
  assert.deepEqual(fresh.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-C', '/w']);
  assert.ok(fresh.join(' ').includes('-c model_reasoning_effort="high"'));
  const resumed = codex.build({ prompt: 'x', cwd: '/w', model: null, settings: defaultAgentSettings(), session: { resume: 'thread-1' } }).args;
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.ok(resumed.includes('-c') && resumed.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(resumed.slice(-2), ['thread-1', '-']);
  assert.deepEqual(codex.parse('{"type":"thread.started","thread_id":"t-9"}'), [{ type: 'session', id: 't-9' }]);
  assert.deepEqual(claude.parse('{"type":"system","subtype":"init","session_id":"s-1"}'), [{ type: 'session', id: 's-1' }]);
});

// ---------- accounting ----------

test('usage is counted once per API message, and resumed totals exclude earlier spend', () => {
  const m = new UsageMeter({ inPerM: 3, outPerM: 15 });
  const ev = { type: 'usage' as const, tokensIn: 1000, tokensOut: 100, cumulative: false, id: 'msg_1' };
  m.add(ev);
  m.add(ev); // the same message again (one copy per content block)
  m.add({ ...ev, id: 'msg_2' });
  assert.equal(m.tokensIn, 2000);
  assert.ok(Math.abs(m.spent - 2 * (1000 * 3 + 100 * 15) / 1e6) < 1e-12);
  const resumed = new UsageMeter({ inPerM: 3, outPerM: 15 }, 0.4);
  resumed.add({ type: 'usage', tokensIn: 0, tokensOut: 0, cumulative: true, costUsd: 0.55 });
  assert.ok(Math.abs(resumed.spent - 0.15) < 1e-9, 'only this run');
  assert.ok(Math.abs(resumed.sessionTotal - 0.55) < 1e-9);
});

test('check slots scale with cores and stay within maxParallel', () => {
  assert.equal(verifySlotsFor({ maxParallel: 3 }, 10), 2);
  assert.equal(verifySlotsFor({ maxParallel: 3 }, 2), 1);
  assert.equal(verifySlotsFor({ maxParallel: 2 }, 32), 2);
  assert.equal(verifySlotsFor({ maxParallel: 6, verifyParallel: 4 }, 2), 4);
  assert.equal(resolveConfig([{}]).agents.claude, undefined, 'lean is a default, not something written into config');
});

// ---------- end to end: resume, merge-time dependencies, phases, report ----------

async function startHub(projectConfig: Record<string, unknown> = {}) {
  await hub?.stop();
  const box = sandbox();
  writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], ...projectConfig }));
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-q', '-m', 'config']);
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok', machineId: `m-hub-${Date.now()}`, port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  await hub.start();
  const h = hub;
  const project = await h.coord.registerProject(box.repo);
  const add = (tasks: Parameters<Hub['coord']['addTasks']>[1]) => h.coord.addTasks(project.id, tasks, 'test').created;
  const get = (id: string) => h.coord.getTask(id)!;
  const settle = (ids: string[], ms = 60_000) => until(() => ids.map(get), (ts) => ts.every((t) => ['done', 'needs_human', 'failed', 'canceled'].includes(t.status)), ms, 'settle');
  return { box, hub: h, project, add, get, settle };
}

test('a retry continues the earlier session with only what is new, and the report shows it', async () => {
  process.env.YARDMASTER_MOCK_RESUMABLE = '1';
  try {
    const s = await startHub();
    const marker = 'BRO' + 'KEN';
    const [t] = s.add([{ title: 'Write the parser', prompt: `@mock attempt 1 write parser.js ${marker}\n@mock attempt 2 write parser.js export const parse = (x) => x;`, agent: 'mock', tier: 'cheap' }]);
    const [final] = await s.settle([t!.id]);
    assert.equal(final!.status, 'done', final!.attention ?? '');
    const runs = s.hub.coord.runsFor(final!.id);
    const impl = runs.filter((r) => r.role === 'implement').sort((a, b) => a.attempt - b.attempt);
    assert.equal(impl.length, 2);
    assert.equal(impl[0]!.resumed, false);
    assert.equal(impl[1]!.resumed, true, 'the retry continued the first session');
    assert.ok((impl[1]!.phases.agent ?? -1) >= 0 && impl[1]!.phases.prepare !== undefined, `phases recorded: ${JSON.stringify(impl[1]!.phases)}`);
    const transcript = readFileSync(join(tmpdir(), 'ym-mock-sessions', `${final!.agent_session}.txt`), 'utf8');
    assert.equal(transcript.split('## Rules').length - 1, 1, 'the full brief was sent once, not again on the retry');
    assert.match(transcript, /## Continue this task[\s\S]*Checks failed/);
    const report = buildReport(s.hub.coord.db, { projectId: s.project.id, days: 1 });
    assert.equal(report.tasks.done, 1);
    assert.equal(report.retries.runs, 1);
    assert.equal(report.retries.resumed, 1);
    assert.ok(report.phases.agent !== undefined);
  } finally {
    delete process.env.YARDMASTER_MOCK_RESUMABLE;
  }
});

test('a redirected run is resumed and its spend becomes the new session baseline', async () => {
  process.env.YARDMASTER_MOCK_RESUMABLE = '1';
  try {
    const s = await startHub();
    const [t] = s.add([{ title: 'Implement the importer', prompt: '@mock cost 0.1\n@mock write started.js 1\n@mock unless-prompt GUIDANCE77 sleep 30000\n@mock write result.js ok', agent: 'mock' }]);
    await until(() => existsSync(join(s.get(t!.id).worktree ?? '/nope', 'started.js')), (v) => v, 15_000, 'started');
    s.hub.coord.control(t!.id, 'redirect', 'test', 'GUIDANCE77: skip the slow path');
    const [done] = await s.settle([t!.id]);
    assert.equal(done!.status, 'done', done!.attention ?? '');
    const impl = s.hub.coord.runsFor(t!.id).filter((r) => r.role === 'implement').sort((a, b) => a.started_at - b.started_at);
    assert.equal(impl[0]!.stop_reason, 'redirected');
    assert.equal(impl[1]!.resumed, true, 'the redirect continued the session');
    assert.ok(Math.abs(done!.session_cost - 0.2) < 1e-9, `baseline covers both runs, got ${done!.session_cost}`);
    assert.ok(Math.abs(done!.cost_usd - 0.2) < 1e-9, `each run charged once, got ${done!.cost_usd}`);
  } finally {
    delete process.env.YARDMASTER_MOCK_RESUMABLE;
  }
});

test('merge-time checks run with dependencies installed (they used to fail with none)', async () => {
  const s = await startHub({ verify: ['node node_modules/checker/index.js', 'node check.mjs'], integration: { trainSize: 4 } });
  mkdirSync(join(s.box.repo, 'node_modules', 'checker'), { recursive: true });
  writeFileSync(join(s.box.repo, 'node_modules', 'checker', 'index.js'), 'console.log("deps present")\n');
  writeFileSync(join(s.box.repo, '.gitignore'), 'node_modules/\n');
  sh(s.box.repo, 'git', ['add', '-A']);
  sh(s.box.repo, 'git', ['commit', '-q', '-m', 'ignore deps']);
  const created = s.add([1, 2, 3].map((i) => ({ title: `Add module ${i}`, prompt: `@mock write m${i}.js export const m = ${i};`, agent: 'mock', files: [`m${i}.js`] })));
  const final = await s.settle(created.map((t) => t.id));
  for (const t of final) assert.equal(t.status, 'done', `${t.title}: ${t.attention ?? t.last_error ?? ''}`);
  for (const t of final) assert.equal(t.attempts, 1, 'no attempt was wasted on a merge-time failure');
});

// ---------- import graph ----------

test('the import graph updates incrementally when files change', async () => {
  const box = sandbox();
  mkdirSync(join(box.repo, 'src'));
  writeFileSync(join(box.repo, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
  writeFileSync(join(box.repo, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(box.repo, 'src', 'c.ts'), 'export const c = 1;\n');
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-q', '-m', 'graph']);
  const g1 = await importGraph(box.repo);
  assert.deepEqual([...(g1.deps.get('src/a.ts') ?? [])], ['src/b.ts']);
  writeFileSync(join(box.repo, 'src', 'a.ts'), "import { c } from './c';\nexport const a = c;\n");
  sh(box.repo, 'git', ['commit', '-qam', 'rewire']);
  const g2 = await importGraph(box.repo);
  assert.deepEqual([...(g2.deps.get('src/a.ts') ?? [])], ['src/c.ts']);
  assert.ok(g2.rdeps.get('src/c.ts')?.has('src/a.ts'));
});

// ---------- duplicate installs across projects ----------

test('identical installs elsewhere on the machine can be shared, byte-identical ones only, and restored', async () => {
  sandbox();
  const root = tempDir('ym-dedupe-');
  for (const p of ['one', 'two', 'three', 'four']) {
    mkdirSync(join(root, p));
    writeFileSync(join(root, p, 'package-lock.json'), '{"lockfileVersion":3}');
    fakeInstall(join(root, p), 60, p === 'four' ? 'different' : 'same');
  }
  // Same lockfile and same installed-state record, but a patched file: must never be swapped.
  writeFileSync(join(root, 'three', 'node_modules', 'pkg2', 'f2.js'), 'module.exports = "patched";\n');
  // Tool caches differ in every project and don't count; each project keeps its own.
  for (const p of ['one', 'two']) {
    mkdirSync(join(root, p, 'node_modules', '.vite', 'vitest'), { recursive: true });
    writeFileSync(join(root, p, 'node_modules', '.vite', 'vitest', 'results.json'), `{"project":"${p}"}`);
  }
  const scan = await scanDeps([root]);
  assert.equal(scan.dirs.length, 4);
  assert.equal(scan.identical.length, 1);
  const group = scan.identical[0]!;
  assert.deepEqual(group.dirs.map((d) => d.project.split('/').pop()).sort(), ['one', 'three', 'two']);
  const keep = group.dirs[0]!.project.split('/').pop();
  const cow = await clonesAreFree(root);
  const applied = await dedupeGroup(group);
  if (!cow) {
    assert.equal(applied.replaced.length, 0);
    assert.ok(applied.skipped.every((x) => /can't clone copy-on-write/.test(x.why)), JSON.stringify(applied.skipped));
    return;
  }
  const patched = applied.skipped.find((x) => x.path.includes('/three/'));
  if (keep !== 'three') assert.match(patched?.why ?? '', /packages differ/, 'the patched install is left alone');
  assert.equal(applied.replaced.length, keep === 'three' ? 0 : 1, JSON.stringify(applied.skipped));
  if (keep === 'three') return;
  const target = applied.replaced[0]!.path;
  assert.equal(readFileSync(join(target, 'pkg1', 'f1.js'), 'utf8'), readFileSync(join(root, keep!, 'node_modules', 'pkg1', 'f1.js'), 'utf8'));
  assert.match(readFileSync(join(root, 'three', 'node_modules', 'pkg2', 'f2.js'), 'utf8'), /patched/);
  const owner = target.split('/').slice(-2, -1)[0];
  assert.equal(readFileSync(join(target, '.vite', 'vitest', 'results.json'), 'utf8'), `{"project":"${owner}"}`, 'the project kept its own cache');
  assert.ok(existsSync(applied.replaced[0]!.original), 'the original is kept for undo');
  const undo = restoreLatest();
  assert.deepEqual(undo.restored, [target]);
  assert.ok(existsSync(join(target, 'pkg1', 'f1.js')));
});
