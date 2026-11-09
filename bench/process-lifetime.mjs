// Compare ordinary-launch overhead. The older implementation has weaker detached-child cleanup.
// No inference, personal hub, source copies or worktrees. Run: node bench/process-lifetime.mjs <base SHA>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, loadavg, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.argv[2];
if (!base || !/^[0-9a-f]{7,40}$/.test(base)) throw new Error('Supply a local baseline commit SHA.');
if (process.argv[3] === 'worker') {
  const home = mkdtempSync(join(tmpdir(), 'ym-process-bench-'));
  process.env.YARDMASTER_HOME = home;
  delete process.env.YARDMASTER_HUB; delete process.env.YARDMASTER_TOKEN;
  if (process.argv[4] === 'baseline') {
    const url = pathToFileURL(join(root, 'src/proc.ts')).href;
    registerHooks({ load(specifier, context, next) {
      return specifier === url ? { format: 'module-typescript', shortCircuit: true,
        source: execFileSync('git', ['show', `${base}:src/proc.ts`], { cwd: root, encoding: 'utf8' }) } : next(specifier, context);
    } });
  }
  try {
    const { runOwnedProcess } = await import('../src/proc.ts');
    const samples = [];
    const width = Number(process.argv[5]);
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: width }, () => runOwnedProcess(process.execPath, ['-e', ''], { cwd: home, env: process.env })));
      if (results.some(r => r.code !== 0 || !r.reaped)) throw new Error('A measured launch failed or retained unconfirmed cleanup.');
      if (i) samples.push(performance.now() - start);
    }
    console.log(JSON.stringify({ width, samples }));
  } finally { rmSync(home, { recursive: true, force: true }); }
} else {
  const sources = () => Object.fromEntries(['src/proc.ts','src/process-ownership.ts','src/paths.ts', 'bench/process-lifetime.mjs']
    .map(file => [file, createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
  const before = sources();
  const runs = [];
  for (const width of [1, 3]) for (let pair = 0; pair < 2; pair++) {
    for (const revision of pair % 2 ? ['candidate','baseline'] : ['baseline','candidate']) {
      const value = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), base, 'worker', revision, String(width)], { cwd: root, encoding: 'utf8' }));
      runs.push({ pair, revision, ...value });
    }
  }
  const median = a => { a = [...a].sort((x,y) => x-y); return (a[Math.floor((a.length-1)/2)] + a[Math.ceil((a.length-1)/2)]) / 2; };
  if (JSON.stringify(before) !== JSON.stringify(sources())) throw new Error('Candidate source changed during measurement.');
  console.log(JSON.stringify({ base, head: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    trackedTreeClean: execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()==='', sourceSha256: before,
    node: process.version, platform: platform(), arch: arch(), loadAverage: loadavg(), method: 'Node exit0 child, one warmup and five calls per worker, two alternating process pairs per width; ordinary cleanup only, no provider or filesystem workflow.',
    qualification: 'Both revisions must exit0 and report reaped; the baseline does not provide the new inherited-marker descendant guarantee. This measures the safety cost, not equivalent containment or universal latency.',
    medians: [1,3].map(width => ({ width, baselineMs: median(runs.filter(r=>r.width===width&&r.revision==='baseline').flatMap(r=>r.samples)), candidateMs: median(runs.filter(r=>r.width===width&&r.revision==='candidate').flatMap(r=>r.samples)) })), runs, fixturesRemoved: true },null,2));
}
