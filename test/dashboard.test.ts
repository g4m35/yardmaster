import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

// Deliberately small DOM fixture, not a layout or native-dialog emulator. Executes the actual
// dashboard code with deterministic RPC/timers. Browserbase owns rendering/keyboard proof.
class Element {
  tagName: string;
  parent: Element | null = null;
  children: Element[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  value = '';
  hidden = false;
  open = false;
  disabled = false;
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection = 'none';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  content?: Element;
  doc: Document;
  text = '';
  constructor(tag: string, doc: Document) { this.tagName = tag.toUpperCase(); this.doc = doc; }
  get id() { return this.attrs.get('id') || ''; }
  get isConnected(): boolean { return this === this.doc.root || !!this.parent?.isConnected; }
  get textContent(): string { return this.text + this.children.map(n => n.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(); this.text = String(text); }
  get lastElementChild() { return this.children.at(-1)!; }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === 'value') this.value = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  append(...children: (Element | string | null)[]) {
    for (const child of children) {
      const node = child instanceof Element ? child : this.doc.createTextNode(String(child));
      if (node.tagName === '#FRAGMENT') { this.append(...node.children); continue; }
      node.parent = this; this.children.push(node);
    }
  }
  replaceChildren(...children: (Element | string | null)[]) {
    for (const child of this.children) child.parent = null;
    this.children = []; this.text = ''; this.append(...children);
  }
  contains(node: Element | null): boolean { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector: string): Element[] {
    const matches = (n: Element) => selector === '[data-focus]' ? n.hasAttribute('data-focus') : selector === 'select[name=after]' ? n.tagName === 'SELECT' && n.getAttribute('name') === 'after' : false;
    return this.children.flatMap(n => [...(matches(n) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  async dispatch(name: string, props = {}) {
    for (const fn of this.listeners.get(name) || []) await fn({ target: this, preventDefault() {}, ...props });
  }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(start: number, end: number, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  showModal() { this.open = true; }
  show() { this.open = true; }
  click() { void this.dispatch('click'); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  close() { this.open = false; void this.dispatch('close'); }
  cloneNode() {
    const n = new Element(this.tagName, this.doc);
    for (const [k, v] of this.attrs) n.setAttribute(k, v);
    n.text = this.text; n.value = this.value;
    n.append(...this.children.map(child => child.cloneNode()));
    return n;
  }
}
class Document {
  root = new Element('html', this);
  body = new Element('body', this);
  activeElement: Element = this.body;
  constructor() { this.root.append(this.body); }
  getElementById(id: string): Element | null {
    const find = (n: Element): Element | null => n.id === id ? n : n.children.map(find).find(Boolean) || null;
    return find(this.root);
  }
  listeners = new Map<string, Function[]>();
  addEventListener(name: string, fn: Function) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  createElement(tag: string) { return new Element(tag, this); }
  createTextNode(text: string) { const n = new Element('#text', this); n.text = text; return n; }
  contains(n: Element) { return this.root.contains(n); }
  querySelectorAll(selector: string) { return this.root.querySelectorAll(selector); }
}
function parse(markup: string, doc: Document) {
  const root = doc.createElement('#fragment'); const stack = [root];
  for (const token of markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1)!.append(token); continue; }
    const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
    const n = doc.createElement(tag);
    for (const a of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) n.setAttribute(a[1]!, a[2] || '');
    stack.at(-1)!.append(n);
    if (!['input', 'br', 'hr', 'meta', 'link'].includes(tag)) stack.push(n);
  }
  return root;
}
const now = Date.now();
function entry(overrides = {}) {
  return { id: 'run:r-one', source: 'run', state: 'managed', agent: 'mock', model: null, role: 'implement', phase: null,
    effort: null, pid: 123, machineId: 'm-one', machineName: 'Test machine', projectId: 'p-one', taskId: 't-one', runId: 'r-one', sessionId: null,
    processStartedAt: now - 1000, generation: 1, status: 'running', lastActivity: 'Saved fixture file', lastSeenAt: now,
    freshness: 'fresh', online: true, cache: { readTokens: null, writeTokens: null }, capabilities: { inspect: true, requestStop: true, nativeStop: false }, ...overrides };
}
function snapshot(entries = [entry()]) { return { generatedAt: now, entries, coverage: { historyLimit: 100, unknownSignals: ['native process liveness'], sessionsTruncated: false, machinesTruncated: false } }; }
function board() { return { projects: [{ id: 'p-one', name: 'Fixture' }], active: [{ id: 't-one', title: 'Exact fixture task', status: 'running' }], attention: [], recentDone: [], machines: [], sessions: [], paused: { paused: false }, warnings: [], spentToday: 0, dailyBudget: 10 }; }
function detail(id = 't-one') { return { task: { id, title: 'Exact ' + id, status: 'running', scope: [], attempts: 1, max_attempts: 3, cost_usd: 0 }, runs: [], deps: [], label: 'Working' }; }
function harness(options: { token?: string | null; hash?: string; wide?: boolean; media?: { matches: boolean; listeners: Function[] } } = {}) {
  const doc = new Document();
  for (const id of ['app', 'toast']) { const n = doc.createElement('div'); n.setAttribute('id', id); doc.body.append(n); }
  for (const id of ['tpl-main', 'tpl-gate']) {
    const n = doc.createElement('template'); n.setAttribute('id', id);
    n.content = parse(html.match(new RegExp('<template id="' + id + '">([\\s\\S]*?)</template>'))![1]!, doc); doc.body.append(n);
  }
  const storage = new Map<string, string>(); if (options.token !== null) storage.set('ym-token', options.token || 'disposable-test-token');
  const calls: { method: string; params: any }[] = [];
  const timers = new Map<number, { fn: Function; ms: number }>(); let nextTimer = 1;
  let respond: (method: string, params: any) => any = method => method === 'board.status' ? board() : method === 'registry.list' ? snapshot() : method === 'task.get' ? detail() : '';
  const context: any = { document: doc, Node: Element, URLSearchParams, Date, console,
    ...(options.wide ? { matchMedia: () => ({ matches: true, addEventListener() {} }) } : {}),
    ...(options.media ? { matchMedia: () => ({ get matches() { return options.media!.matches; }, addEventListener: (_: string, fn: Function) => options.media!.listeners.push(fn) }) } : {}),
    location: { hash: options.hash || '', pathname: '/' }, history: { replaceState() { context.location.hash = ''; } },
    localStorage: { getItem: (k: string) => storage.get(k) || null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    setTimeout(fn: Function, ms: number) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval() { return nextTimer++; }, clearInterval() {},
    async fetch(url: string, init: any) {
      const method = url.replace('/api/rpc/', ''); const params = JSON.parse(init.body); calls.push({ method, params });
      const result = await respond(method, params);
      if (result?.httpStatus) return { status: result.httpStatus, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
    },
  };
  const exposed = script.replace(/  refresh\(\);\n  stream\(\);\n  setInterval\(refresh, 10000\);/, `  globalThis.dashboard = { refresh, scheduleRefresh, showTask, showEntry, closeDrawer, requestStop, renderRegistry, actionButtons, pushEvents, stream, rpc, state: () => ({ board, registry, openTask, openEntry }) };`);
  runInNewContext(exposed, context);
  const $ = (id: string) => doc.getElementById(id)!;
  return { doc, $, api: context.dashboard, calls, storage, context, timers,
    respond(fn: typeof respond) { respond = fn; },
    async flush(ms = 250) { const pending = [...timers].filter(([, t]) => t.ms === ms); for (const [id, t] of pending) { timers.delete(id); await t.fn(); } await new Promise(resolve => setImmediate(resolve)); },
  };
}

const all = (node: Element, cls: string): Element[] => [...(node.className.split(' ').includes(cls) ? [node] : []), ...node.children.flatMap(child => all(child, cls))];

test('empty work view displays zero counts rather than callback indexes', async () => {
  const h = harness();
  h.respond(method => method === 'registry.list' ? snapshot([]) : { ...board(), active: [], attention: [], recentDone: [] });
  await h.api.refresh();
  const stages = h.$('stages').children;
  assert.equal(stages.length, 5);
  assert.deepEqual(stages.map(node => node.children.at(-1)!.textContent), ['0', '0', '0', '0', '0']);
  assert.deepEqual(stages.map(node => node.getAttribute('data-n')), ['none', 'none', 'none', 'none', 'none']);
  assert.match(h.$('board').textContent, /Nothing queued.*Add work/);
  assert.equal(all(h.$('board'), 'row').length, 0);
  assert.equal(h.$('summary-line').textContent, 'All quiet. Nothing is running.');
  h.respond(method => method === 'registry.list' ? snapshot([]) : { ...board(), active: [], paused: { paused: true, by: 'you' } });
  await h.api.refresh();
  assert.equal(h.$('summary-line').textContent, 'Paused. Nothing is waiting.');
});

test('each task is one row with a short name, plain phase, cleaned activity, time and cost against its budget', async () => {
  const h = harness();
  const long = "Shop issue #148: isolate the math stylesheet from plain chat. Today src/chat/message.tsx imports 'katex/dist/katex.min.css' at module level, so every screen that imp…";
  const wt = '/home/fixture/work/ym-managed/shop-1a2b3c/t-7837e47d0d4259a5';
  h.respond(method => method === 'registry.list' ? snapshot([]) : { ...board(), recentDone: [{ id: 't-done', title: 'Finished fixture', summary: 'Merged cleanly.', cost: 0.2, finishedAt: now - 5 * 60_000 }], active: [
    { id: 't-wait', title: 'Queued fixture', status: 'queued', waiting: 'Both agent slots are busy' },
    { id: 't-run', title: long, status: 'running', agent: 'claude', model: 'opus', phase: 'agent', cost: 0.65, budget: 3, startedAt: now - 12 * 60_000, lastActivity: `tool Bash cd ${wt}; PATH="/home/fixture/.nvm/v22/b…` },
    { id: 't-edit', title: 'Editing fixture', status: 'running', agent: 'codex', phase: 'setup:spawning', startedAt: now - 30_000, lastActivity: `edit Write ${wt}/src/chat/message-response.tsx` },
    { id: 't-cd', title: 'Fix login. Then update the docs.', status: 'running', agent: 'codex', lastActivity: `tool Bash cd ${wt} && cd packages/web && npm test` },
    { id: 't-space', title: 'Quoted path fixture', status: 'running', agent: 'codex', lastActivity: 'tool Bash cd "/Users/owner/real outreach/worktrees/t-0123456789ab" && cd \'my app\' && npm test' },
    { id: 't-check', title: 'Checked fixture', status: 'verifying', agent: 'codex', phase: 'review_wait', startedAt: now - 95 * 60_000 },
    { id: 't-ready', title: 'Approval fixture', status: 'ready', agent: 'claude', needsApproval: true, readyAt: now - 3 * 60_000 },
  ] });
  await h.api.refresh();
  const rows = all(h.$('board'), 'row');
  // Closest to merging first, then waiting, then finished.
  assert.deepEqual(rows.map(row => row.getAttribute('data-focus')), ['task:t-ready', 'task:t-check', 'task:t-run', 'task:t-edit', 'task:t-cd', 'task:t-space', 'task:t-wait', 'task:t-done']);
  const text = (id: string) => rows.find(row => row.getAttribute('data-focus') === 'task:' + id)!.textContent;
  assert.match(text('t-run'), /^WorkingCodingShop issue #148: isolate the math stylesheet from plain chatclaude · opusRunning a command12m\$0\.65 of \$3$/);
  assert.match(text('t-edit'), /Installing dependencies.*codexEditing src\/chat\/message-response\.tsxunder 1m/);
  // Only the step into the task's own working copy is dropped; where a command ran stays visible.
  assert.equal(text('t-cd'), 'WorkingFix logincodexRunning: cd packages/web && npm test');
  assert.equal(text('t-space'), "WorkingQuoted path fixturecodexRunning: cd 'my app' && npm test");
  assert.match(text('t-check'), /^CheckingIn reviewChecked fixturecodex1h 35m$/);
  assert.match(text('t-ready'), /^Ready to mergeWaiting for your approvalApproval fixtureclaude3m ago$/);
  assert.match(text('t-wait'), /^WaitingQueued fixtureBoth agent slots are busy$/);
  assert.match(text('t-done'), /^DoneFinished fixtureMerged cleanly\.5m ago\$0\.20$/);
  assert.doesNotMatch(h.$('board').textContent, /\/home\/fixture|PATH=/);
  assert.deepEqual(h.$('stages').children.map(node => node.children.at(-1)!.textContent), ['1', '4', '1', '1', '1']);
  assert.equal(h.$('summary-line').textContent, '6 tasks in progress. 1 task waiting. Nothing needs you.');
});

test('a task waiting for approval is counted once and offers approval where the owner is asked', async () => {
  const h = harness();
  const ready = { id: 't-one', title: 'Approval fixture', status: 'ready', needsApproval: true };
  h.respond(method => method === 'registry.list' ? snapshot([]) : method === 'board.status' ? { ...board(), active: [ready], attention: [{ id: 't-one', title: 'Approval fixture', status: 'ready', why: 'Checks and review passed. Waiting for your approval.' }] } : detail());
  await h.api.refresh();
  assert.equal(h.$('summary-line').textContent, '1 task needs you.');
  const approve = h.$('att-list').querySelectorAll('[data-focus]').find(node => node.textContent === 'Approve and merge')!;
  await approve.dispatch('click');
  assert.deepEqual(h.calls.filter(c => c.method === 'task.control').map(c => [c.params.id, c.params.action]), [['t-one', 'approve']]);
});

test('connection records stay folded until one needs a look, and name each agent state literally', async () => {
  const h = harness();
  h.respond(method => method === 'registry.list' ? snapshot([entry(), entry({ id: 'installed', source: 'machine-advertisement', agent: 'codex', state: 'unconnected', taskId: null })]) : board());
  await h.api.refresh();
  assert.equal(h.$('conn-details').open, false);
  assert.equal(h.$('conn-summary').textContent, 'mock managed · codex unconnected');
  h.respond(method => method === 'registry.list' ? snapshot([entry({ state: 'stale', capabilities: { inspect: true, requestStop: false } })]) : board());
  await h.api.refresh();
  assert.equal(h.$('conn-details').open, true);
  // The owner's choice to fold it again is kept while the same trouble persists.
  h.$('conn-details').open = false;
  await h.api.refresh();
  assert.equal(h.$('conn-details').open, false);
  h.respond(method => { if (method === 'registry.list') throw new Error('Fixture offline'); return board(); });
  await h.api.refresh();
  assert.equal(h.$('conn-summary').textContent, 'Could not refresh');
});

test('task detail opens on the tab its state calls for and keeps the chosen tab, the log and focus across refreshes', async () => {
  const h = harness(); await h.api.refresh();
  const wt = '/home/fixture/work/ym-managed/shop-1a2b3c/t-one';
  const full = { ...detail(), label: 'Checking', task: { ...detail().task, status: 'verifying', title: 'Exact fixture task', prompt: 'Exact fixture task. Then a second sentence with the detail.', budget_usd: 3, cost_usd: 1.2,
      started_at: now - 20 * 60_000, branch: 'yardmaster/t-one', base_sha: 'bf5811951c3f618a8a43c5648eae95f7014215cc', worktree: wt, project_id: 'p-one' },
    runs: [{ role: 'implement', agent: 'claude', model: 'opus', effort: 'high', phase: 'verify', cost_estimated: true, touched: ['src/a.ts', 'src/b.ts'] }],
    events: [{ id: 1, ts: now - 60_000, message: 'claude (opus) started "Exact fixture task"' }] };
  h.respond(method => method === 'task.get' ? full : method === 'task.logs' ? `16:24 tool Bash cd "${wt}"; npm test\n16:25 edit Write ${wt}/src/a.ts` : method === 'registry.list' ? snapshot() : method === 'task.diff' ? null : board());
  await h.api.showTask('t-one'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('d-title').textContent, 'Exact fixture task');
  assert.equal(h.$('d-crumb').textContent, 'Fixture / t-one');
  assert.equal(h.$('d-status').textContent, 'CheckingRunning checks');
  assert.deepEqual(h.$('d-track').children.map(node => node.className), ['past', 'past', 'now', '', '']);
  assert.match(h.$('d-facts').textContent, /Agentclaude · opus · high effort.*Cost\$1\.20 of \$3 \(estimated\)Attempt1 of 3$/);
  assert.match(h.$('panel-details').textContent, /Taskt-oneBranchyardmaster\/t-one/);
  // A task being checked opens on its live activity; everything else is one tab away.
  assert.equal(h.$('panel-activity').hidden, false); assert.equal(h.$('panel-changes').hidden, true);
  assert.equal(h.$('tab-activity').getAttribute('aria-selected'), 'true');
  assert.equal(h.$('tab-changes').textContent, 'Changes2');
  assert.match(h.$('panel-changes').textContent, /Files changed so far · 2src\/a\.tssrc\/b\.ts/);
  assert.match(h.$('panel-request').textContent, /Full requestExact fixture task\. Then a second sentence/);
  assert.match(h.$('panel-history').textContent, /claude \(opus\) started "Exact fixture task"/);
  assert.match(h.$('panel-details').textContent, /git diff bf5811951c3f\.\.\.yardmaster\/t-one/);
  assert.equal(h.$('d-log').textContent, '16:24 tool Bash npm test\n16:25 edit Write src/a.ts');
  assert.equal(h.calls.filter(c => c.method === 'task.diff').length, 0);
  await h.$('tab-details').dispatch('click');
  assert.equal(h.$('panel-details').hidden, false); assert.equal(h.$('panel-activity').hidden, true);
  h.$('d-log').scrollHeight = 500; h.$('d-log').clientHeight = 100; h.$('d-log').scrollTop = 40;
  h.$('tab-details').focus();
  await h.api.showTask('t-one', true);
  // The chosen tab, the focused control and the log position survive the rebuild.
  assert.equal(h.$('panel-details').hidden, false); assert.equal(h.$('panel-activity').hidden, true);
  assert.equal(h.doc.activeElement.id, 'tab-details'); assert.equal(h.doc.activeElement.isConnected, true);
  assert.equal(h.$('d-log').textContent, '16:24 tool Bash npm test\n16:25 edit Write src/a.ts');
  assert.equal(h.$('d-log').scrollTop, 40);
  // Opening the change asks the hub for it once.
  await h.$('tab-changes').dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(c => c.method === 'task.diff').length, 1);
  h.api.showEntry('run:r-one');
  assert.equal(h.$('d-status').textContent, ''); assert.equal(h.$('d-track').hidden, true);
});

test('the change tab shows each changed file and its lines, read once from the hub', async () => {
  const h = harness(); await h.api.refresh();
  const ready = { ...detail(), label: 'Ready to merge', runs: [{ role: 'implement', agent: 'claude', touched: ['src/a.ts'] }],
    task: { ...detail().task, status: 'ready', attention: 'Checks and review passed. Waiting for your approval.', base_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40), branch: 'yardmaster/t-one' } };
  const patch = 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old line\n--- counter;\n+new line\n+++ counter;\n';
  h.respond(method => method === 'task.get' ? ready : method === 'task.diff' ? { source: 'artifact', files: [{ path: 'src/a.ts', added: 1, removed: 1 }], patch, truncated: false, note: null } : method === 'registry.list' ? snapshot() : board());
  await h.api.showTask('t-one'); await new Promise(resolve => setImmediate(resolve));
  // A finished change opens on the change itself, next to the approval it is waiting for.
  assert.equal(h.$('panel-changes').hidden, false);
  assert.ok(h.$('d-acts').querySelectorAll('[data-focus]').some(node => node.textContent === 'Approve and merge'));
  const change = h.$('d-change');
  assert.match(change.textContent, /^1 file · \+1 −1src\/a\.ts\+1 −1src\/a\.ts@@ -1,3 \+1,3 @@ keep-old line/);
  // Inside a hunk, lines that look like file headers are changed source lines.
  assert.deepEqual(all(change, 'ad').map(node => node.textContent), ['+new line', '+++ counter;']);
  assert.deepEqual(all(change, 'dl').map(node => node.textContent), ['-old line', '--- counter;']);
  assert.doesNotMatch(change.textContent, /index 1111111|\+\+\+ b\//);
  await h.api.showTask('t-one', true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(c => c.method === 'task.diff').length, 1);
  assert.match(h.$('d-change').textContent, /\+new line/);
});

test('keys move through the list beside the open task, and approving takes a second press', async () => {
  const h = harness({ wide: true });
  const running = { id: 't-two', title: 'Running fixture', status: 'running' };
  const ready = { id: 't-one', title: 'Approval fixture', status: 'ready', needsApproval: true };
  const details: Record<string, any> = {
    't-one': { ...detail('t-one'), label: 'Ready to merge', task: { ...detail('t-one').task, status: 'ready', attention: 'Waiting for your approval.' } },
    't-two': detail('t-two'),
  };
  h.respond((method, params) => method === 'board.status' ? { ...board(), active: [running, ready], attention: [{ id: 't-one', title: 'Approval fixture', status: 'ready', why: 'Waiting for your approval.' }] }
    : method === 'registry.list' ? snapshot([]) : method === 'task.get' ? details[params.id] : method === 'task.diff' ? null : '');
  await h.api.refresh();
  const press = async (key: string) => { for (const fn of h.doc.listeners.get('keydown') || []) await fn({ key, target: h.doc.body, preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
  await press('j');
  // Wide screens show the task beside the list instead of covering it.
  assert.equal(h.api.state().openTask, 't-one'); assert.equal(h.$('drawer').open, true); assert.equal(h.$('overview').hidden, true);
  assert.deepEqual(all(h.$('board'), 'sel').map(node => node.getAttribute('data-focus')), ['task:t-one']);
  await press('j'); assert.equal(h.api.state().openTask, 't-two');
  await press('k'); assert.equal(h.api.state().openTask, 't-one');
  await press('a');
  assert.equal(h.calls.filter(c => c.method === 'task.control').length, 0);
  assert.match(h.$('toast').textContent, /Press A again/);
  await press('a');
  assert.deepEqual(h.calls.filter(c => c.method === 'task.control').map(c => [c.params.id, c.params.action]), [['t-one', 'approve']]);
  await press('Escape');
  assert.equal(h.$('drawer').open, false); assert.equal(h.$('overview').hidden, false);
  assert.equal(all(h.$('board'), 'sel').length, 0);
});

test('a task stopped for touching other files can have its allowed files widened from its detail', async () => {
  const h = harness(); await h.api.refresh();
  const stopped = { ...detail(), label: 'Needs you', runs: [{ role: 'implement', agent: 'claude', phase: 'agent' }], task: { ...detail().task, status: 'needs_human', scope: ['src/chat/**', 'docs/ledger.json'], started_at: now - 60_000,
    last_error: 'Changed files outside its declared scope: docs/ledger.md, src/chat/new.ts, src/privacy/map.ts. Only change src/chat/**, docs/ledger.json.' } };
  h.respond(method => method === 'task.get' ? stopped : method === 'registry.list' ? snapshot() : method === 'board.status' ? board() : {});
  await h.api.showTask('t-one');
  // The last run's phase is history once the task has stopped.
  assert.equal(h.$('d-status').textContent, 'Needs you');
  const section = h.$('panel-changes').children.find(node => node.tagName === 'DETAILS' && node.textContent.startsWith('Files it may change'))!;
  // A stopped task opens on its change, where the allowed files are edited.
  assert.equal(h.$('panel-changes').hidden, false);
  assert.equal(section.hasAttribute('open'), true);
  // Files a pattern already allows are not reported again.
  assert.match(section.textContent, /stopped for changing 2 files outside this list: docs\/ledger\.md, src\/privacy\/map\.ts/);
  assert.equal(h.$('d-scope').value, 'src/chat/**, docs/ledger.json');
  const button = (label: string) => h.$('d-body').querySelectorAll('[data-focus]').find(node => node.textContent === label)!;
  await button('Add them to the list').dispatch('click');
  assert.equal(h.$('d-scope').value, 'src/chat/**, docs/ledger.json, docs/ledger.md, src/privacy/map.ts');
  // An unsaved list survives the snapshot refresh that rebuilds the detail.
  await h.api.showTask('t-one', true);
  assert.equal(h.$('d-scope').value, 'src/chat/**, docs/ledger.json, docs/ledger.md, src/privacy/map.ts');
  // Putting the saved list back discards the draft instead of restoring it on the next refresh.
  h.$('d-scope').value = 'src/chat/**, docs/ledger.json';
  await h.api.showTask('t-one', true);
  assert.equal(h.$('d-scope').value, 'src/chat/**, docs/ledger.json');
  await button('Add them to the list').dispatch('click');
  await button('Save allowed files').dispatch('click');
  const call = h.calls.find(c => c.method === 'task.setScope')!;
  assert.deepEqual(call.params, { id: 't-one', scope: ['src/chat/**', 'docs/ledger.json', 'docs/ledger.md', 'src/privacy/map.ts'], by: 'dashboard' });
  assert.match(h.$('toast').textContent, /Try again/);
  // A brace pattern is one pattern, matched the way the hub matches it; a folder allows what is inside it.
  const braces = { ...stopped, task: { ...stopped.task, scope: ['src/{client,server}/**', 'docs', 'gen/**/out.md', 'a?.ts'],
    last_error: 'Changed files outside its declared scope: src/client/app.ts, docs/guide/a.md, gen/out.md, ab.ts, lib/x.ts. Only change src/{client,server}/**, docs, gen/**/out.md, a?.ts.' } };
  h.respond(method => method === 'task.get' ? braces : method === 'registry.list' ? snapshot() : method === 'board.status' ? board() : {});
  await h.api.showTask('t-one', true);
  assert.match(h.$('d-body').textContent, /stopped for changing a file outside this list: lib\/x\.ts/);
  await button('Add it to the list').dispatch('click');
  await button('Save allowed files').dispatch('click');
  assert.deepEqual(h.calls.filter(c => c.method === 'task.setScope').at(-1)!.params.scope, ['src/{client,server}/**', 'docs', 'gen/**/out.md', 'a?.ts', 'lib/x.ts']);
  h.respond(method => method === 'task.get' ? { ...detail(), label: 'Done', task: { ...detail().task, status: 'done' } } : method === 'registry.list' ? snapshot() : board());
  await h.api.showTask('t-one', true);
  assert.equal(h.$('d-scope'), null);
});

test('the feed shows the latest events and opens older ones in place', async () => {
  const h = harness(); await h.api.refresh();
  const event = (id: number) => ({ id, level: 'info', message: 'Event ' + id, ts: now - (100 - id) * 1000 });
  h.api.pushEvents([1, 2, 3].map(event));
  assert.equal(h.$('feed').children.length, 3); assert.equal(h.$('feed-more').hidden, true);
  h.api.pushEvents([4, 5, 6, 7, 8, 9, 10, 11].map(event));
  // Newest first; the three oldest wait behind the button.
  assert.equal(h.$('feed').children.length, 8);
  assert.match(h.$('feed').children[0]!.textContent, /Event 11$/);
  assert.equal(h.$('feed-more').hidden, false); assert.equal(h.$('feed-more').textContent, 'Show 3 older');
  await h.$('feed-more').dispatch('click');
  assert.equal(h.$('feed').children.length, 11); assert.equal(h.$('feed-more').textContent, 'Show fewer');
  h.api.pushEvents([event(12)]);
  assert.equal(h.$('feed').children.length, 12);
  await h.$('feed-more').dispatch('click');
  assert.equal(h.$('feed').children.length, 8);
});

test('dashboard projects real registry states, unknown signals, exact task link and supported stop only', async () => {
  const h = harness();
  const entries = [entry(), entry({ id: 'session:s-one', source: 'session', state: 'observed', pid: null, taskId: null, capabilities: { inspect: true, requestStop: false } }),
    entry({ id: 'old', state: 'stale', capabilities: { inspect: true, requestStop: false } }),
    entry({ id: 'installed', source: 'machine-advertisement', state: 'unconnected', taskId: null, capabilities: { inspect: false, requestStop: false } })];
  h.respond(method => method === 'registry.list' ? snapshot(entries) : board());
  await h.api.refresh();
  assert.equal(h.$('registry').children.length, 4);
  assert.deepEqual(h.$('registry').children.map(n => n.getAttribute('data-state')), ['managed', 'observed', 'stale', 'unconnected']);
  assert.equal(h.$('registry').children.filter(n => n.textContent.includes('Request stop')).length, 1);
  h.api.showEntry('session:s-one');
  assert.match(h.$('d-facts').textContent, /ModelUnknown.*PhaseUnknown.*EffortUnknown.*PIDUnknown/);
  assert.doesNotMatch(h.$('d-acts').textContent, /stop|Open exact task|null/);
  h.api.showEntry('run:r-one');
  assert.match(h.$('d-acts').textContent, /Open exact task/);
  h.respond(method => method === 'task.get' ? detail() : '');
  await h.$('d-acts').children[0]!.dispatch('click');
  assert.equal(h.calls.at(-2)!.method, 'task.get');
  assert.equal(h.calls.at(-2)!.params.id, 't-one');
});

test('SSE scheduling coalesces a burst and refresh serializes one trailing snapshot pair', async () => {
  const h = harness(); let resolveBoard!: (v: any) => void;
  h.respond(method => method === 'board.status' ? new Promise(resolve => { resolveBoard = resolve; }) : snapshot());
  const first = h.api.refresh();
  for (let i = 0; i < 50; i++) { h.api.scheduleRefresh(); void h.api.refresh(); }
  assert.equal(h.calls.filter(c => c.method === 'registry.list').length, 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 250).length, 1);
  await h.flush();
  resolveBoard(board()); await first;
  h.respond(method => method === 'board.status' ? board() : snapshot());
  await h.flush();
  assert.equal(h.calls.filter(c => c.method === 'board.status').length, 2);
  assert.equal(h.calls.filter(c => c.method === 'registry.list').length, 2);
});

test('stop rechecks capability and never sends control for an observed or newly stale record', async () => {
  const h = harness(); await h.api.refresh();
  h.respond(method => method === 'registry.list' ? snapshot([entry({ state: 'stale', capabilities: { inspect: true, requestStop: false } })]) : board());
  await h.api.requestStop('t-one');
  assert.equal(h.calls.filter(c => c.method === 'task.control').length, 0);
  h.respond(method => method === 'registry.list' ? snapshot() : method === 'board.status' ? board() : detail());
  await h.api.requestStop('t-one');
  assert.equal(h.calls.filter(c => c.method === 'task.control').length, 1);
  assert.match(h.$('toast').textContent, /exit is not yet confirmed/);
});

test('task refresh preserves guidance, caret selection and focus; late task reads cannot replace newer detail', async () => {
  const h = harness(); await h.api.refresh();
  h.respond((method, params) => method === 'task.get' ? detail(params.id) : '');
  const origin = h.$('registry').children[0]!.querySelectorAll('[data-focus]')[0]!; origin.focus();
  await h.api.showTask('t-one');
  const note = h.$('d-note'); note.value = 'Keep my unsent guidance'; note.setSelectionRange(5, 12); note.focus();
  await h.api.showTask('t-one', true);
  assert.equal(h.$('d-note').value, 'Keep my unsent guidance');
  assert.equal(h.doc.activeElement, h.$('d-note'));
  assert.equal(h.$('d-note').selectionStart, 5); assert.equal(h.$('d-note').selectionEnd, 12);
  let oldResolve!: (v: any) => void;
  h.respond((method, params) => method === 'task.get' && params.id === 't-old' ? new Promise(resolve => { oldResolve = resolve; }) : method === 'task.get' ? detail(params.id) : '');
  const old = h.api.showTask('t-old'); await h.api.showTask('t-new'); oldResolve(detail('t-old')); await old;
  assert.equal(h.$('d-title').textContent, 'Exact t-new');
  h.api.closeDrawer(); assert.equal(h.doc.activeElement, origin);
  await h.api.showTask('t-one'); assert.equal(h.$('d-note').value, 'Keep my unsent guidance');
});

test('project changes reject old-scope snapshots and fetch registry with an omitted all-project parameter', async () => {
  const h = harness(); let resolve!: (v: any) => void;
  h.respond(method => method === 'board.status' ? new Promise(r => { resolve = r; }) : snapshot());
  const first = h.api.refresh();
  h.$('project').value = 'p-two'; await h.$('project').dispatch('change');
  resolve(board()); await first;
  assert.equal(h.api.state().registry, null);
  h.respond(method => method === 'board.status' ? { ...board(), projects: [{ id: 'p-two', name: 'Other' }] } : snapshot([]));
  await h.flush();
  const calls = h.calls.filter(c => c.method === 'registry.list');
  assert.deepEqual(calls[0]!.params, {}); assert.deepEqual(calls[1]!.params, { projectId: 'p-two' });
});

test('registry failure retains snapshot, disables stale stop actions and explains retry; first-run is actionable', async () => {
  const h = harness(); await h.api.refresh();
  h.respond(method => { if (method === 'registry.list') throw new Error('Fixture offline'); return board(); });
  await h.api.refresh();
  assert.equal(h.$('registry').children.length, 1);
  assert.doesNotMatch(h.$('registry').textContent, /Request stop/);
  assert.match(h.$('registry-status').textContent, /Showing snapshot.*Refresh now/);
  assert.equal(h.$('load-state').hidden, false);
  h.respond(method => method === 'registry.list' ? snapshot([]) : { ...board(), projects: [], active: [] });
  await h.api.refresh();
  assert.equal(h.$('setup').hidden, false); assert.match(h.$('registry-status').textContent, /ym connect all/);
});

test('auth failure clears saved key and displays a fresh-link path without reload loops', async () => {
  const h = harness({ hash: '#token=disposable-fragment-token' });
  assert.equal(h.context.location.hash, '');
  assert.equal(h.storage.get('ym-token'), 'disposable-fragment-token');
  h.respond(() => ({ httpStatus: 401 })); await h.api.refresh();
  assert.equal(h.storage.has('ym-token'), false);
  assert.match(h.$('auth-message').textContent, /Access expired.*ym dashboard/);
  const calls = h.calls.length; await h.api.refresh(); assert.equal(h.calls.length, calls);
  const anonymous = harness({ token: null }); assert.equal(anonymous.api, undefined);
  assert.match(anonymous.$('auth-message').textContent, /access key/);
});

test('registry rendering treats untrusted names/activity as text and does not auto-generate pairing secrets', async () => {
  const h = harness();
  h.respond(method => method === 'registry.list' ? snapshot([entry({ agent: '<img src=x onerror=alert(1)>', lastActivity: '<script>secret</script>' })]) : board());
  await h.api.refresh();
  assert.match(h.$('registry').textContent, /<img src=x/);
  assert.equal(h.calls.some(c => c.method === 'fleet.invite'), false);
  assert.equal(h.$('drawer').tagName, 'DIALOG');
  assert.equal(h.$('drawer').getAttribute('aria-labelledby'), 'd-title');
});

test('guidance typed while a snapshot detail request is pending keeps the latest caret', async () => {
  const h = harness(); await h.api.refresh();
  h.respond(method => method === 'task.get' ? detail() : ''); await h.api.showTask('t-one');
  h.$('d-note').value = 'Draft'; h.$('d-note').setSelectionRange(1, 1); h.$('d-note').focus();
  let finish!: (v: any) => void;
  h.respond(method => method === 'task.get' ? new Promise(resolve => { finish = resolve; }) : method === 'registry.list' ? snapshot() : board());
  const refresh = h.api.refresh(); await new Promise(resolve => setImmediate(resolve));
  h.$('d-note').value = 'Draft updated during request'; h.$('d-note').setSelectionRange(14, 20);
  finish(detail()); await refresh;
  assert.equal(h.$('d-note').value, 'Draft updated during request');
  assert.equal(h.$('d-note').selectionStart, 14); assert.equal(h.$('d-note').selectionEnd, 20);
});

test('a disappearing inspected process loses its old action controls', async () => {
  const h = harness(); await h.api.refresh(); h.api.showEntry('run:r-one');
  h.respond(method => method === 'registry.list' ? snapshot([]) : board()); await h.api.refresh();
  assert.equal(h.$('d-title').textContent, 'Record no longer reported');
  assert.equal(h.$('d-acts').textContent, '');
});

test('project changes cancel a pending detail open before the modal becomes visible', async () => {
  const h = harness(); await h.api.refresh(); let finish!: (v: any) => void;
  h.respond(method => method === 'task.get' ? new Promise(resolve => { finish = resolve; }) : method === 'registry.list' ? snapshot([]) : method === 'board.status' ? board() : []);
  const pending = h.api.showTask('t-one');
  h.$('project').value = 'p-two'; await h.$('project').dispatch('change');
  finish(detail()); await pending;
  assert.equal(h.$('drawer').open, false); assert.equal(h.api.state().openTask, null);
});

test('existing task controls and pause/resume still send the original owner RPC actions', async () => {
  const h = harness(); await h.api.refresh();
  h.respond(method => method === 'registry.list' ? snapshot() : method === 'board.status' ? board() : detail());
  const retry = h.api.actionButtons({ id: 't-one', status: 'failed' }, false)[0]; await retry.dispatch('click');
  const approve = h.api.actionButtons({ id: 't-one', status: 'ready', attention: 'Review passed' }, false)[0]; await approve.dispatch('click');
  const cancel = h.api.actionButtons({ id: 't-one', status: 'queued' }, false)[0];
  const before = h.calls.filter(c => c.method === 'task.control').length;
  await cancel.dispatch('click'); assert.equal(h.calls.filter(c => c.method === 'task.control').length, before);
  await cancel.dispatch('click');
  await h.$('pause-soft').dispatch('click'); await h.$('resume-btn').dispatch('click');
  assert.deepEqual(h.calls.filter(c => c.method === 'task.control').map(c => c.params.action), ['retry', 'approve', 'cancel']);
  assert.equal(h.calls.find(c => c.method === 'fleet.pause')!.params.stopRunning, false);
  assert.equal(h.calls.some(c => c.method === 'fleet.resume'), true);
});


test('default registry view retains unconfirmed main and utility exits without offering unsafe stop', async () => {
  const h = harness();
  const rows = ['lost', 'cleanup_failed', 'succeeded'].map((status, i) => entry({ id: `held-${i}`, status, state: 'stale',
    exitUnconfirmed: true, utilityChildren: i === 2 ? [{ token: 'held', state: 'spawning', pid: null }] : [],
    capabilities: { inspect: true, requestStop: false } }));
  rows.push(entry({ id: 'finished', status: 'succeeded', exitUnconfirmed: false, capabilities: { inspect: true, requestStop: false } }));
  h.respond(method => method === 'registry.list' ? snapshot(rows) : board());
  await h.api.refresh();
  assert.equal(h.$('registry').children.length, 3);
  assert.doesNotMatch(h.$('registry').textContent, /Request stop/);
  h.api.showEntry('held-2');
  assert.match(h.$('d-facts').textContent, /succeeded/);
  assert.doesNotMatch(h.$('d-acts').textContent, /Request stop/);
});

test('a held A key never approves, and resizing across the breakpoint keeps the open task', async () => {
  const media = { matches: true, listeners: [] as Function[] };
  const h = harness({ media });
  const ready = { id: 't-one', title: 'Approval fixture', status: 'ready', needsApproval: true };
  h.respond((method, params) => method === 'board.status' ? { ...board(), active: [ready], attention: [{ id: 't-one', title: 'Approval fixture', status: 'ready', why: 'Waiting.' }] }
    : method === 'registry.list' ? snapshot([]) : method === 'task.get' ? { ...detail(params.id), label: 'Ready to merge', task: { ...detail(params.id).task, status: 'ready', attention: 'Waiting.' } } : method === 'task.diff' ? null : '');
  await h.api.refresh();
  const press = async (key: string, repeat = false) => { for (const fn of h.doc.listeners.get('keydown') || []) await fn({ key, repeat, target: h.doc.body, preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
  await press('j');
  await press('a'); await press('a', true); await press('a', true);
  assert.equal(h.calls.filter(c => c.method === 'task.control').length, 0);
  // Narrowing the window re-presents the same task full screen instead of closing it.
  media.matches = false;
  for (const fn of media.listeners) fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('drawer').open, true); assert.equal(h.api.state().openTask, 't-one'); assert.equal(h.$('overview').hidden, false);
  // Keys now belong to the full-screen task, not the list behind it.
  await press('a'); await press('a');
  assert.equal(h.calls.filter(c => c.method === 'task.control').length, 0);
  // A browser delivers the close event later. Closing in between (a project change) cancels the re-presentation.
  const drawer = h.$('drawer');
  const deliver = drawer.close.bind(drawer);
  let queued: (() => void) | null = null;
  drawer.close = () => { drawer.open = false; queued = () => void drawer.dispatch('close'); };
  media.matches = true;
  for (const fn of media.listeners) fn();
  h.api.closeDrawer();
  queued!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drawer.open, false); assert.equal(h.api.state().openTask, null); assert.equal(h.$('overview').hidden, false);
  drawer.close = deliver;
});

test('a change read for an earlier version of a task is never shown next to a newer one', async () => {
  const h = harness(); await h.api.refresh();
  const base = 'b'.repeat(40);
  let version: any = { ...detail(), label: 'Working', runs: [{ role: 'implement', agent: 'claude', touched: ['src/a.ts'] }], task: { ...detail().task, status: 'needs_human', base_sha: base, attempts: 1 } };
  const replies: ((value: unknown) => void)[] = [];
  h.respond(method => method === 'task.get' ? version : method === 'task.diff' ? new Promise(resolve => replies.push(resolve)) : method === 'registry.list' ? snapshot() : board());
  await h.api.showTask('t-one');
  assert.equal(replies.length, 1);
  // The task finishes with a saved commit while the first read is still pending.
  version = { ...version, label: 'Ready to merge', task: { ...version.task, status: 'ready', attention: 'Waiting.', head_sha: 'c'.repeat(40), attempts: 2 } };
  await h.api.showTask('t-one', true);
  const file = (path: string, line: string) => ({ source: 'artifact', files: [{ path, added: 1, removed: 0 }], patch: `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n${line}\n`, truncated: false, note: null });
  replies[0]!(file('src/old.ts', '+from the working copy'));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(h.$('d-change').textContent, /from the working copy/);
  assert.equal(replies.length, 2);
  replies[1]!(file('src/a.ts', '+from the saved commit'));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.match(h.$('d-change').textContent, /from the saved commit/);
});
