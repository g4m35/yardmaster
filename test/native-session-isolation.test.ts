import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { buildMethods, localClient } from '../src/api.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { runHook } from '../src/hook.ts';
import { nativeSessionName } from '../src/hookclient.ts';
import { buildMcpServer } from '../src/mcp.ts';
import { machineId } from '../src/paths.ts';
import { buildRegistry } from '../src/registry.ts';
import { sandbox, sh } from './helpers.ts';

async function fixture() {
  const box = sandbox();
  const second = join(box.root, 'second');
  mkdirSync(second);
  sh(second, 'git', ['init', '-q', '-b', 'main']);
  writeFileSync(join(second, 'README.md'), '# independent fixture\n');
  sh(second, 'git', ['add', '.']);
  sh(second, 'git', ['commit', '-qm', 'fixture']);
  const coord = new Coordinator(openDb(':memory:'));
  const firstProject = await coord.registerProject(box.repo);
  const secondProject = await coord.registerProject(second);
  const api = localClient(buildMethods(coord, { machineId: machineId() }));
  const hook = (event: string, session: string, cwd = box.repo) => runHook(event, JSON.stringify({
    cwd, session_id: session, tool_name: 'Edit', tool_input: { file_path: join(cwd, 'shared.txt') },
  }), async () => api);
  const connect = async (name: string) => {
    const claims = new Map<string, number>();
    const server = buildMcpServer({ client: api, cwd: box.repo, identity: 'unregistered-bootstrap',
      sessionName: name, agentName: 'native-editor', claims });
    const mcp = new McpClient({ name: 'native-isolation-test', version: '1' });
    const a: any = { start: async () => {}, close: async () => {}, send: async (message: unknown) => queueMicrotask(() => b.onmessage?.(structuredClone(message))) };
    const b: any = { start: async () => {}, close: async () => {}, send: async (message: unknown) => queueMicrotask(() => a.onmessage?.(structuredClone(message))) };
    await server.connect(a);
    await mcp.connect(b);
    return { mcp, claims, close: async () => { await mcp.close(); await server.close(); } };
  };
  return { ...box, second, firstProject, secondProject, coord, api, hook, connect };
}

test('independent native sessions in the same repository root block each other while their owner can continue', async () => {
  const previous = process.env.YARDMASTER_SESSION;
  delete process.env.YARDMASTER_SESSION;
  const f = await fixture();
  try {
    await f.hook('session-start', 'native-A');
    await f.hook('session-start', 'native-B');
    await f.hook('post-edit', 'native-A');
    assert.equal((await f.hook('pre-edit', 'native-A')).code, 0);
    const other = await f.hook('pre-edit', 'native-B');
    assert.equal(other.code, 2, 'a shared cwd must never establish common ownership');
    assert.match(other.stderr!, /being changed by session:/);
    const owner = f.coord.whoHas(f.firstProject.id, ['shared.txt'])[0]!.holder;
    const unregistered = await f.api['hook.check']({ projectId: f.firstProject.id, paths: ['shared.txt'], cwd: f.repo, sessionId: 'not-registered' });
    assert.equal(unregistered!.holder, owner);
  } finally {
    f.coord.db.close();
    if (previous === undefined) delete process.env.YARDMASTER_SESSION; else process.env.YARDMASTER_SESSION = previous;
  }
});

test('an explicitly shared native session name lets MCP and hooks cooperate without authorizing another connection', async () => {
  const previous = process.env.YARDMASTER_SESSION;
  process.env.YARDMASTER_SESSION = 'deliberately-shared-native-session';
  const f = await fixture();
  const mcp = await f.connect(nativeSessionName('mcp-fallback'));
  const other = await f.connect('independent-mcp-connection');
  try {
    await f.hook('post-edit', 'native-A');
    const owner = f.coord.whoHas(f.firstProject.id, ['shared.txt'])[0]!.holder;
    const shared = await mcp.mcp.callTool({ name: 'yard_claim_files', arguments: { patterns: ['shared.txt'] } });
    assert.match(JSON.stringify(shared.content), /Reserved shared.txt/);
    assert.equal(f.coord.whoHas(f.firstProject.id, ['shared.txt'])[0]!.holder, owner);
    const blocked = await other.mcp.callTool({ name: 'yard_claim_files', arguments: { patterns: ['shared.txt'] } });
    assert.match(JSON.stringify(blocked.content), /Not reserved/);
    const released = await mcp.mcp.callTool({ name: 'yard_release_files', arguments: { patterns: ['shared.txt'] } });
    assert.match(JSON.stringify(released.content), /Released/);
    assert.equal(f.coord.whoHas(f.firstProject.id, ['shared.txt']).length, 0);
    await mcp.mcp.callTool({ name: 'yard_claim_files', arguments: { patterns: ['shared.txt'] } });
    assert.equal((await f.hook('pre-edit', 'native-A')).code, 0, 'hook uses the exact canonical ID returned to MCP');
  } finally {
    await mcp.close(); await other.close(); f.coord.db.close();
    if (previous === undefined) delete process.env.YARDMASTER_SESSION; else process.env.YARDMASTER_SESSION = previous;
  }
});

test('the same native name has separate canonical identities and lock ownership in two projects', async () => {
  const previous = process.env.YARDMASTER_SESSION;
  process.env.YARDMASTER_SESSION = 'shared-across-projects';
  const f = await fixture();
  const mcp = await f.connect(nativeSessionName('mcp-fallback'));
  try {
    await f.hook('post-edit', 'native-A');
    await f.hook('post-edit', 'native-A', f.second);
    const firstOwner = f.coord.whoHas(f.firstProject.id, ['shared.txt'])[0]!.holder;
    const secondOwner = f.coord.whoHas(f.secondProject.id, ['shared.txt'])[0]!.holder;
    assert.notEqual(firstOwner, secondOwner);
    assert.equal((await f.hook('pre-edit', 'native-A')).code, 0);
    assert.equal((await f.hook('pre-edit', 'native-A', f.second)).code, 0);
    const secondClaim = await mcp.mcp.callTool({ name: 'yard_claim_files', arguments: { patterns: ['shared.txt'], repo: f.second } });
    assert.match(JSON.stringify(secondClaim.content), /Reserved shared.txt/);
    const foreign = await f.api['hook.check']({ projectId: f.secondProject.id, paths: ['shared.txt'], cwd: f.second, sessionId: firstOwner });
    assert.equal(foreign!.holder, secondOwner, 'a canonical identity from another project grants no exemption');
    await mcp.mcp.callTool({ name: 'yard_release_files', arguments: { patterns: ['shared.txt'], repo: f.second } });
    assert.equal(f.coord.whoHas(f.secondProject.id, ['shared.txt']).length, 0);
    assert.equal(f.coord.whoHas(f.firstProject.id, ['shared.txt'])[0]!.holder, firstOwner);
    for (const [project, owner] of [[f.firstProject, firstOwner], [f.secondProject, secondOwner]] as const) {
      const entry = buildRegistry(f.coord.db, { projectId: project.id }).entries.find(row => row.sessionId === owner);
      assert.ok(entry, 'each project observes its own registered identity');
    }
  } finally {
    await mcp.close(); f.coord.db.close();
    if (previous === undefined) delete process.env.YARDMASTER_SESSION; else process.env.YARDMASTER_SESSION = previous;
  }
});

test('MCP finishing uses the captured project identity after this connection visits another project', async () => {
  const f = await fixture();
  const mcp = await f.connect('multi-project-editor');
  try {
    const first = f.coord.addTasks(f.firstProject.id, [{ title: 'First native report', files: ['one.txt'], allowNoChanges: true }], 'fixture').created[0]!;
    const second = f.coord.addTasks(f.secondProject.id, [{ title: 'Second native report', files: ['two.txt'], allowNoChanges: true }], 'fixture').created[0]!;
    for (const [task, repo] of [[first, f.repo], [second, f.second]] as const) {
      const taken = await mcp.mcp.callTool({ name: 'yard_take_task', arguments: { id: task.id, repo } });
      assert.ok(!taken.isError, JSON.stringify(taken));
    }
    assert.notEqual(f.coord.getTask(first.id)!.assignee, f.coord.getTask(second.id)!.assignee);
    for (const task of [first, second]) {
      const finished = await mcp.mcp.callTool({ name: 'yard_finish_task', arguments: { id: task.id, summary: 'reported only' } });
      assert.ok(!finished.isError, JSON.stringify(finished));
      assert.equal(f.coord.getTask(task.id)!.status, 'done');
    }
    assert.equal(mcp.claims.size, 0);
  } finally { await mcp.close(); f.coord.db.close(); }
});
