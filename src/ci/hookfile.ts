import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { selfCommand } from '../connect.ts';
import { git } from '../git.ts';

/**
 * The pre-push hook lives in the repo's shared hooks folder, so it covers every worktree and every agent.
 * An existing pre-push hook is kept and run first ("chained"); uninstalling puts it back.
 */

export const MARKER = '# yardmaster-ci-gate';
const CHAINED = 'pre-push.yardmaster-chained';

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function hooksDir(cwd: string): Promise<{ dir: string; custom: string | null }> {
  const custom = (await git(cwd, ['config', '--get', 'core.hooksPath'], { allowFail: true })).stdout.trim() || null;
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const dir = r.stdout.trim();
  return { dir: isAbsolute(dir) ? dir : join(top, dir), custom };
}

export function hookScript(dir: string): string {
  const self = selfCommand();
  const exists = self.map((p) => `[ -e ${q(p)} ]`).join(' && ');
  return `#!/bin/sh
${MARKER} (installed by "ym ci init"; remove with "ym ci uninstall")
input=$(cat)
if [ -x ${q(join(dir, CHAINED))} ]; then
  printf '%s\\n' "$input" | ${q(join(dir, CHAINED))} "$@" || exit $?
fi
[ -n "\${YM_CI_SKIP:-}" ] && exit 0
if ${exists}; then
  printf '%s\\n' "$input" | ${self.map(q).join(' ')} ci gate "$@"
  exit $?
fi
if command -v ym >/dev/null 2>&1; then
  echo "Yardmaster CI gate: the ym this hook was installed with is gone; using $(command -v ym) (run ym ci init to pin it again)." >&2
  printf '%s\\n' "$input" | ym ci gate "$@"
  exit $?
fi
echo "Yardmaster CI gate: ym is not installed any more; skipping (remove .git/hooks/pre-push to silence this)." >&2
exit 0
`;
}

export interface InstallResult {
  file: string;
  chained: boolean;
  alreadyInstalled: boolean;
}

export async function installGateHook(cwd: string, opts: { allowCustomHooksPath?: boolean } = {}): Promise<InstallResult> {
  const { dir, custom } = await hooksDir(cwd);
  if (custom && !opts.allowCustomHooksPath) {
    throw new Error(`This repo uses core.hooksPath (${custom}), probably a hook manager like husky that's shared with your team. Add this line to its pre-push hook instead:\n  ym ci gate "$@"\nor run "ym ci init --hooks-path" to install into ${dir} anyway.`);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pre-push');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const alreadyInstalled = !!current?.includes(MARKER);
  let chained = existsSync(join(dir, CHAINED));
  if (current && !alreadyInstalled) {
    if (chained) throw new Error(`${join(dir, CHAINED)} already exists; refusing to overwrite it. Move it away and try again.`);
    renameSync(file, join(dir, CHAINED));
    chained = true;
  }
  writeFileSync(file, hookScript(dir));
  chmodSync(file, 0o755);
  return { file, chained, alreadyInstalled };
}

export async function uninstallGateHook(cwd: string): Promise<{ removed: boolean; restored: boolean }> {
  const { dir } = await hooksDir(cwd);
  const file = join(dir, 'pre-push');
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(MARKER)) return { removed: false, restored: false };
  rmSync(file);
  const chained = join(dir, CHAINED);
  if (existsSync(chained)) {
    renameSync(chained, file);
    return { removed: true, restored: true };
  }
  return { removed: true, restored: false };
}

export async function gateHookInstalled(cwd: string): Promise<boolean> {
  const { dir } = await hooksDir(cwd);
  const file = join(dir, 'pre-push');
  return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
}
