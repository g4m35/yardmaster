import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from './proc.ts';
import { inSea, readAsset } from './assets.ts';

/** How agents should launch us: absolute paths, so it works regardless of the agent's PATH. */
export function selfCommand(): string[] {
  if (inSea) return [process.execPath];
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

function hookCommand(event: string): string {
  return [...selfCommand(), 'hook', event].map((p) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)).join(' ');
}

/**
 * Hooks give zero-token coordination: a short briefing at session start, board changes before a prompt (only when
 * something changed), automatic reservation of files the agent edits, and a guard on edits to files another agent
 * holds. Claude Code and Codex read the same JSON shape (Codex from ~/.codex/hooks.json, approved once in /hooks).
 */
export function hookPlan(agent: 'claude' | 'codex'): { file: string; hooks: Record<string, unknown[]> } {
  const edit = agent === 'claude' ? 'Edit|Write|MultiEdit|NotebookEdit' : 'Edit|Write';
  const h = (event: string, timeout: number) => ({ type: 'command', command: hookCommand(event), timeout });
  return {
    file: agent === 'claude' ? join(homedir(), '.claude', 'settings.json') : join(homedir(), '.codex', 'hooks.json'),
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [h('session-start', 10)] }],
      UserPromptSubmit: [{ hooks: [h('prompt', 5)] }],
      PreToolUse: [{ matcher: edit, hooks: [h('pre-edit', 10)] }],
      PostToolUse: [{ matcher: edit, hooks: [h('post-edit', 10)] }],
    },
  };
}

export function installHooks(agent: 'claude' | 'codex'): string {
  const { file, hooks } = hookPlan(agent);
  backupAndWriteJson(file, (cfg) => {
    const existing = (cfg.hooks ?? {}) as Record<string, unknown[]>;
    for (const [event, groups] of Object.entries(hooks)) {
      // Re-running connect replaces our entries and leaves everyone else's alone.
      const mine = /yardmaster|cli\.(js|ts)"? hook /;
      existing[event] = [...(existing[event] ?? []).filter((g) => !mine.test(JSON.stringify(g)) || !JSON.stringify(g).includes(' hook ')), ...groups];
    }
    cfg.hooks = existing;
  });
  return file;
}

/** Install the Yardmaster skill where each agent discovers skills. */
export function installSkill(): string[] {
  const text = readAsset('SKILL.md', inSea ? [] : [fileURLToPath(new URL('../skills/yardmaster/SKILL.md', import.meta.url))]);
  const targets = [join(homedir(), '.claude', 'skills', 'yardmaster'), join(homedir(), '.agents', 'skills', 'yardmaster')];
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), text);
  }
  return targets;
}

/** Kept for `ym connect --with-hook` from 0.1. */
export function installClaudeHook(): string {
  return installHooks('claude');
}
