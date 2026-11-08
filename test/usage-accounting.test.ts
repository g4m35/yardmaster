import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, sh, tempDir } from './helpers.ts';
import { UsageMeter } from '../src/usage.ts';
import { isAlive } from '../src/proc.ts';
import { runOneShot } from '../src/oneshot.ts';
import { runReview } from '../src/review.ts';
import { priceFor, resolveConfig, type Config } from '../src/config.ts';
import type { Task } from '../src/types.ts';

/** Spend is never lost or mislabeled: mixed provenance, dedup, snapshots, resume, and every review outcome. */

const price = { inPerM: 3, outPerM: 15, cachedInPerM: 0.3 };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
const u = (o: Partial<{ tokensIn: number; tokensOut: number; cachedIn: number; cacheWriteIn: number; costUsd: number; cumulative: boolean; id: string }>) =>
  ({ type: 'usage' as const, tokensIn: 0, tokensOut: 0, cumulative: false, ...o });

test('mixed actual and estimated usage keeps both parts', () => {
  const m = new UsageMeter(price);
  m.add(u({ tokensIn: 1000, tokensOut: 100, costUsd: 0.1, id: 'a' }));
  m.add(u({ tokensIn: 1000, tokensOut: 100, id: 'b' }));
  const est = (1000 * 3 + 100 * 15) / 1e6;
  near(m.spent, 0.1 + est, 'the estimated part is not dropped once one real figure arrives');
  near(m.actualUsd, 0.1);
  near(m.estimatedUsd, est);
  assert.equal(m.provenance, 'mixed');
  assert.equal(m.estimated, true);
  assert.equal(m.snapshot().events, 2);
});

test('repeated message ids count once, and only their growth is added', () => {
  const m = new UsageMeter(price);
  m.add(u({ tokensIn: 1000, tokensOut: 10, id: 'm' }));
  m.add(u({ tokensIn: 1000, tokensOut: 10, id: 'm' }));
  assert.equal(m.tokensOut, 10);
  m.add(u({ tokensIn: 1000, tokensOut: 50, id: 'm' }));
  assert.equal(m.tokensIn, 1000);
  assert.equal(m.tokensOut, 50);
  near(m.spent, (1000 * 3 + 50 * 15) / 1e6);
  assert.equal(m.snapshot().events, 1);
});

test('a cumulative snapshot replaces earlier increments; later increments add to it', () => {
  const m = new UsageMeter(price);
  m.add(u({ tokensIn: 500, tokensOut: 50, id: 'x' }));
  m.add(u({ tokensIn: 2000, tokensOut: 200, costUsd: 0.25, cumulative: true }));
  near(m.spent, 0.25);
  assert.equal(m.provenance, 'actual');
  assert.equal(m.estimated, false);
  assert.equal(m.tokensIn, 2000);
  m.add(u({ tokensIn: 3000, tokensOut: 300, costUsd: 0.4, cumulative: true }));
  near(m.spent, 0.4, 'a newer snapshot supersedes the older one');
  m.add(u({ tokensIn: 100, tokensOut: 0, id: 'late' }));
  assert.equal(m.provenance, 'mixed');
  near(m.spent, 0.4 + (100 * 3) / 1e6);
  // The duplicate of an id counted before the snapshot adds nothing.
  m.add(u({ tokensIn: 500, tokensOut: 50, id: 'x' }));
  near(m.spent, 0.4 + (100 * 3) / 1e6);
});

test('resume baselines: dollar totals are session-wide; token-only totals are not assumed to be', () => {
  const claude = new UsageMeter(price, 0.4);
  claude.add(u({ costUsd: 0.55, cumulative: true }));
  near(claude.spent, 0.15);
  near(claude.sessionTotal, 0.55);

  const unknown = new UsageMeter(price, 0.4);
  unknown.add(u({ tokensIn: 100_000, tokensOut: 10_000, cumulative: true }));
  const est = (100_000 * 3 + 10_000 * 15) / 1e6;
  near(unknown.spent, est, 'nothing subtracted on unverified semantics');
  assert.equal(unknown.provenance, 'estimated');
  assert.ok(unknown.snapshot().limitations.some((l) => /not verified/.test(l)), 'and it says so');

  const declared = new UsageMeter(price, 0.1, { resumedTokenSnapshots: 'session' });
  declared.add(u({ tokensIn: 100_000, tokensOut: 10_000, cumulative: true }));
  near(declared.spent, est - 0.1);
  const runOnly = new UsageMeter(price, 0.1, { resumedTokenSnapshots: 'run' });
  runOnly.add(u({ tokensIn: 100_000, tokensOut: 10_000, cumulative: true }));
  near(runOnly.spent, est);
  assert.ok(!runOnly.snapshot().limitations.some((l) => /not verified/.test(l)));
});

test('cache reads and writes are tracked separately; unknown writes and missing telemetry are not zeros', () => {
  const m = new UsageMeter(price);
  m.add(u({ tokensIn: 1000, cachedIn: 4000, tokensOut: 10, id: 'a' }));
  let s = m.snapshot();
  assert.equal(s.tokensIn, 5000, 'tokensIn keeps including cache reads');
  assert.equal(s.cacheReadTokens, 4000);
  assert.equal(s.cacheWriteTokens, null, 'no event reported writes');
  near(s.costUsd, (1000 * 3 + 4000 * 0.3 + 10 * 15) / 1e6);
  m.add(u({ tokensIn: 600, cacheWriteIn: 500, tokensOut: 0, id: 'b' }));
  s = m.snapshot();
  assert.equal(s.cacheWriteTokens, 500);

  const none = new UsageMeter(price).snapshot();
  assert.equal(none.provenance, 'unknown');
  assert.equal(none.costUsd, 0);
  assert.equal(none.events, 0);
  assert.equal(new UsageMeter(price).estimated, true, 'compatible: unmeasured is not reported as an actual figure');
});

// ---------- one-shot and review accounting, with a fixture CLI ----------

const box = sandbox();
const dir = tempDir('ym-usage-');
const node = process.execPath;
const fixture = join(dir, 'agent.mjs');
writeFileSync(fixture, `
import { writeFileSync, renameSync } from 'node:fs';
const mode = process.env.FIXTURE_MODE;
const pidFile = process.env.FIXTURE_PID;
if (pidFile) { writeFileSync(pidFile + '.tmp', String(process.pid)); renameSync(pidFile + '.tmp', pidFile); }
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const assistant = (id, text, input = 1000, output = 100) => line({ type: 'assistant', message: { id, content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0 } } });
const result = (text, cost, ok = true) => line({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: text, total_cost_usd: cost, usage: { input_tokens: 2000, output_tokens: 200 } });
const verdict = JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' });
switch (mode) {
  case 'verdict': assistant('m1', 'reading'); assistant('m1', 'reading'); result(verdict, 0.42); break;
  case 'malformed': assistant('m1', 'thinking'); result('UNREADABLE', 0.7); break;
  case 'nonzero': result(verdict, 0.3); process.exitCode = 3; break;
  case 'error-result': result(verdict, 0.2, false); break;
  case 'hang': assistant('m1', 'working'); setInterval(() => {}, 1000); break;
  case 'spender': { let i = 0; setInterval(() => assistant('s' + i++, 'more', 200_000, 10_000), 20); break; }
  default: process.exit(2);
}
`);
const agent = join(dir, 'agent.sh');
writeFileSync(agent, `#!/bin/sh\nexec "${node}" "${fixture}"\n`);
chmodSync(agent, 0o755);

function cfg(extra: Record<string, unknown> = {}): Config {
  return resolveConfig([{ agents: { claude: { enabled: true, command: agent, models: { standard: 'review-model' } } }, review: { reviewers: ['claude'], ...extra } }]);
}

let n = 0;
const pidFile = () => join(dir, `r${++n}.pid`);

after(() => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pid'))) {
    const pid = Number(readFileSync(join(dir, f), 'utf8'));
    if (!isAlive(pid)) continue;
    let cmd = '';
    try {
      cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (cmd.includes(dir)) process.kill(pid, 'SIGKILL');
  }
});

const task = { id: 'task-1', title: 'Fix the bug', prompt: 'Fix the bug', review_rounds: 0 } as Task;
writeFileSync(join(box.repo, 'feature.js'), 'export const x = 1;\n');
sh(box.repo, 'git', ['add', '.']);
sh(box.repo, 'git', ['commit', '-qm', 'feature']);
const base = sh(box.repo, 'git', ['rev-parse', 'HEAD~1']);

function review(mode: string, opts: { config?: Config; signal?: AbortSignal; hooks?: Parameters<typeof runReview>[0]['hooks'] } = {}) {
  const pid = pidFile();
  process.env.FIXTURE_MODE = mode;
  process.env.FIXTURE_PID = pid;
  const p = runReview({ task, config: opts.config ?? cfg(), implementer: 'codex', installed: ['claude'], cwd: box.repo, base, signal: opts.signal, hooks: opts.hooks });
  return { p, pid };
}

test('a valid review carries actual cost, model and timing', async () => {
  const { p } = review('verdict');
  const r = await p;
  assert.ok(!('skipped' in r), 'accepted');
  if ('skipped' in r) return;
  assert.equal(r.review.verdict, 'approve');
  near(r.costUsd, 0.42, 'the final total replaces the incremental estimate');
  assert.equal(r.costEstimated, false);
  assert.equal(r.usage.provenance, 'actual');
  assert.equal(r.model, 'review-model');
  assert.equal(r.status, 'succeeded');
  assert.ok(r.endedAt >= r.startedAt);
  assert.equal(r.reaped, true);
});

test('an unreadable review keeps its spend', async () => {
  const r = await review('malformed').p;
  assert.ok('skipped' in r);
  if (!('skipped' in r)) return;
  assert.equal(r.reason, 'unreadable');
  near(r.costUsd, 0.7);
  assert.equal(r.usage.provenance, 'actual');
  assert.equal(r.model, 'review-model');
  assert.equal(r.required, false);
});

test('a nonzero exit or error result is not accepted as a verdict, and keeps its spend', async () => {
  const nz = await review('nonzero').p;
  assert.ok('skipped' in nz && nz.reason === 'failed', 'parsable JSON from a failed run is not a verdict');
  near(nz.costUsd, 0.3);
  assert.equal(nz.status, 'failed');
  assert.match(nz.error, /code 3/);
  const er = await review('error-result').p;
  assert.ok('skipped' in er && er.reason === 'failed');
  near(er.costUsd, 0.2);
});

test('a canceled review stops its reviewer, keeps the spend so far, and runs the registry hooks in order', async () => {
  const ac = new AbortController();
  const calls: string[] = [];
  let spawnedPid = 0;
  const { p } = review('hang', {
    signal: ac.signal,
    hooks: {
      beforeLaunch: (info) => {
        calls.push(`before:${info.reviewer}:${info.model}`);
      },
      onSpawn: (proc) => {
        calls.push('spawn');
        spawnedPid = proc.pid;
        assert.ok(proc.startedAt !== null);
      },
      onUsage: (snap) => {
        calls.push('usage');
        assert.ok(snap.costUsd > 0);
        ac.abort();
      },
    },
  });
  const r = await p;
  assert.deepEqual(calls, ['before:claude:review-model', 'spawn', 'usage']);
  assert.ok('skipped' in r && r.reason === 'canceled');
  assert.equal(r.status, 'canceled');
  near(r.costUsd, (1000 * priceFor(cfg(), 'claude', 'review-model').inPerM + 100 * priceFor(cfg(), 'claude', 'review-model').outPerM) / 1e6);
  assert.equal(r.usage.provenance, 'estimated');
  assert.equal(r.costEstimated, true);
  assert.equal(r.reaped, true);
  assert.equal(isAlive(spawnedPid), false, 'no reviewer outlives the cancel');
});

test('strict review marks every non-accepted outcome as required; a failing launch hook spawns nothing', async () => {
  const strict = cfg({ required: true });
  const r = await review('malformed', { config: strict }).p;
  assert.ok('skipped' in r && r.required === true);
  near(r.costUsd, 0.7);
  const none = await runReview({ task, config: strict, implementer: 'codex', installed: [], cwd: box.repo, base });
  assert.ok('skipped' in none && none.reason === 'no_reviewer' && none.required === true);
  assert.equal(none.status, 'not_started');
  assert.equal(none.usage.provenance, 'unknown');
  assert.equal(cfg().review.required, false, 'off by default');

  const { p, pid } = review('verdict', { hooks: { beforeLaunch: () => { throw new Error('hub unreachable'); } } });
  await assert.rejects(p, /hub unreachable/);
  assert.equal(existsSync(pid), false, 'the reviewer never started');

  const pre = await review('verdict', { signal: AbortSignal.abort() }).p;
  assert.ok('skipped' in pre && pre.reason === 'canceled' && pre.status === 'not_started');
});

test('runOneShot enforces its budget reactively and reports the stop as a budget stop', async () => {
  const pid = pidFile();
  const r = await runOneShot({ agent: 'claude', config: cfg(), prompt: 'x', cwd: dir, budgetUsd: 1, termGraceMs: 500, env: { FIXTURE_MODE: 'spender', FIXTURE_PID: pid } });
  assert.equal(r.status, 'budget');
  assert.equal(r.ok, false);
  assert.match(r.error, /budget of \$1\.00/);
  assert.ok(r.costUsd > 1, 'reactive: the stop follows the event that crossed the limit');
  const perEvent = (200_000 * priceFor(cfg(), 'claude', null).inPerM + 10_000 * priceFor(cfg(), 'claude', null).outPerM) / 1e6;
  assert.ok(r.costUsd <= 1 + perEvent * 5, `overshoot stays near one event (${r.costUsd})`);
  assert.equal(isAlive(Number(readFileSync(pid, 'utf8'))), false);
});

test('runOneShot timeout is distinct from failure and keeps usage; usage hook errors do not change the outcome', async () => {
  const pid = pidFile();
  const t = await runOneShot({ agent: 'claude', config: cfg(), prompt: 'x', cwd: dir, timeoutMs: 400, termGraceMs: 500, env: { FIXTURE_MODE: 'hang', FIXTURE_PID: pid } });
  assert.equal(t.status, 'timeout');
  assert.match(t.error, /timed out/);
  assert.equal(t.usage.events, 1);
  assert.equal(isAlive(Number(readFileSync(pid, 'utf8'))), false);

  const ok = await runOneShot({
    agent: 'claude', config: cfg(), prompt: 'x', cwd: dir, env: { FIXTURE_MODE: 'verdict', FIXTURE_PID: pidFile() },
    hooks: { onUsage: () => Promise.reject(new Error('live update failed')) },
  });
  assert.equal(ok.status, 'succeeded');
  assert.ok(ok.hookErrors.some((e) => /live update failed/.test(e)));
  near(ok.costUsd, 0.42);
});
