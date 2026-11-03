import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from './proc.ts';

/** How agents should launch us: absolute paths, so it works regardless of the agent's PATH. */
export function selfCommand(): string[] {
  const cli = fileURLToPath(new URL('./cli' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url));
  return [process.execPath, cli];
}

export interface ConnectStep {
  agent: string;
  action: string;
  file?: string;
  command?: string[];
  skipped?: string;
}

function backupAndWriteJson(file: string, update: (cfg: Record<string, unknown>) => void): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    try {
      cfg = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`${file} is not plain JSON (comments?). Add the yardmaster MCP server by hand; see "ym connect --dry-run".`);
    }
    copyFileSync(file, `${file}.yardmaster-backup`);
  }
  update(cfg);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

function mcpServersJson(file: string, agent: string, cmd: string[]): ConnectStep {
  return {
    agent,
    action: `add "yardmaster" to mcpServers in ${file}`,
    file,
    command: cmd,
  };
}

export function connectPlan(agents: string[]): ConnectStep[] {
  const cmd = [...selfCommand(), 'mcp'];
  const steps: ConnectStep[] = [];
  for (const agent of agents) {
    switch (agent) {
      case 'claude':
        steps.push(which('claude') ? { agent, action: 'register MCP server (user scope)', command: ['claude', 'mcp', 'add', 'yardmaster', '-s', 'user', '--', ...cmd] } : { agent, action: '', skipped: 'Claude Code not installed' });
        break;
      case 'codex':
        steps.push(which('codex') ? { agent, action: 'register MCP server', command: ['codex', 'mcp', 'add', 'yardmaster', '--', ...cmd] } : { agent, action: '', skipped: 'Codex CLI not installed' });
        break;
      case 'cursor':
        steps.push(mcpServersJson(join(homedir(), '.cursor', 'mcp.json'), agent, cmd));
        break;
      case 'gemini':
        steps.push(mcpServersJson(join(homedir(), '.gemini', 'settings.json'), agent, cmd));
        break;
      case 'opencode':
        steps.push({ agent, action: `add "yardmaster" to mcp in ~/.config/opencode/opencode.json`, file: join(homedir(), '.config', 'opencode', 'opencode.json'), command: cmd });
        break;
      default:
        steps.push({ agent, action: '', skipped: `don't know how to connect "${agent}"` });
    }
  }
  return steps;
}

export async function applyConnect(steps: ConnectStep[]): Promise<{ step: ConnectStep; ok: boolean; detail: string }[]> {
  const out: { step: ConnectStep; ok: boolean; detail: string }[] = [];
  for (const step of steps) {
    if (step.skipped) {
      out.push({ step, ok: false, detail: step.skipped });
      continue;
    }
    try {
      if ((step.agent === 'claude' || step.agent === 'codex') && step.command) {
        // Re-running connect should be harmless: remove a previous registration first.
        await run(step.command[0]!, step.agent === 'claude' ? ['mcp', 'remove', 'yardmaster', '-s', 'user'] : ['mcp', 'remove', 'yardmaster'], { timeoutMs: 30_000 }).catch(() => undefined);
        const r = await run(step.command[0]!, step.command.slice(1), { timeoutMs: 30_000 });
        out.push({ step, ok: r.code === 0, detail: (r.stdout || r.stderr).trim().split('\n').pop() ?? '' });
      } else if (step.agent === 'opencode' && step.file && step.command) {
        backupAndWriteJson(step.file, (cfg) => {
          const mcp = (cfg.mcp ?? {}) as Record<string, unknown>;
          mcp.yardmaster = { type: 'local', command: step.command, enabled: true };
          cfg.mcp = mcp;
          cfg.$schema ??= 'https://opencode.ai/config.json';
        });
        out.push({ step, ok: true, detail: `updated ${step.file}` });
      } else if (step.file && step.command) {
        backupAndWriteJson(step.file, (cfg) => {
          const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
          servers.yardmaster = { command: step.command![0], args: step.command!.slice(1) };
          cfg.mcpServers = servers;
        });
        out.push({ step, ok: true, detail: `updated ${step.file}` });
      }
    } catch (err) {
      out.push({ step, ok: false, detail: (err as Error).message });
    }
  }
  return out;
}

/** Optional hard enforcement for Claude Code: a PreToolUse hook that blocks edits to files another agent holds. */
export function claudeHookPlan(): { file: string; hook: Record<string, unknown> } {
  return {
    file: join(homedir(), '.claude', 'settings.json'),
    hook: { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: [...selfCommand(), 'hook', 'claude-pretool'].map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' '), timeout: 10 }] },
  };
}

export function installClaudeHook(): string {
  const { file, hook } = claudeHookPlan();
  backupAndWriteJson(file, (cfg) => {
    const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;
    const pre = (hooks.PreToolUse ?? []).filter((h) => !JSON.stringify(h).includes('claude-pretool'));
    pre.push(hook);
    hooks.PreToolUse = pre;
    cfg.hooks = hooks;
  });
  return file;
}
