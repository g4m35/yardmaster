import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.ts';
import { selfCommand } from '../connect.ts';
import { detectVerify } from '../detect.ts';
import { git, isClean, mainRepoRoot, repoRoot, revParse } from '../git.ts';
import { paths, yardHome } from '../paths.ts';
import { spawnDetached } from '../proc.ts';
import { runVerify } from '../runner.ts';
import { tail } from '../text.ts';
import { warmStart } from '../warmstart.ts';
import { claimRefresh, readBudget, verdict } from './budget.ts';
import { repoSlugFromUrl, type GitHub } from './github.ts';
import { githubClient } from './token.ts';
import { isVerified, recordVerified, treeOf } from './verified.ts';

/**
 * The git pre-push gate. Every agent and every person pushes through git, so this is the one place that sees all
 * of them, whatever tool they use. It keeps pushes from starting CI that is bound to fail (checks run here first,
 * once per file tree), warns when a push would throw away a CI run in progress, and holds pushes to private repos
 * once the month's Actions allowance is gone. It never blocks on the network: GitHub lookups are short and optional.
 */

const ZERO = /^0+$/;

export interface PushUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export function parsePushInput(stdin: string): PushUpdate[] {
  return stdin
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef: localRef!, localSha: localSha!, remoteRef: remoteRef!, remoteSha: remoteSha! }))
    .filter((u) => !ZERO.test(u.localSha) && u.remoteRef.startsWith('refs/heads/'));
}

export function gateCommands(config: Config, root: string): string[] {
  if (config.ci.verify.length) return config.ci.verify;
  if (config.verify.length) return config.verify;
  return detectVerify(root);
}

interface RepoMeta {
  private: boolean;
  at: number;
}

async function repoIsPrivate(gh: GitHub, slug: string): Promise<boolean | null> {
  const file = join(yardHome(), 'ci', 'repos.json');
  let cache: Record<string, RepoMeta> = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, RepoMeta>;
  } catch {
    // first use
  }
  const hit = cache[slug];
  if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.private;
  const meta = await gh.get<{ private: boolean }>(`/repos/${slug}`).catch(() => null);
  if (!meta) return hit?.private ?? null;
  cache[slug] = { private: meta.private, at: Date.now() };
  mkdirSync(join(yardHome(), 'ci'), { recursive: true });
  writeFileSync(file, JSON.stringify(cache));
  return meta.private;
}

function spawnSelf(args: string[]): void {
  const [cmd, ...pre] = selfCommand();
  const log = openSync(join(paths.logs(), 'ci-background.log'), 'a');
  const child = spawnDetached(cmd!, [...pre, ...args], { stdio: ['ignore', log, log], env: process.env });
  child.unref();
  closeSync(log);
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
}

export interface GateResult {
  code: number;
  lines: string[];
}

export async function runGate(opts: { cwd: string; remoteUrl: string; stdin: string; env?: NodeJS.ProcessEnv }): Promise<GateResult> {
  const env = opts.env ?? process.env;
  const lines: string[] = [];
  const say = (s: string) => lines.push(`Yardmaster CI: ${s}`);
  if (env.YM_CI_SKIP) return { code: 0, lines };
  const force = !!env.YM_CI_FORCE;
  const updates = parsePushInput(opts.stdin);
  if (!updates.length) return { code: 0, lines };
  const root = (await mainRepoRoot(opts.cwd)) ?? opts.cwd;
  const here = (await repoRoot(opts.cwd)) ?? root;
  const config = loadConfig(root);
  if (config.ci.gate === 'off') return { code: 0, lines };
  const slug = repoSlugFromUrl(opts.remoteUrl);
  const gh = slug ? await githubClient({ timeoutMs: 3000, retries: 0 }) : null;

  // ---- budget: cached numbers only, refreshed in the background so a push never waits on it ----
  if (slug && gh) {
    const owner = slug.split('/')[0]!;
    const state = readBudget(owner);
    // Estimates read every private repo's runs, so they refresh at most hourly to stay far from API rate limits.
    const maxAgeMin = state?.source === 'estimate' ? Math.max(60, config.ci.budget.refreshMinutes) : config.ci.budget.refreshMinutes;
    const stale = !state || Date.now() - state.at > maxAgeMin * 60_000;
    if (stale && gh.authenticated && !env.YM_CI_NO_BACKGROUND && claimRefresh(owner)) spawnSelf(['ci', 'budget', owner, '--quiet']);
    if (state) {
      const isPrivate = await repoIsPrivate(gh, slug);
      const v = verdict(state, config.ci.budget);
      // Only a repo known to be private is held; if GitHub can't say, warn instead of guessing.
      if (isPrivate === true && v.level === 'over' && config.ci.budget.blockPushes && !force) {
        say(v.message);
        say('This push was held so it does not start paid CI runs. If you are an agent, stop and ask the user. To push anyway: YM_CI_FORCE=1 git push. To allow paid usage: set ci.budget.extraUsd in yardmaster.json.');
        return { code: 1, lines };
      }
      if (isPrivate !== false && v.level !== 'ok') say(v.message);
    }
  }

  // ---- a push while CI is still running on the branch wastes that run ----
  if (slug && gh?.authenticated && config.ci.coalesce !== 'off') {
    for (const u of updates) {
      const branch = u.remoteRef.replace(/^refs\/heads\//, '');
      const r = await gh
        .get<{ workflow_runs: { head_sha: string; run_started_at?: string; created_at: string; status: string }[] }>(`/repos/${slug}/actions/runs`, { branch, per_page: 20 })
        .catch(() => null);
      const live = (r?.workflow_runs ?? []).filter((x) => (x.status === 'in_progress' || x.status === 'queued') && x.head_sha !== u.localSha);
      if (!live.length) continue;
      const age = Math.min(...live.map((x) => minutesAgo(x.run_started_at ?? x.created_at)));
      const msg = `CI is still running on ${branch} (${live.length} run${live.length > 1 ? 's' : ''}, newest started ${age} min ago). Pushing now restarts it, and the minutes already used are lost. Collect your fixes, check them locally, and push once.`;
      if (config.ci.coalesce === 'block' && !force) {
        say(msg);
        say('Held because ci.coalesce is "block". Push again when that run finishes, or YM_CI_FORCE=1 git push.');
        return { code: 1, lines };
      }
      say(msg);
    }
  }

  // ---- checks before CI: once per file tree ----
  const verified: string[] = [];
  if (config.ci.gate === 'verify') {
    const commands = gateCommands(config, root);
    const seen = new Set<string>();
    for (const u of updates) {
      const tree = await treeOf(here, u.localSha);
      if (!tree || seen.has(tree)) continue;
      seen.add(tree);
      if (!commands.length) continue;
      if (await isVerified(here, tree, commands)) {
        verified.push(u.localSha);
        continue;
      }
      say(`running checks before push (${commands.join(' && ')}); identical files are never checked twice`);
      const started = Date.now();
      const result = await checkCommit(root, here, u.localSha, commands, config);
      if (!result.ok) {
        say(`checks failed (\`${result.command}\`), so this push was stopped before it could start a failing CI run:`);
        lines.push(tail(result.output, 30, 3000));
        say('Fix the failure and push again. If a person decides CI must run anyway: YM_CI_SKIP=1 git push.');
        return { code: 1, lines };
      }
      await recordVerified(here, tree, commands);
      verified.push(u.localSha);
      say(`checks passed in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  }

  if (config.ci.trustLocal && slug && gh?.authenticated && !env.YM_CI_NO_BACKGROUND) {
    for (const sha of verified) spawnSelf(['ci', 'signoff', '--sha', sha, '--slug', slug, '--wait', '180']);
  }
  await logPush(here, updates).catch(() => undefined);
  return { code: 0, lines };
}

/** Check exactly the commit being pushed: here if that's what's checked out and clean, else in a throwaway worktree. */
export async function checkCommit(root: string, here: string, sha: string, commands: string[], config: Config) {
  if ((await revParse(here, 'HEAD')) === sha && (await isClean(here))) return runVerify(here, commands, config.verifyTimeoutMinutes);
  const dir = join(paths.tmp(), `ci-check-${sha.slice(0, 10)}-${process.pid}`);
  await git(root, ['worktree', 'add', '--detach', dir, sha]);
  try {
    await warmStart(root, dir, config).catch(() => undefined);
    return await runVerify(dir, commands, config.verifyTimeoutMinutes);
  } finally {
    await git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  }
}

async function logPush(cwd: string, updates: PushUpdate[]): Promise<void> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  if (r.code !== 0) return;
  const f = join(r.stdout.trim(), 'yardmaster-pushes');
  appendFileSync(f, updates.map((u) => `${Date.now()} ${u.remoteRef.replace(/^refs\/heads\//, '')} ${u.localSha}\n`).join(''));
}

export function recentPushes(commonDir: string, sinceMs: number): { at: number; branch: string; sha: string }[] {
  const f = join(commonDir, 'yardmaster-pushes');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
    .map(([at, branch, sha]) => ({ at: Number(at), branch: branch!, sha: sha! }))
    .filter((p) => p.at >= sinceMs);
}
