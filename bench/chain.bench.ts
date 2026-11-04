// Time for a chain of dependent tasks to flow through with instant agents: measures scheduling latency.
// Run: node bench/chain.bench.ts
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ym-chain-')));
process.env.YARDMASTER_HOME = join(root, 'home');
process.env.YARDMASTER_ENABLE_MOCK = '1';
mkdirSync(process.env.YARDMASTER_HOME, { recursive: true });
writeFileSync(join(process.env.YARDMASTER_HOME, 'config.json'), JSON.stringify({
  notify: false, worktreeRoot: join(root, 'wt'), routing: { cheap: ['mock'], standard: ['mock'], strong: ['mock'] },
  resources: { maxLoadPerCpu: 1000, minFreeMemMb: 0 }, review: { mode: 'never' }, disk: { minFreeGb: 0 },
}));
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'yardmaster.json'), JSON.stringify({ verify: ['true'] }));
git('add', '-A');
git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i');

const { Hub } = await import('../src/hub.ts');
const { openDb } = await import('../src/db.ts');
const hub = new Hub({ db: openDb(join(root, 'y.db')), token: 't', port: 0, host: '127.0.0.1', includeMock: true, quiet: true });
await hub.start();
const p = await hub.coord.registerProject(repo);
const N = 5;
const tasks = Array.from({ length: N }, (_, i) => ({ key: `k${i}`, title: `Chain step number ${i}`, prompt: `@mock write step${i}.txt ${i}`, agent: 'mock', after: i ? [`k${i - 1}`] : [] }));
const start = performance.now();
const created = hub.coord.addTasks(p.id, tasks, 'bench').created;
for (;;) {
  if (created.every((t) => hub.coord.getTask(t.id)!.status === 'done')) break;
  await new Promise((r) => setTimeout(r, 20));
}
const total = performance.now() - start;
const runs = created.map((t) => hub.coord.runsFor(t.id)[0]!);
const agentMs = runs.reduce((n, r) => n + ((r.ended_at ?? 0) - r.started_at), 0);
console.log(`${N}-step chain: ${(total / 1000).toFixed(2)} s total, ${(agentMs / 1000).toFixed(2)} s inside agents, ${((total - agentMs) / N).toFixed(0)} ms overhead per step`);
await hub.stop();
