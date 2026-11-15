// Paired, provider-free measurements; baseline modules load from Git objects without another checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const revision = process.env.YM_EFFICIENCY_REV;
if (!revision) {
  const base = git('rev-parse', '--verify', `${process.argv[2] ?? 'origin/main'}^{commit}`);
  const results = [];
  for (const rev of [base, 'working']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, encoding: 'utf8',
      env: { ...process.env, YM_EFFICIENCY_REV: rev }, timeout: 60_000 });
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stderr);
    results.push(JSON.parse(child.stdout));
  }
  console.log(JSON.stringify({ base, head: git('rev-parse', 'HEAD'), trackedTreeClean: git('status', '--porcelain', '--untracked-files=no') === '',
    node: process.version, platform: process.platform, cores: cpus().length, load: loadavg(),
    method: 'Sequential baseline/candidate processes; identical in-memory fixtures. Usage: 1800 snapshots, first/last 100 mean ms per call. Supervisor: 1000 tasks, one warmup and five timed calls. No providers, HTTP or browser.',
    results }, null, 2));
} else {
  if (revision !== 'working') registerHooks({ load(url, context, next) {
    if (!url.startsWith(new URL('../src/', import.meta.url).href)) return next(url, context);
    const relative = fileURLToPath(url).slice(root.length);
    return { source: git('show', `${revision}:${relative}`), format: 'module-typescript', shortCircuit: true };
  } });
  const { openDb } = await import('../src/db.ts');
  const { Coordinator } = await import('../src/coordinator.ts');
  const { Supervisor } = await import('../src/supervisor.ts');
  const { sandbox } = await import('../test/helpers.ts');
  const box = sandbox({ supervision: { queueStallMinutes: 1000 }, budget: { dailyUsd: 1000 } });
  const fixture = () => {
    const db = openDb(':memory:');
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id,name,root,base_branch,created_at) VALUES ('p','fixture',?,'main',?)`).run(box.repo, now);
    return { db, coord: new Coordinator(db), now };
  };
  function addTask(db, id, now, status = 'running') {
    db.prepare(`INSERT INTO tasks (id,project_id,title,prompt,fingerprint,status,tier,scope,max_attempts,created_by,created_at,updated_at)
      VALUES (?,'p',?,'fixture',?,?,'standard',?,3,'bench',?,?)`).run(id, id, id, status, JSON.stringify([`src/mod${Number(id.slice(1)) % 40}/**`]), now, now);
  }
  function usage(growth) {
    const { db, coord, now } = fixture();
    try {
      addTask(db, 't0', now);
      db.prepare(`INSERT INTO runs (id,task_id,machine_id,generation,attempt,agent,status,started_at,role)
        VALUES ('r','t0','m',1,1,'mock','running',?,'implement')`).run(now);
      let kicks = 0; coord.onChange = () => { kicks++; };
      const samples = [];
      for (let sequence = 1; sequence <= 1800; sequence++) {
        const start = performance.now();
        coord.recordRunUsage('r', 't0', { generation: 1, assignee: 'machine:m' }, sequence,
          { costUsd: growth ? sequence / 1000 : .5, tokensIn: growth ? sequence : 100, tokensOut: 10, provenance: 'actual', cacheReadTokens: null, cacheWriteTokens: null });
        samples.push(performance.now() - start);
      }
      const mean = list => list.reduce((sum, n) => sum + n, 0) / list.length;
      return { first100Ms: mean(samples.slice(0, 100)), last100Ms: mean(samples.slice(-100)), kicks,
        ledgerRows: db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get().n };
    } finally { db.close(); }
  }
  function supervisor() {
    const { db, coord, now } = fixture();
    try {
      for (let i = 0; i < 1000; i++) addTask(db, `t${i}`, now, i < 30 ? 'running' : 'queued');
      const supervisor = new Supervisor(coord);
      const measure = fn => { fn(); const start = performance.now(); for (let i = 0; i < 5; i++) fn(); return (performance.now() - start) / 5; };
      return { checkMs: measure(() => supervisor.check(now)), explicitPassMs: measure(() => coord.pass(() => supervisor.check(now))) };
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ revision, unchanged: usage(false), growth: usage(true), supervisor: supervisor() }));
}
