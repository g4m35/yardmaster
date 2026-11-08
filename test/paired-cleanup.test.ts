import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Client } from '../src/api.ts';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { connectWorker, fleetClient } from '../src/fleet-client.ts';
import { Hub } from '../src/hub.ts';
import { Semaphore } from '../src/runner.ts';
import { httpTransport } from '../src/transport.ts';
import type { Task } from '../src/types.ts';
import { WorkerJournal } from '../src/worker-journal.ts';
import { WorkerLoop, type BranchTransport } from '../src/worker.ts';
import { sandbox, sh, settleTasks, until } from './helpers.ts';

/** Real loopback HTTP, pairing, Git, mock coding and verification; no provider inference. */
test('paired worker fetches a new single-task merge before removing its unchanged accepted checkout', { timeout: 45_000 }, async () => {
  const box = sandbox({ maxParallel: 1, review: { mode: 'never' }, worktree: { warmStart: 'off' },
    integration: { trainSize: 1 }, disk: { minFreeGb: 0, maxWorktreesGb: null },
    cleanup: { auto: false, deleteMergedBranches: false } });
  const hub = new Hub({ db: openDb(join(box.home, 'paired-cleanup.db')), token: 'paired-cleanup-owner',
    machineId: 'm-hub', host: '127.0.0.1', port: 0, includeMock: false, tickMs: 150, quiet: true });
  const workers: WorkerLoop[] = [];
  const hasCommit = (repo: string, sha: string) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`],
    { cwd: repo, stdio: 'ignore' }).status === 0;
  try {
    const url = await hub.start();
    const project = await hub.coord.registerProject(box.repo);
    const clone = join(box.root, 'worker-clone');
    sh(box.root, 'git', ['clone', '--no-local', '-q', box.repo, clone]);
    sh(clone, 'git', ['config', 'user.name', 'Paired fixture']);
    sh(clone, 'git', ['config', 'user.email', 'paired@example.test']);
    const mainHead = sh(clone, 'git', ['rev-parse', 'main']);
    const otherRepo = join(box.root, 'private-project');
    mkdirSync(otherRepo);
    sh(otherRepo, 'git', ['init', '-q', '-b', 'main']);
    sh(otherRepo, 'git', ['commit', '--allow-empty', '-qm', 'private fixture']);
    const other = await hub.coord.registerProject(otherRepo);

    const owner = fleetClient(url, hub.token);
    const invite = await owner['fleet.invite']({ projectId: project.id });
    const response = await fetch(`${url}/api/pair`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invite.code, machineId: 'm-paired' }),
      signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const paired = (await response.json()).result as { token: string };
    const channel = await connectWorker({ hub: url, machineId: 'm-paired', projectIds: [project.id], token: paired.token });
    assert.equal(channel.identity.kind, 'worker');
    await assert.rejects(channel.client['project.list']({}), /denied|not permitted/i);
    assert.equal((await channel.client['worker.project']({ projectId: project.id })).id, project.id);
    await assert.rejects(channel.client['worker.project']({ projectId: other.id }), /denied|scope/i);

    const calls: string[] = [];
    const client = new Proxy(channel.client, { get(target, name: keyof Client) {
      if (name === 'then' as keyof Client) return undefined;
      const method = target[name];
      return (params: never) => { calls.push(name); return method(params); };
    } });
    const transport = httpTransport(url, paired.token, 'm-paired');
    const fetched: string[] = [];
    let uploaded: Task | undefined;
    const observed: BranchTransport = {
      async fetchBase(p, repo, sha, signal) {
        fetched.push(sha);
        await transport.fetchBase(p, repo, sha, signal);
        assert.equal(hasCommit(repo, sha), true, 'real HTTP bundle fetch installs the requested commit');
      },
      async uploadBranch(task, repo, branch, base, signal) {
        const receipt = await transport.uploadBranch(task, repo, branch, base, signal);
        assert.equal(receipt.head, task.head_sha);
        uploaded = task;
        return receipt;
      },
    };
    const worktreeRoot = join(box.root, 'worker-worktrees');
    const local = resolveConfig([loadConfig(), { worktreeRoot }]);
    const worker = () => {
      const value = new WorkerLoop({ hub: url, client, machineId: 'm-paired', repos: () => ({ [project.id]: clone }),
        agents: () => ['mock'], localConfig: () => local, verifySlots: new Semaphore(1), transport: observed });
      workers.push(value);
      return value;
    };
    const first = worker();
    const task = hub.coord.addTasks(project.id, [{ title: 'Clean an accepted paired artifact',
      prompt: '@mock write accepted.txt paired artifact', agent: 'mock', files: ['accepted.txt'],
      verify: ["node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('accepted.txt','utf8').trim(), 'paired artifact')\""] }], 'paired cleanup').created[0]!;
    await first.tick();
    const done = (await settleTasks(hub.coord, [task.id], box.root, 25_000))[0]!;
    assert.equal(done.status, 'done', done.attention ?? done.last_error ?? 'paired task must integrate');
    await until(() => first.active.size, size => size === 0, 5000, 'paired worker finishing its acknowledged upload');
    assert.ok(uploaded, 'the real runner uploaded its verified artifact');
    assert.ok(uploaded.worktree && uploaded.head_sha && uploaded.branch);
    const path = uploaded.worktree;
    const head = uploaded.head_sha;
    const branch = uploaded.branch;
    const merge = done.head_sha!;
    assert.notEqual(merge, head, 'single-task integration records a new merge commit');
    assert.equal(hasCommit(clone, merge), false, 'the worker clone does not already contain the integration merge');
    assert.equal(sh(box.repo, 'git', ['rev-list', '--parents', '-n', '1', merge]).split(' ').length, 3, 'integration created a two-parent merge');
    assert.equal(sh(box.repo, 'git', ['rev-parse', `refs/yardmaster/accepted/${task.id}/${done.generation}`]), head);
    assert.equal(sh(path, 'git', ['rev-parse', 'HEAD']), head);
    assert.equal(readFileSync(join(path, 'accepted.txt'), 'utf8').trim(), 'paired artifact');
    const events = hub.coord.eventsSince(0, project.id, 100, task.id);
    for (const kind of ['task.ready', 'task.branch_received', 'task.done']) assert.ok(events.some(event => event.kind === kind), kind);
    assert.equal(hub.coord.latestRun(task.id)!.machine_id, 'm-paired');

    // A fresh controller must recover the durable accepted artifact, not borrow the first controller's memory.
    first.stopAll('shutdown', 'restart paired cleanup fixture');
    await first.drain();
    assert.equal(first.active.size, 0);
    const journalChannel = { hub: url, projectIds: [project.id] };
    const saved = new WorkerJournal('m-paired', journalChannel);
    assert.equal(saved.artifacts[task.id]!.head, head);
    assert.equal(saved.artifacts[task.id]!.uploaded, true);
    assert.deepEqual(saved.runs, {});

    const keep = join(dirname(path), 't-unrelated');
    sh(clone, 'git', ['worktree', 'add', '-qb', 'local/keep', keep, mainHead]);
    calls.length = 0;
    const restarted = worker();
    await restarted.tidyLocal();
    assert.deepEqual(fetched, [merge], 'tidy fetched exactly the previously missing integration commit');
    assert.ok(calls.includes('worker.project'), 'cleanup obtained scoped project metadata over paired HTTP');
    assert.equal(calls.includes('project.list'), false, 'cleanup never requested owner inventory');
    assert.equal(existsSync(path), false, 'the unchanged accepted worktree was removed');
    assert.equal(sh(clone, 'git', ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]), '', 'its exact accepted branch was deleted');
    assert.equal(existsSync(keep), true, 'unrelated worktree remains');
    assert.equal(sh(keep, 'git', ['rev-parse', 'HEAD']), mainHead);
    assert.equal(sh(clone, 'git', ['rev-parse', 'refs/heads/local/keep']), mainHead);
    assert.equal(sh(clone, 'git', ['branch', '--show-current']), 'main');
    assert.equal(sh(clone, 'git', ['rev-parse', 'main']), mainHead);
    assert.equal(new WorkerJournal('m-paired', journalChannel).artifacts[task.id], undefined, 'successful cleanup retired the durable artifact');
    await assert.rejects(channel.client['project.list']({}), /denied|not permitted/i);
    await assert.rejects(channel.client['worker.project']({ projectId: other.id }), /denied|scope/i);
  } finally {
    for (const worker of workers) worker.stopAll('shutdown', 'paired cleanup fixture finished');
    await Promise.all(workers.map(worker => worker.drain()));
    await hub.stop();
    hub.coord.db.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});
