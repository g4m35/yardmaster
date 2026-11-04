import { run, which } from '../proc.ts';
import { createGitHub, type GitHub } from './github.ts';

let cached: string | null | undefined;

/**
 * A GitHub token from wherever the user already has one: YM_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or the GitHub CLI's
 * login. The value is never printed or logged.
 */
export async function findToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const env = process.env.YM_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return (cached = env.trim());
  if (process.env.YM_GITHUB_API || !which('gh')) return (cached = null);
  const r = await run('gh', ['auth', 'token'], { timeoutMs: 5000 }).catch(() => null);
  cached = r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  return cached;
}

export async function githubClient(opts: { timeoutMs?: number; retries?: number } = {}): Promise<GitHub> {
  return createGitHub(await findToken(), opts);
}

export const NO_TOKEN_HELP = 'No GitHub login found. Run "gh auth login", or set GH_TOKEN to a token that can read the repo\'s Actions.';
