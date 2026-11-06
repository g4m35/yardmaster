import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

const created: string[] = [];
process.on('exit', () => {
  if (process.env.YM_KEEP_TMP) return;
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** A throwaway home + repo so tests never touch the real ~/.yardmaster or any real repository. */
export function sandbox(globalConfig: Record<string, unknown> = {}) {
  const root = tempDir('ym-test-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  process.env.YARDMASTER_HOME = home;
  process.env.YARDMASTER_ENABLE_MOCK = '1';
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      notify: false,
      worktreeRoot: join(root, 'worktrees'),
      routing: { cheap: ['mock'], standard: ['mock'], strong: ['mock'] },
      retry: { backoffSeconds: 0 },
      // Scenarios pin their own tiers; cheap-first routing has its own test.
      cheapFirst: false,
      liveOverlapIntervalSeconds: 0.5,
      resources: { maxLoadPerCpu: 1000, minFreeMemMb: 0 },
      // Tests must never start real agents that happen to be installed on the machine.
      agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false }, cursor: { enabled: false }, gemini: { enabled: false } },
      review: { reviewers: ['mock'], crossFamily: false },
      ...globalConfig,
    }),
  );
  const repo = join(root, 'repo');
  mkdirSync(repo);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.name', 'Test User']);
  sh(repo, 'git', ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  // Verification used by every scenario: fails if any tracked file contains the word BROKEN.
  writeFileSync(
    join(repo, 'check.mjs'),
    `import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\\n').filter(Boolean);
const marker = 'BRO' + 'KEN';
const bad = files.filter((f) => { try { return readFileSync(f, 'utf8').includes(marker); } catch { return false; } });
if (bad.length) { console.error(marker + ' found in ' + bad.join(', ')); process.exit(1); }
console.log('checks ok');
`,
  );
  writeFileSync(join(repo, 'yardmaster.json'), JSON.stringify({ verify: ['node check.mjs'] }, null, 2));
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-q', '-m', 'init']);
  return { root, home, repo };
}

export async function until<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (pred(last)) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last, null, 1).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Waits for tasks to finish; if they don't, the error says where each one stopped (status, events, its latest run)
 * and which processes under the test's folder are still running. Rare stalls on busy CI machines are otherwise
 * impossible to diagnose from a JSON dump of the first task.
 */
export async function settleTasks(
  coord: { getTask(id: string): { status: string; title: string } | null | undefined; eventsSince(after: number, projectId?: string | null, limit?: number, taskId?: string | null): { kind: string; message: string }[]; latestRun(id: string): unknown },
  ids: string[],
  root: string,
  timeoutMs = 40_000,
) {
  const done = ['done', 'needs_human', 'failed', 'canceled'];
  try {
    return await until(() => ids.map((id) => coord.getTask(id)!), (ts) => ts.every((t) => done.includes(t.status)), timeoutMs, 'tasks to settle');
  } catch (err) {
    const lines = ids.map((id) => {
      const t = coord.getTask(id);
      const trail = coord.eventsSince(0, null, 40, id).map((e) => `    ${e.kind}: ${e.message.slice(0, 200)}`).join('\n');
      return `${id} "${t?.title}" ${t?.status}\n${trail}\n    run: ${JSON.stringify(coord.latestRun(id) ?? null).slice(0, 400)}`;
    });
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' }).stdout
      .split('\n').filter((l) => l.includes(root)).join('\n');
    throw new Error(`${(err as Error).message.split('.')[0]}.\n${lines.join('\n')}\nProcesses under the test folder:\n${ps || '(none)'}`);
  }
}
