/** Disposable local benchmark. No provider calls or personal hub connection. */
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { sandbox } from '../test/helpers.ts';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, dispatch } from '../src/api.ts';
import { tx } from '../src/transaction.ts';

const box = sandbox({ coupling: 'off', review: { mode: 'never' }, cleanup: { auto: false } });
const db = openDb(join(box.home, 'benchmark.db'));
try {
  const coord = new Coordinator(db);
  const project = await coord.registerProject(box.repo);
  for (let batch = 0; batch < 20; batch++) coord.addTasks(project.id,
    Array.from({ length: 50 }, (_, index) => ({ title: `Benchmark work ${batch * 50 + index}`, agent: 'mock', files: [`component-${batch * 50 + index}/**`] })), 'benchmark', { force: true });
  tx(db, () => {
    const insert = db.prepare('INSERT INTO events (ts,project_id,task_id,level,kind,message,data) VALUES (?,?,NULL,?,?,?,NULL)');
    for (let index = 0; index < 10_000; index++) insert.run(Date.now(), project.id, 'info', 'benchmark', `Observed event ${index}`);
  });
  const methods = buildMethods(coord, { machineId: 'm-benchmark' });
  const measure = async (fn: () => unknown | Promise<unknown>) => {
    for (let i = 0; i < 5; i++) await fn();
    const values: number[] = [];
    for (let i = 0; i < 100; i++) { const start = performance.now(); await fn(); values.push(performance.now() - start); }
    values.sort((a, b) => a - b);
    return { p50Ms: values[49], p95Ms: values[94], maxMs: values[99], samples: values.length };
  };
  const results = {
    board: await measure(() => dispatch(methods, 'board.status', { projectId: project.id })),
    registry: await measure(() => dispatch(methods, 'registry.list', { projectId: project.id })),
    eventTail: await measure(() => dispatch(methods, 'events.since', { projectId: project.id, after: 9900, limit: 100 })),
    queueAdmission: await measure(() => {
      const claim = coord.claimNext({ machineId: 'm-benchmark', agents: ['mock'], repos: { [project.id]: box.repo }, runningByAgent: {} });
      if (!claim) throw new Error('Benchmark admission unexpectedly refused.');
      // This benchmark never launches a child. Release its unattached reservation explicitly.
      coord.abandonUnlaunchedClaim(claim.task.id, claim.task.generation, 'm-benchmark');
      coord.updateTask(claim.task.id, { status: 'done', finished_at: Date.now() });
    }),
  };
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    taskCount: 1000, seededEventCount: 10_000, transport: 'in-process API dispatch; excludes HTTP and browser',
    inference: 'none', results, memory: process.memoryUsage(), measuredAt: new Date().toISOString() }, null, 2));
} finally { db.close(); }
