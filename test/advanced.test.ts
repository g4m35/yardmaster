import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sandbox, sh, tempDir, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { remoteClient } from '../src/api.ts';
import { editedPaths, runHook } from '../src/hook.ts';
import { importGraph, coupling } from '../src/imports.ts';
import { listLessons } from '../src/lessons.ts';
import { applyPolicies } from '../src/policies.ts';
import { resolveConfig } from '../src/config.ts';
import type { Task } from '../src/types.ts';

/** Orchestration that makes agents better: rules, review, lessons, critical path, races, trains, coupling, hooks. */

let hub: Hub | null = null;
after(async () => {
  await hub?.stop();
});

async function startHub(globalConfig: Record<string, unknown> = {}, projectConfig: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  await hub?.stop();
  const box = sandbox(globalConfig);
  writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'], ...projectConfig }));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(box.repo, f, '..'), { recursive: true });
    writeFileSync(join(box.repo, f), body);
  }
  sh(box.repo, 'git', ['add', '-A']);
  sh(box.repo, 'git', ['commit', '-qm', 'setup']);
  hub = new Hub({ db: openDb(join(box.home, 'y.db')), token: 'tok', machineId: `m-hub-${Date.now()}`, port: 0, host: '127.0.0.1', includeMock: true, tickMs: 150, quiet: true });
  await hub.start();
  const project = await hub.coord.registerProject(box.repo);
  const h = hub;
  const add = (tasks: Parameters<Hub['coord']['addTasks']>[1]) => h.coord.addTasks(project.id, tasks, 'test').created;
  const get = (id: string) => h.coord.getTask(id)!;
  const settle = (ids: string[], ms = 40_000) => until(() => ids.map(get), (ts) => ts.every((t) => ['done', 'needs_human', 'failed', 'canceled'].includes(t.status)), ms, 'settle');
  const onIntegration = (path: string) => {
    try {
      return sh(box.repo, 'git', ['show', `yardmaster/integration:${path}`]);
    } catch {
      return null;
    }
  };
  const events = () => h.coord.eventsSince(0, null, 1000);
  return { ...box, hub: h, project, add, get, settle, onIntegration, events };
}

test('policies shape tasks by what they touch: model size, review, house rules', async () => {
  const cfg = resolveConfig([{ policies: [
    { name: 'auth is sensitive', when: { files: ['src/auth/**'] }, set: { tier: 'strong', review: 'always', guidance: 'Never log tokens or passwords.' } },
    { name: 'docs are cheap', when: { text: 'readme|docs?\\b' }, set: { tier: 'cheap', review: 'never' } },
    { name: 'everything', when: {}, set: { guidance: 'Prefer small diffs.', tier: 'standard' } },
  ] }]);
  const auth = applyPolicies(cfg, { title: 'Add rate limiting to login', prompt: '', scope: ['src/auth/login.ts'], tier: 'standard', createdBy: 'cli' });
  assert.equal(auth.effects.tier, 'strong', 'first matching rule wins a field');
  assert.equal(auth.effects.review, 'always');
  assert.equal(auth.effects.guidance, 'Never log tokens or passwords.\nPrefer small diffs.', 'guidance from every rule is combined');
  assert.deepEqual(auth.matched, ['auth is sensitive', 'everything']);
  const docs = applyPolicies(cfg, { title: 'Fix README typos', prompt: '', scope: ['README.md'], tier: 'standard', createdBy: 'cli' });
  assert.equal(docs.effects.tier, 'cheap');

  const s = await startHub({}, { policies: [{ name: 'auth', when: { files: ['src/auth/**'] }, set: { tier: 'strong', guidance: 'Never log tokens.', requireApproval: true } }] });
  s.hub.worker.stopAll('shutdown', 'test');
  const [t] = s.add([{ title: 'Harden the session cookie', prompt: '@mock write src/auth/cookie.js x', files: ['src/auth/**'], agent: 'mock' }]);
  assert.equal(t!.tier, 'strong');
  assert.equal(t!.needs_approval, true);
  assert.deepEqual(t!.policies, ['auth']);
  const ctx = await s.hub.client['task.context']({ id: t!.id });
  assert.equal(ctx.guidance, 'Never log tokens.');
});

test('a second model reviews the change; requested fixes go back to the implementer and become lessons', async () => {
  const s = await startHub();
  const [t] = s.add([{ title: 'Parse the CSV upload', prompt: '@mock write csv.js export const parse = (s) => s.split(",")\n@mock-review 0 changes Handle an empty upload instead of returning [""]', agent: 'mock', review: 'always' }]);
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'done', final!.attention ?? '');
  assert.equal(final!.review_rounds, 1, 'one round of changes was requested');
  assert.equal(final!.attempts, 1, 'a review round is not a failed attempt');
  const reviews = s.hub.coord.runsFor(t!.id).filter((r) => r.role === 'review');
  assert.equal(reviews.length, 2);
  assert.equal(JSON.parse(reviews[0]!.verdict!).verdict, 'request_changes');
  assert.equal(JSON.parse(reviews[1]!.verdict!).verdict, 'approve');
  assert.ok(s.events().some((e) => e.kind === 'task.review_changes'));
  const lessons = listLessons(s.hub.coord, s.project.id);
  assert.ok(lessons.some((l) => l.source === 'review' && /empty upload/.test(l.text)), JSON.stringify(lessons));
});

test('fixed failures and your redirects become lessons that brief related work, and get credit when they help', async () => {
  const s = await startHub();
  const [first] = s.add([{ title: 'Build the invoice totals', prompt: '@mock attempt 1 write billing/totals.js BROKEN\n@mock attempt 2 write billing/totals.js export const total = 1', files: ['billing/**'], agent: 'mock' }]);
  await s.settle([first!.id]);
  const fix = listLessons(s.hub.coord, s.project.id).find((l) => l.source === 'fix');
  assert.ok(fix, 'a lesson was learned from the fixed failure');
  assert.match(fix!.text, /BROKEN found in billing\/totals.js/);
  s.hub.worker.stopAll('shutdown', 'test');
  const [second] = s.add([{ title: 'Add tax to invoice totals', prompt: 'x', files: ['billing/tax.js'], agent: 'mock' }]);
  const ctx = await s.hub.client['task.context']({ id: second!.id });
  assert.match(ctx.lessons, /What fixed it/);
  s.hub.coord.control(second!.id, 'redirect', 'you', 'Use integer cents for all money math, never floats.');
  const you = listLessons(s.hub.coord, s.project.id).find((l) => l.source === 'you');
  assert.ok(you && /integer cents/.test(you.text));
  const [third] = s.add([{ title: 'Add discounts to billing', prompt: 'apply percentage discounts to invoice totals', files: ['billing/discounts.js'], agent: 'mock' }]);
  const ctx3 = await s.hub.client['task.context']({ id: third!.id });
  assert.match(ctx3.lessons, /integer cents/, 'owner guidance generalizes to related work');
});

test('critical path: the task that unblocks the most work starts first', async () => {
  const s = await startHub({ maxParallel: 1 });
  s.hub.coord.setPaused(null, true, 'test');
  const created = s.add([
    { key: 'leaf', title: 'Polish the footer text', prompt: '@mock write footer.txt ok', agent: 'mock' },
    { key: 'root', title: 'Create the data model', prompt: '@mock write model.js m', agent: 'mock' },
    { key: 'mid', title: 'Build the repository layer', prompt: '@mock write repo.js r', after: ['root'], agent: 'mock' },
    { key: 'top', title: 'Expose the API endpoints', prompt: '@mock write api.js a', after: ['mid'], agent: 'mock' },
  ]);
  s.hub.coord.setPaused(null, false, 'test');
  await s.settle(created.map((t) => t.id));
  const started = (t: Task) => s.hub.coord.runsFor(t.id)[0]!.started_at;
  assert.ok(started(created[1]!) < started(created[0]!), 'the root of the longest chain ran before the older leaf task');
});

test('best-of-N: agents race on one task, the first verified result wins and dependents follow it', async () => {
  const s = await startHub();
  const created = s.add([
    { key: 'r', title: 'Optimize the search ranking', prompt: '@mock unless-prompt (try sleep 4000\n@mock write rank.js export const rank = 1', files: ['rank.js'], agent: 'mock', bestOf: 2 },
    { title: 'Document the ranking', prompt: '@mock write RANKING.md how it works', after: ['r'], agent: 'mock' },
  ]);
  assert.equal(created.length, 3, 'two racers and the follow-up');
  const racers = created.filter((t) => t.race_group);
  assert.equal(racers.length, 2);
  const docs = created.find((t) => !t.race_group)!;
  const all = await s.settle(created.map((t) => t.id), 60_000);
  const winner = all.find((t) => t.race_group && t.status === 'done');
  const loser = all.find((t) => t.race_group && t.status === 'canceled');
  assert.ok(winner && loser, JSON.stringify(all.map((t) => [t.title, t.status])));
  assert.match(winner!.title, /\(try 2\)/, 'the faster racer won');
  assert.equal(s.get(docs.id).status, 'done', 'the dependent task followed the winner');
  assert.ok(s.events().some((e) => e.kind === 'race.lost'));
});

test('merge train: several verified tasks are checked together once', async () => {
  const s = await startHub({}, { integration: { requireApproval: true, trainSize: 4 } });
  const created = s.add([
    { title: 'Add the alpha module', prompt: '@mock write alpha.js a', agent: 'mock' },
    { title: 'Add the beta module', prompt: '@mock write beta.js b', agent: 'mock' },
    { title: 'Add the gamma module', prompt: '@mock write gamma.js c', agent: 'mock' },
  ]);
  await until(() => created.map((t) => s.get(t.id)), (ts) => ts.every((t) => t.status === 'ready'), 30_000, 'all ready');
  for (const t of created) s.hub.coord.control(t.id, 'approve', 'test');
  const final = await s.settle(created.map((t) => t.id));
  assert.deepEqual(final.map((t) => t.status), ['done', 'done', 'done']);
  const trains = s.events().filter((e) => e.kind === 'integration.train_merged');
  assert.equal(trains.length, 1, JSON.stringify(s.events().map((e) => e.kind)));
  for (const f of ['alpha.js', 'beta.js', 'gamma.js']) assert.ok(s.onIntegration(f));
});

test('import-graph coupling: work on a file another task imports is briefed or kept apart', async () => {
  const repoFiles = { 'src/api.js': 'export const get = () => 1;\n', 'src/ui.js': "import { get } from './api.js';\nexport const view = () => get();\n", 'src/other.js': 'export const x = 1;\n' };
  const box = tempDir('ym-graph-');
  sh(box, 'git', ['init', '-q', '-b', 'main']);
  for (const [f, b] of Object.entries(repoFiles)) {
    mkdirSync(join(box, 'src'), { recursive: true });
    writeFileSync(join(box, f), b);
  }
  sh(box, 'git', ['add', '-A']);
  sh(box, 'git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i']);
  const g = await importGraph(box);
  assert.deepEqual([...g.deps.get('src/ui.js')!], ['src/api.js']);
  assert.equal(coupling(g, ['src/ui.js'], ['src/api.js'])[0]?.direction, 'imports');
  assert.equal(coupling(g, ['src/other.js'], ['src/api.js']).length, 0);

  const s = await startHub({ coupling: 'serialize' }, {}, repoFiles);
  await until(() => s.hub.coord.graphs.has(s.project.id), (v) => v, 10_000, 'graph built');
  const [api, ui] = s.add([
    { title: 'Change the API client signature', prompt: '@mock write src/api.js export const get = (id) => id;\n@mock sleep 1500', files: ['src/api.js'], agent: 'mock', priority: 1 },
    { title: 'Restyle the view', prompt: '@mock write src/ui.js export const view = () => 2;', files: ['src/ui.js'], agent: 'mock' },
  ]);
  await until(() => s.get(api!.id), (t) => t.status === 'running', 10_000, 'api running');
  await until(() => s.hub.coord.blocker(s.get(ui!.id)), (b) => !!b && /imports/.test(b), 5000, 'ui waits on the import');
  const ctx = await s.hub.client['task.context']({ id: ui!.id });
  assert.ok(ctx.coupling.some((c) => /src\/ui.js imports src\/api.js/.test(c)), JSON.stringify(ctx.coupling));
  const final = await s.settle([api!.id, ui!.id]);
  assert.deepEqual(final.map((t) => t.status), ['done', 'done']);
});

test('hooks coordinate an interactive session with zero tool calls', async () => {
  const s = await startHub();
  s.hub.worker.stopAll('shutdown', 'test');
  const client = async () => remoteClient(s.hub.url, 'tok');
  const base = { cwd: s.repo, session_id: 'sess-123' };
  const start = await runHook('session-start', JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), client);
  const ctx = JSON.parse(start.stdout!).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /Yardmaster coordinates/);
  // Nothing changed: the prompt hook stays silent (no tokens).
  assert.equal((await runHook('prompt', JSON.stringify(base), client)).stdout, undefined);
  s.add([{ title: 'Background docs pass', prompt: 'x', agent: 'mock' }]);
  const upd = await runHook('prompt', JSON.stringify(base), client);
  assert.match(JSON.parse(upd.stdout!).hookSpecificOutput.additionalContext, /Background docs pass/);
  // Editing reserves the file for this session; another session's edit of it is blocked.
  await runHook('post-edit', JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { file_path: join(s.repo, 'notes.md') } }), client);
  assert.ok(s.hub.coord.whoHas(s.project.id, ['notes.md']).length);
  mkdirSync(join(s.repo, 'pkg'), { recursive: true });
  const blocked = await runHook('pre-edit', JSON.stringify({ cwd: join(s.repo, 'pkg'), session_id: 'other', tool_name: 'Write', tool_input: { file_path: join(s.repo, 'notes.md') } }), client);
  assert.equal(blocked.code, 2);
  const mine = await runHook('pre-edit', JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: join(s.repo, 'notes.md') } }), client);
  assert.equal(mine.code, 0, 'the session that holds the file can keep editing');
  // Paths through a symlink (/tmp vs /private/tmp on macOS) must still be recognized as inside the repo.
  const { symlinkSync } = await import('node:fs');
  const alias = join(tempDir('ym-alias-'), 'repo-link');
  symlinkSync(s.repo, alias);
  const viaLink = await runHook('pre-edit', JSON.stringify({ cwd: join(alias, 'pkg'), session_id: 'other2', tool_name: 'Write', tool_input: { file_path: join(alias, 'notes.md') } }), client);
  assert.equal(viaLink.code, 2, 'a held file is protected even when reached through a symlinked path');
  // Codex sends edits as apply_patch text.
  assert.deepEqual(editedPaths({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch' } }), ['src/a.ts', 'src/b.ts']);
  // Hub down or repo unknown: hooks never get in the way.
  assert.equal((await runHook('pre-edit', JSON.stringify({ ...base, tool_input: { file_path: 'x' } }), async () => null)).code, 0);
});

test('connect installs hooks and the skill without disturbing existing settings', async () => {
  const home = tempDir('ym-home-');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { installHooks, installSkill } = await import('../src/connect.ts');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] } }));
    installHooks('claude');
    installHooks('claude');
    const cfg = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.hooks.PreToolUse.length, 2, 'user hook kept, ours added once');
    assert.ok(JSON.stringify(cfg.hooks.PreToolUse).includes('my-guard.sh'));
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) assert.equal(cfg.hooks[ev].length, 1);
    // A standalone install (~/.local/bin/ym) must be recognized too, or reconnecting would duplicate hooks.
    const { isOurHookGroup } = await import('../src/connect.ts');
    for (const cmd of ['/home/a/.local/bin/ym hook session-start', 'ym hook prompt', '"/Users/x/My Tools/node" "/Users/x/lib/node_modules/yardmaster/dist/cli.js" hook pre-edit', '/usr/bin/node /src/cli.ts hook post-edit']) {
      assert.ok(isOurHookGroup({ hooks: [{ type: 'command', command: cmd }] }), cmd);
    }
    for (const cmd of ['my-guard.sh', '~/.claude/hooks/secret-scan.sh', 'echo hook prompt-check', 'ym-other hook prompt']) {
      assert.ok(!isOurHookGroup({ hooks: [{ type: 'command', command: cmd }] }), cmd);
    }
    installHooks('codex');
    assert.ok(existsSync(join(home, '.codex', 'hooks.json')));
    const dirs = installSkill();
    for (const d of dirs) assert.match(readFileSync(join(d, 'SKILL.md'), 'utf8'), /^---\nname: yardmaster/);
  } finally {
    process.env.HOME = prevHome;
  }
});

test('minimal MCP profile exposes a single tool for clients that load every definition', async () => {
  const s = await startHub();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'mcp'],
    cwd: s.repo,
    env: { ...(process.env as Record<string, string>), YARDMASTER_HUB: s.hub.url, YARDMASTER_TOKEN: 'tok', YARDMASTER_MCP_PROFILE: 'minimal' },
    stderr: 'pipe',
  });
  const mcp = new McpClient({ name: 't', version: '1' });
  await mcp.connect(transport);
  try {
    const tools = (await mcp.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), ['yard']);
    assert.ok(JSON.stringify(tools[0]!.inputSchema).length < 2000, 'small definition');
    const r = await mcp.callTool({ name: 'yard', arguments: { action: 'learn', input: { text: 'The e2e suite needs npm run build first.', files: ['e2e/**'] } } });
    assert.match((r.content as { text: string }[])[0]!.text, /Saved/);
    const bad = await mcp.callTool({ name: 'yard', arguments: { action: 'claim_files', input: {} } });
    assert.equal(bad.isError, true);
  } finally {
    await mcp.close();
  }
});

test('warm start: new worktrees get installed dependencies without reinstalling', async () => {
  const s = await startHub({}, {}, { '.gitignore': 'node_modules/\n', 'src/app.js': 'export const x = 1;\n' });
  mkdirSync(join(s.repo, 'node_modules', 'leftpad'), { recursive: true });
  writeFileSync(join(s.repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');
  // The agent fails unless the dependency is already there (as if `npm test` needed node_modules).
  const [t] = s.add([{ title: 'Use the leftpad dependency', prompt: '@mock write src/use.js uses leftpad', agent: 'mock', verify: ['test -f node_modules/leftpad/index.js'] }]);
  const [final] = await s.settle([t!.id]);
  assert.equal(final!.status, 'done', final!.attention ?? '');
  assert.ok(s.events().some((e) => e.kind === 'task.warm_start' && /node_modules/.test(e.message)));
  assert.equal(readFileSync(join(s.repo, 'node_modules', 'leftpad', 'index.js'), 'utf8'), 'module.exports = 1;\n', 'the original is untouched');
  assert.equal(s.onIntegration('node_modules/leftpad/index.js'), null, 'dependencies are never committed');
});

test('quick checks run per task on changed files; the full suite runs at merge', async () => {
  // The full suite fails on purpose; the quick, change-scoped check passes.
  const s = await startHub({}, { verify: ['node check.mjs', 'echo full suite failed && false'], verifyQuick: ['test -n "$(echo {files})" && echo quick ok for {files}'] });
  const [t] = s.add([{ title: 'Change one module', prompt: '@mock write mod.js m', agent: 'mock' }]);
  const [final] = await s.settle([t!.id], 60_000);
  assert.equal(final!.status, 'needs_human', 'a change that only fails the full suite is stopped');
  assert.match(final!.attention!, /breaks when combined/);
  assert.equal(final!.attempts, 2, 'stopped on the second identical merge-time failure, not after every attempt');
  assert.equal(s.onIntegration('mod.js'), null, 'nothing that fails the full suite lands');
  assert.ok(s.events().filter((e) => e.kind === 'task.ready').length >= 1, 'quick checks passed in the worktree');
});

test('the brief includes a map of how owned files connect to the code', async () => {
  const files = { 'src/api.js': 'export const get = () => 1;\n', 'src/ui.js': "import { get } from './api.js';\nexport const v = get();\n" };
  const s = await startHub({}, {}, files);
  await until(() => s.hub.coord.graphs.has(s.project.id), (v) => v, 10_000, 'graph');
  s.hub.worker.stopAll('shutdown', 'test');
  const [t] = s.add([{ title: 'Add caching to the API client', prompt: 'x', files: ['src/api.js'], agent: 'mock' }]);
  const ctx = await s.hub.client['task.context']({ id: t!.id });
  assert.deepEqual(ctx.map, ['src/api.js used by src/ui.js']);
});
