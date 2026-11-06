import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sandbox, sh, until } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { remoteClient } from '../src/api.ts';
import { WorkerLoop } from '../src/worker.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { claudePreTool } from '../src/hook.ts';

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
      throw new Error(`${err.message.slice(0, 300)}\nEvents:\n${trail}\nWorker: ${JSON.stringify([...worker.active.keys()])}`);
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
