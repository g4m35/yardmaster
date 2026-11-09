import { isClean, revParse } from './git.ts';
import { runShell, type OwnedRunOptions } from './proc.ts';

export interface VerificationResult {
  ok: boolean;
  command: string;
  output: string;
  /** The immutable artifact these checks actually validated. */
  sha: string | null;
  reaped: boolean;
}

/** Checks are acceptance, never an implicit formatter or commit hook. */
export async function verifyArtifact(cwd: string, commands: string[], timeoutMinutes: number, signal?: AbortSignal, onSpawn?: OwnedRunOptions['onSpawn'], lifecycle?: { beforeSpawn?: () => void | Promise<void>; onExit?: (reaped: boolean) => void | Promise<void> }): Promise<VerificationResult> {
  const sha = await revParse(cwd, 'HEAD');
  const fail = (command: string, output: string): VerificationResult => ({ ok: false, command, output, sha, reaped: true });
  if (!commands.length) return fail('', 'No verification commands are configured. Add verify commands before accepting this artifact.');
  if (!sha || !(await isClean(cwd))) return fail(commands[0] ?? '', 'Verification requires a committed, clean worktree. Commit the intended artifact before checking it.');
  for (const command of commands) {
    if (signal?.aborted) return fail(command, 'Verification canceled before starting the next command.');
    await lifecycle?.beforeSpawn?.();
    const r = await runShell(command, { cwd, timeoutMs: timeoutMinutes * 60_000, signal, onSpawn });
    await lifecycle?.onExit?.(r.reaped);
    if (!r.reaped) return { ...fail(command, 'A verification process survived cleanup. Keep this worktree held for recovery; do not retry into it.'), reaped: false };
    // Check even on command failure: retain the mutated files for the agent/person to inspect.
    const unchanged = (await revParse(cwd, 'HEAD')) === sha && await isClean(cwd);
    if (!unchanged) return fail(command, `${r.stdout}\nVerification changed HEAD or left working/staged files. Its result does not validate commit ${sha}. Keep the changes, commit the intended fix, and rerun checks.`);
    if (signal?.aborted) return fail(command, `${r.stdout}\nVerification canceled.`);
    if (r.code !== 0) return fail(command, r.timedOut ? `${r.stdout}\n(timed out after ${timeoutMinutes} minutes)` : r.stdout);
  }
  return { ok: true, command: commands.join(' && '), output: '', sha, reaped: true };
}
