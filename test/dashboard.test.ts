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
function harness(options: { token?: string | null; hash?: string } = {}) {
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

test('empty work view displays zero counts rather than callback indexes', async () => {
  const h = harness();
  h.respond(method => method === 'registry.list' ? snapshot([]) : { ...board(), active: [], attention: [], recentDone: [] });
  await h.api.refresh();
  const stations = h.$('board').children.filter(node => node.className === 'station');
  assert.equal(stations.length, 5);
  assert.deepEqual(stations.map(node => node.children[0]!.children.at(-1)!.textContent), ['0', '0', '0', '0', '0']);
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
