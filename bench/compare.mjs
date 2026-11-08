// Interleaved isolated-process comparison. Product revisions load from Git in memory; no source checkout/copy.
import { execFileSync, spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const revision = process.env.YM_BENCH_CHILD_REV;
if (revision) {
  const cache = new Map();
  registerHooks({ load(url, context, next) {
    if (revision === 'working' || !url.startsWith('file:')) return next(url, context);
    const file = fileURLToPath(url);
    if (!file.startsWith(resolve(root, 'src') + '/')) return next(url, context);
    const relative = file.slice(root.length);
    if (!cache.has(relative)) cache.set(relative, git('show', `${revision}:${relative}`));
    return { source: cache.get(relative), format: 'module-typescript', shortCircuit: true };
  } });
  process.on('exit', () => console.log(JSON.stringify({ kind: 'resources', rssBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS })));
  await import('./scheduler.bench.ts');
} else {
  const input = process.argv[2];
  if (!input || !/^[a-f0-9]{7,40}$/.test(input)) throw new Error('Pass the fetched baseline Git commit.');
  const base = git('rev-parse', '--verify', `${input}^{commit}`);
  const head = git('rev-parse', 'HEAD');
  const idleSample = async () => {
    const before = cpus().map(cpu => cpu.times);
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = cpus().map(cpu => cpu.times);
    let idle = 0, total = 0;
    for (let i = 0; i < before.length; i++) for (const key of Object.keys(before[i])) {
      const delta = after[i][key] - before[i][key]; total += delta; if (key === 'idle') idle += delta;
    }
    return { idleFraction: total ? idle / total : null, loadAverage: loadavg() };
  };
  const runs = [];
  for (let round = 0; round < 4; round++) for (const rev of round % 2 ? ['working', base] : [base, 'working']) {
    const conditions = await idleSample();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, encoding: 'utf8',
      env: { ...process.env, N: '1000', YM_BENCH_CHILD_REV: rev }, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`Benchmark ${rev} failed: ${child.error ?? child.stderr}`);
    const lines = child.stdout.trim().split('\n');
    const metrics = Object.fromEntries(lines.flatMap(line => {
      const match = /^(.*?)\s+([\d.]+) ms$/.exec(line); return match ? [[match[1], Number(match[2])]] : [];
    }));
    if (Object.keys(metrics).length !== 3) throw new Error('Incomplete benchmark metrics.');
    const records = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const resources = records.find(record => record.kind === 'resources');
    const cleanup = records.find(record => record.kind === 'cleanup');
    if (!resources || cleanup?.fixtureRemoved !== true) throw new Error('Benchmark fixture cleanup/resource proof missing.');
    runs.push({ round, revision: rev === 'working' ? head : base, candidate: rev === 'working', conditions, metrics, resources, cleanup });
  }
  const median = values => { const sorted = values.toSorted((a, b) => a - b); return (sorted[1] + sorted[2]) / 2; };
  const comparisons = Object.fromEntries(Object.keys(runs[0].metrics).map(key => {
    const baselineMs = median(runs.filter(run => !run.candidate).map(run => run.metrics[key]));
    const candidateMs = median(runs.filter(run => run.candidate).map(run => run.metrics[key]));
    return [key, { baselineMs, candidateMs, ratio: candidateMs / baselineMs }];
  }));
  console.log(JSON.stringify({ head, base, trackedTreeClean: git('status', '--porcelain', '--untracked-files=no') === '',
    node: process.version, platform: process.platform, arch: process.arch, logicalCpus: cpus().length,
    totalBytes: totalmem(), freeBytes: freemem(), measuredAt: new Date().toISOString(),
    method: 'Same fixture, 1000 tasks, 30 running, four interleaved process pairs; each metric has one warm-up and five timed calls.',
    lowBackgroundLoadObserved: runs.every(run => run.conditions.idleFraction !== null && run.conditions.idleFraction >= .8),
    transport: 'in-process coordinator/API, excluding HTTP/browser; no provider inference', comparisons, runs }, null, 2));
}
