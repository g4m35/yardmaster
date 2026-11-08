// Measures scheduler and dashboard cost with a large board. Run: node bench/scheduler.bench.ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'ym-bench-'));
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
  if (process.env.YM_BENCH_CHILD_REV) console.log(JSON.stringify({ kind: 'cleanup', fixtureRemoved: !existsSync(root) }));
});
process.env.YARDMASTER_HOME = join(root, 'home');
mkdirSync(process.env.YARDMASTER_HOME, { recursive: true });
writeFileSync(join(process.env.YARDMASTER_HOME, 'config.json'), JSON.stringify({ routing: { cheap: ['mock'], standard: ['mock'], strong: ['mock'] } }));
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'x');
git('add', '-A');
git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i');

const { openDb } = await import('../src/db.ts');
const { Coordinator } = await import('../src/coordinator.ts');
const { boardSummary } = await import('../src/api.ts');
const coord = new Coordinator(openDb(join(root, 'y.db')));
const p = await coord.registerProject(repo);
const QUEUED = Number(process.env.N ?? 300);
const tasks = Array.from({ length: QUEUED }, (_, i) => ({ title: `Task number ${i} about module ${i % 40} feature ${i}`, prompt: `work item ${i} unique ${i * 7919}`, files: [`src/mod${i % 40}/**`], agent: 'mock', after: [] as string[] }));
for (let i = 0; i < tasks.length; i += 50) {
  for (let retry = 0; ; retry++) {
    try { coord.addTasks(p.id, tasks.slice(i, i + 50), 'bench', { force: true }); break; }
    catch (error) {
      if (retry >= 10 || !(error instanceof Error) || error.message !== 'UNIQUE constraint failed: tasks.id') throw error;
    }
  }
}
// 30 of them running, so most queued tasks are blocked by scope overlap (the expensive path).
const all = coord.listTasks(p.id);
for (const t of all.slice(0, 30)) coord.updateTask(t.id, { status: 'running', assignee: 'machine:m', machine_id: 'm', lease_until: Date.now() + 1e9 });
const time = (label: string, fn: () => unknown, reps = 5) => {
  fn();
  const s = performance.now();
  for (let i = 0; i < reps; i++) fn();
  console.log(`${label.padEnd(38)} ${((performance.now() - s) / reps).toFixed(1)} ms`);
};
const req = { machineId: 'm-other', agents: ['nothing-installed'], repos: { [p.id]: repo }, runningByAgent: {} };
time(`claimNext, ${QUEUED} queued (no match)`, () => coord.claimNext(req));
time('board.status (dashboard, hooks)', () => boardSummary(coord, p.id));
time('blocker() for every queued task', () => coord.listTasks(p.id, ['queued']).forEach((t) => coord.blocker(t)));
coord.db.close();
