import { isClean, revParse } from './git.ts';
import { runShell, type OwnedRunOptions } from './proc.ts';
import { loadPlugins } from './plugins.ts';
import { planService, runService, type ServicePlan } from './providers.ts';
import type { ServicesConfig } from './provider-contract.ts';
import type { ServiceContext } from './service-receipts.ts';

export type ServiceRun = Awaited<ReturnType<typeof runService>>;
type VerificationLifecycle = {
  beforeSpawn?: () => void | Promise<void>; onExit?: (reaped: boolean) => void | Promise<void>;
  services?: ServicesConfig; context?: ServiceContext;
  onServicePlan?: (plan: ServicePlan) => void | Promise<void>;
  onServiceResult?: (result: ServiceRun) => void | Promise<void>;
};

export function hasVerification(commands: string[], services?: ServicesConfig): boolean {
  return commands.length > 0 || !!services?.verify.length;
}

/** Reuse the dashboard's existing activity and task-detail surfaces. No credentials or request input. */
export function serviceVerificationHooks(services: ServicesConfig, context: ServiceContext,
  emit: (level: 'info' | 'warn' | 'success', kind: string, message: string, data: unknown) => void | Promise<unknown>) {
  return { services, context,
    onServicePlan: async (plan: ServicePlan) => { await emit(plan.selected ? 'info' : 'warn', 'service.plan',
      `${plan.capability}: ${plan.selected ? `selected ${plan.selected}` : 'no eligible provider; check provider setup'}. Discovery does not verify account access or quota.`, plan); },
    onServiceResult: async (run: ServiceRun) => { await emit(run.result.status === 'passed' ? 'success' : 'warn', 'service.result',
      `${run.capability} via ${run.provider}: ${run.result.status}. ${run.result.summary} Receipt on the executing machine: ${run.receiptPath}`, run); },
  };
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  output: string;
  /** The immutable artifact these checks actually validated. */
  sha: string | null;
  reaped: boolean;
  /** Unknown results require inspection rather than another automatic agent attempt. */
  serviceStatus?: 'failed' | 'unknown';
}

/** Checks are acceptance, never an implicit formatter or commit hook. */
export async function verifyArtifact(cwd: string, commands: string[], timeoutMinutes: number, signal?: AbortSignal, onSpawn?: OwnedRunOptions['onSpawn'], lifecycle?: VerificationLifecycle): Promise<VerificationResult> {
  const sha = await revParse(cwd, 'HEAD');
  const fail = (command: string, output: string): VerificationResult => ({ ok: false, command, output, sha, reaped: true });
  if (!hasVerification(commands, lifecycle?.services)) return fail('', 'No verification commands are configured. Add verify commands before accepting this artifact.');
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
  if (lifecycle?.services?.verify.length) {
    const services = lifecycle.services;
    const plugins = await loadPlugins();
    for (const check of services.verify) {
      const command = `provider:${check.capability}`;
      if (signal?.aborted) return { ...fail(command, 'Provider verification canceled before dispatch.'), serviceStatus: 'unknown' };
      const plan = planService(check.capability, services, plugins.providers, cwd, process.env, check.input);
      await lifecycle.onServicePlan?.(plan);
      if (!plan.selected) return { ...fail(command, 'No eligible provider. Run ym providers plan for this capability; fix its configuration before retrying.'), serviceStatus: 'unknown' };
      await lifecycle.beforeSpawn?.();
      let run: ServiceRun;
      try {
        run = await runService(check.capability, check.input, services, plugins.providers, {
          cwd, signal, onSpawn, context: { ...lifecycle.context, sha },
        });
      } catch {
        // An exception may happen after dispatch or while saving evidence. Do not claim a clean process exit.
        await lifecycle.onExit?.(false);
        return { ...fail(command, 'Provider verification or evidence persistence failed. Inspect service receipts and owned processes before retrying.'), reaped: false, serviceStatus: 'unknown' };
      }
      await lifecycle.onExit?.(run.execution.reaped);
      await lifecycle.onServiceResult?.(run);
      if (!run.execution.reaped) return { ...fail(command, `Provider process cleanup is unconfirmed. Receipt: ${run.receiptPath}`), reaped: false, serviceStatus: 'unknown' };
      if ((await revParse(cwd, 'HEAD')) !== sha || !(await isClean(cwd))) return { ...fail(command, `Provider verification changed the committed artifact. Preserve the changes and rerun verification. Receipt: ${run.receiptPath}`), serviceStatus: 'unknown' };
      if (signal?.aborted || run.result.status !== 'passed') return { ...fail(command, `${run.result.summary}\nReceipt: ${run.receiptPath}`),
        serviceStatus: signal?.aborted || run.result.status === 'unknown' ? 'unknown' : 'failed' };
    }
  }
  return { ok: true, command: [...commands, ...(lifecycle?.services?.verify ?? []).map(check => `provider:${check.capability}`)].join(' && '), output: '', sha, reaped: true };
}
