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
      liveOverlapIntervalSeconds: 0.5,
      resources: { maxLoadPerCpu: 1000, minFreeMemMb: 0 },
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
