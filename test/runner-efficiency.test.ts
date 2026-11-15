import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, localClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { runAttempt, Semaphore, type StopReason } from '../src/runner.ts';
import { sandbox, sh, until } from './helpers.ts';

async function fixture(prompt = '@mock sleep 60000', overlap = 10) {
  const box = sandbox({ liveOverlapIntervalSeconds: overlap, review: { mode: 'never' }, worktree: { warmStart: 'off' } });
  const db = openDb(join(box.home, 'runner.db'));
  const coord = new Coordinator(db), project = await coord.registerProject(box.repo);
  coord.addTasks(project.id, [{ title: 'Runner efficiency', prompt, agent: 'mock' }], 'test');
  const claim = coord.claimNext({ machineId: 'm', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} })!;
  const api = localClient(buildMethods(coord, { machineId: 'm' }));
  const ctx = { api, task: claim.task, project, machineId: 'm', agent: 'mock', model: null, repoPath: box.repo,
    config: loadConfig(box.repo), startPoint: sh(box.repo, 'git', ['rev-parse', 'HEAD']), verifySlots: new Semaphore(1) };
  return { db, coord, ctx };
}

for (const mode of ['cancel', 'stop', 'stop-pause', 'redirect', 'generation', 'expiry', 'outage'] as const) {
  test(`the shared control loop preserves ${mode} response and claim expiry during preparation`, async (t) => {
    const f = await fixture();
    let entered = false;
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
    const running = runAttempt({ ...f.ctx,
      prepareBase: async signal => {
        entered = true;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
          reject(new Error('preparation aborted'));
        }, { once: true }));
      },
    });
    try {
      await setImmediate(); assert.equal(entered, true);
      // Observe the loop's effect at its public boundary, before another timer period can elapse.
      const peek = f.ctx.api['task.peek'];
      t.mock.method(f.ctx.api, 'task.peek', async p => {
        if (mode === 'outage') throw new Error('offline');
        const task = await peek(p);
        return { ...task,
          ...(mode === 'cancel' ? { status: 'canceled' as const } : {}),
          ...(['stop', 'stop-pause', 'redirect'].includes(mode) ? { control: mode as 'stop' | 'stop-pause' | 'redirect' } : {}),
          ...(mode === 'generation' ? { generation: task.generation + 1 } : {}),
          ...(mode === 'expiry' ? { lease_until: now } : {}),
        };
      });
      if (mode === 'outage') t.mock.timers.tick(90_001);
      else t.mock.timers.tick(250);
      await setImmediate();
      const outcome = await running;
      const reason = mode === 'cancel' ? 'canceled' : ['generation', 'expiry', 'outage'].includes(mode) ? 'lost' : mode === 'redirect' ? 'redirected' : mode === 'stop-pause' ? 'shutdown' : 'stopped';
      assert.equal(outcome.status, reason === 'canceled' ? 'canceled' : reason === 'lost' ? 'superseded' : ['shutdown', 'redirected'].includes(reason) ? 'queued' : 'needs_human');
    } finally { t.mock.timers.reset(); f.db.close(); }
  });
}

test('a running agent has one control poll per tick and sends usage/activity only when changed', async (t) => {
  const f = await fixture('@mock cost 0.1\n@mock sleep 60000');
  let stop: ((reason: StopReason, message: string) => void) | undefined;
  let polling = 0, usages = 0, activity = 0;
  const peek = f.ctx.api['task.peek'], usage = f.ctx.api['run.usage'], update = f.ctx.api['run.update'];
  t.mock.method(f.ctx.api, 'task.peek', async p => { polling++; return peek(p); });
  t.mock.method(f.ctx.api, 'run.usage', async p => { usages++; return usage(p); });
  t.mock.method(f.ctx.api, 'run.update', async p => { if ('last_activity' in p.patch) activity++; return update(p); });
  const running = runAttempt({ ...f.ctx, onSpawn: handler => { stop = handler; } });
  try {
    await until(() => f.coord.latestRun(f.ctx.task.id)?.phase, value => value === 'agent', 15_000, 'agent');
    // Sample two telemetry periods; process supervision keeps its real OS timers.
    const before = polling;
    await new Promise(resolve => setTimeout(resolve, 4500));
    assert.ok(polling - before <= 19, `one 250 ms loop, observed ${polling - before} peeks`);
    assert.equal(usages, 1);
    assert.equal(activity, 1);
    stop!('stopped', 'fixture finished');
    await running;
    assert.equal(usages, 1, 'an acknowledged identical final is not resent');
    assert.equal(f.coord.latestRun(f.ctx.task.id)!.cost_usd, .1);
  } finally {
    stop?.('shutdown', 'fixture cleanup');
    await running;
    f.db.close();
  }
});
