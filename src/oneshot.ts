import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getAdapter } from './adapters/index.ts';
import { agentSettings, priceFor, type Config, type Tier } from './config.ts';
import { UsageMeter } from './usage.ts';
import { cleanEnv, killGroup } from './proc.ts';

export interface OneShotResult {
  ok: boolean;
  text: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  error: string;
}

/** Runs an agent once for a bounded job (planning, reviewing) and returns its final answer and spend. */
export async function runOneShot(opts: {
  agent: string;
  config: Config;
  prompt: string;
  cwd: string;
  model?: string | null;
  readOnly?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  tier?: Tier;
  maxTurns?: number;
  budgetUsd?: number;
}): Promise<OneShotResult> {
  const adapter = getAdapter(opts.agent, opts.config);
  if (!adapter) return { ok: false, text: '', costUsd: 0, tokensIn: 0, tokensOut: 0, error: `unknown agent ${opts.agent}` };
  const settings = agentSettings(opts.config, opts.agent);
  const spec = adapter.build({ prompt: opts.prompt, cwd: opts.cwd, model: opts.model ?? null, settings, readOnly: opts.readOnly, tier: opts.tier, maxTurns: opts.maxTurns, budgetUsd: opts.budgetUsd });
  const meter = new UsageMeter(priceFor(opts.config, opts.agent, opts.model ?? null));
  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    env: cleanEnv({ ...spec.env, ...opts.env }),
    stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  let result = '';
  let lastText = '';
  let ok: boolean | null = null;
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    for (const ev of adapter.parse(line)) {
      if (ev.type === 'result') {
        result = ev.text;
        ok = ev.ok;
      } else if (ev.type === 'text') lastText = ev.text;
      else if (ev.type === 'usage') meter.add(ev);
    }
  });
  const timer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), opts.timeoutMs ?? 10 * 60_000);
  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(127));
  });
  clearTimeout(timer);
  killGroup(child.pid, 'SIGTERM');
  return { ok: code === 0 && ok !== false, text: result || lastText, costUsd: meter.spent, tokensIn: meter.tokensIn, tokensOut: meter.tokensOut, error: code === 0 ? '' : stderr.trim().slice(-600) };
}
