import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { inSea } from '../assets.ts';
import type { Tier } from '../config.ts';
import { type Adapter, type AdapterContext, type AgentEvent, WRITE_TOOL, arr, commonFailure, num, obj, safeJson, str } from './types.ts';

const toolEvent = (name: string, input: unknown): AgentEvent => ({ type: 'tool', name, input, write: WRITE_TOOL.test(name) });

/** Reasoning effort by tier when the user hasn't set one: cheap work thinks less, hard work more. */
export const DEFAULT_EFFORT: Record<Tier, string> = { cheap: 'low', standard: 'medium', strong: 'high' };

function effortFor(ctx: AdapterContext): string | null {
  if (!ctx.tier) return null;
  const e = ctx.settings.effort[ctx.tier] ?? DEFAULT_EFFORT[ctx.tier];
  return e ? e : null;
}

/**
 * The built-in tools a background coding run needs. Leaving out the rest (scheduling, remote triggers, artifacts,
 * subagents and their catalog) is most of the lean saving: measured on Claude Code 2.1, about 61k tokens of starting
 * context per turn becomes about 14k.
 */
export const CLAUDE_CODING_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'LSP', 'WebFetch', 'WebSearch'];
const CLAUDE_READ_TOOLS = ['Bash', 'Read', 'LSP'];

export const claude: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  resumable: true,
  setupHint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to sign in.',
  build(ctx) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const env: Record<string, string> = {};
    if (ctx.session && 'resume' in ctx.session) args.push('--resume', ctx.session.resume);
    else if (ctx.session) args.push('--session-id', ctx.session.pin);
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.readOnly) args.push('--permission-mode', 'plan');
    else if (ctx.settings.autonomy === 'full') args.push('--permission-mode', 'bypassPermissions');
    // Edits are auto-accepted and shell is allowed so the agent can run tests; the user's own deny rules still apply.
    else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash');
    if (ctx.settings.context === 'lean') {
      // CLAUDE.md, hooks and permission rules still load; MCP servers, skills and optional tools don't.
      args.push('--strict-mcp-config');
      if (ctx.settings.mcpConfig) args.push('--mcp-config', ctx.settings.mcpConfig);
      args.push('--disable-slash-commands', '--exclude-dynamic-system-prompt-sections');
      args.push('--tools', (ctx.settings.tools ?? (ctx.readOnly ? CLAUDE_READ_TOOLS : CLAUDE_CODING_TOOLS)).join(','));
      // Skips telemetry and feature-flag fetches (which also drops the Artifact and DesignSync tools) and update checks.
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      env.DISABLE_AUTOUPDATER = '1';
    }
    const effort = effortFor(ctx);
    if (effort) args.push('--effort', effort);
    if (ctx.budgetUsd !== undefined && ctx.budgetUsd !== null && ctx.budgetUsd > 0) args.push('--max-budget-usd', Math.max(0.05, ctx.budgetUsd).toFixed(2));
    if (ctx.maxTurns) args.push('--max-turns', String(ctx.maxTurns));
    args.push(...ctx.settings.extraArgs);
    return { command: ctx.settings.command ?? 'claude', args, stdin: ctx.prompt, env };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    const out: AgentEvent[] = [];
    const msg = obj(j.message);
    if (j.type === 'system' && j.subtype === 'init' && typeof j.session_id === 'string') return [{ type: 'session', id: j.session_id }];
    if (j.type === 'assistant') {
      for (const c of arr(msg.content).map(obj)) {
        if (c.type === 'tool_use') out.push(toolEvent(str(c.name), c.input));
        else if (c.type === 'text' && str(c.text)) out.push({ type: 'text', text: str(c.text) });
      }
      const u = obj(msg.usage);
      if (Object.keys(u).length) {
        out.push({
          type: 'usage',
          tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens),
          cachedIn: num(u.cache_read_input_tokens),
          tokensOut: num(u.output_tokens),
          cumulative: false,
          id: str(msg.id) || undefined,
        });
      }
    } else if (j.type === 'user') {
      for (const c of arr(msg.content).map(obj)) {
        if (c.type === 'tool_result') out.push({ type: 'tool_result', ok: c.is_error !== true, text: str(c.content).slice(0, 2000) });
      }
    } else if (j.type === 'result') {
      const u = obj(j.usage);
      out.push({
        type: 'usage',
        tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens),
        cachedIn: num(u.cache_read_input_tokens),
        tokensOut: num(u.output_tokens),
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        cumulative: true,
      });
      out.push({ type: 'result', ok: j.is_error !== true && j.subtype === 'success', text: str(j.result) });
    }
    return out;
  },
  classifyFailure: commonFailure,
};

export const codex: Adapter = {
  name: 'codex',
  label: 'Codex CLI',
  binary: 'codex',
  resumable: true,
  setupHint: 'Install Codex CLI (npm i -g @openai/codex) and run `codex login`.',
  build(ctx) {
    const resume = ctx.session && 'resume' in ctx.session ? ctx.session.resume : null;
    // `exec resume` has no -C or -s: it runs in the worktree (spawn cwd) and takes the sandbox as config.
    const args = resume ? ['exec', 'resume', '--json', '--skip-git-repo-check'] : ['exec', '--json', '--skip-git-repo-check', '-C', ctx.cwd];
    if (ctx.model) args.push('-m', ctx.model);
    const sandbox = ctx.readOnly ? 'read-only' : ctx.settings.autonomy === 'full' ? null : 'workspace-write';
    if (!sandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (resume) args.push('-c', `sandbox_mode="${sandbox}"`);
    else args.push('-s', sandbox);
    if (ctx.settings.context === 'lean') args.push('-c', 'check_for_update_on_startup=false');
    const effort = effortFor(ctx);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(...ctx.settings.extraArgs);
    if (resume) args.push(resume);
    args.push('-');
    return { command: ctx.settings.command ?? 'codex', args, stdin: ctx.prompt };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    const item = obj(j.item);
    switch (j.type) {
      case 'thread.started':
        return typeof j.thread_id === 'string' ? [{ type: 'session', id: j.thread_id }] : [];
      case 'item.started':
        if (item.type === 'command_execution') return [toolEvent('shell', item.command)];
        if (item.type === 'mcp_tool_call') return [toolEvent(`mcp:${str(item.tool)}`, item.arguments)];
        return [];
      case 'item.completed':
        if (item.type === 'command_execution') return [{ type: 'tool_result', ok: item.exit_code === 0, text: str(item.aggregated_output).slice(-2000) }];
        if (item.type === 'file_change') return [toolEvent('apply_patch', item.changes)];
        if (item.type === 'agent_message') return [{ type: 'text', text: str(item.text) }];
        if (item.type === 'error') return [{ type: 'error', text: str(item.message) }];
        return [];
      case 'turn.completed': {
        const u = obj(j.usage);
        const cached = num(u.cached_input_tokens);
        return [{ type: 'usage', tokensIn: Math.max(0, num(u.input_tokens) - cached), cachedIn: cached, tokensOut: num(u.output_tokens) + num(u.reasoning_output_tokens), cumulative: false }];
      }
      case 'turn.failed':
        return [{ type: 'error', text: str(obj(j.error).message) || 'turn failed' }];
      case 'error':
        return [{ type: 'error', text: str(j.message) }];
      default:
        return [];
    }
  },
  classifyFailure: commonFailure,
};

export const opencode: Adapter = {
  name: 'opencode',
  label: 'OpenCode',
  binary: 'opencode',
  setupHint: 'Install OpenCode (https://opencode.ai) and run `opencode auth login`.',
  build(ctx) {
    const args = ['run', '--format', 'json'];
    if (ctx.model) args.push('--model', ctx.model);
    if (!ctx.readOnly) args.push('--auto');
    args.push(...ctx.settings.extraArgs, ctx.prompt);
    return { command: ctx.settings.command ?? 'opencode', args };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    const part = obj(j.part);
    if (j.type === 'text' && str(part.text)) return [{ type: 'text', text: str(part.text) }];
    if (j.type === 'tool_use') {
      const state = obj(part.state);
      const ev: AgentEvent[] = [toolEvent(str(part.tool), state.input)];
      if (state.status === 'error') ev.push({ type: 'tool_result', ok: false, text: str(state.error).slice(0, 2000) });
      else if (state.status === 'completed') ev.push({ type: 'tool_result', ok: true, text: str(state.output).slice(0, 2000) });
      return ev;
    }
    if (j.type === 'step_finish') {
      const t = obj(part.tokens);
      const cache = obj(t.cache);
      return [{ type: 'usage', tokensIn: num(t.input) + num(cache.write), cachedIn: num(cache.read), tokensOut: num(t.output) + num(t.reasoning), costUsd: num(part.cost), cumulative: false }];
    }
    if (j.type === 'error') return [{ type: 'error', text: str(obj(j.error).message) || str(j.error) }];
    return [];
  },
  classifyFailure: commonFailure,
};

export const cursor: Adapter = {
  name: 'cursor',
  label: 'Cursor Agent',
  binary: 'cursor-agent',
  setupHint: 'Install Cursor CLI (curl https://cursor.com/install -fsS | bash) and run `cursor-agent login`.',
  build(ctx) {
    const args = ['-p', '--output-format', 'stream-json', '--trust'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.readOnly) args.push('--plan');
    else args.push('--force');
    args.push(...ctx.settings.extraArgs, ctx.prompt);
    return { command: ctx.settings.command ?? 'cursor-agent', args };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    if (j.type === 'assistant') {
      return arr(obj(j.message).content)
        .map(obj)
        .filter((c) => c.type === 'text' && str(c.text))
        .map((c) => ({ type: 'text' as const, text: str(c.text) }));
    }
    if (j.type === 'tool_call' && j.subtype === 'started') {
      const call = obj(j.tool_call);
      const name = Object.keys(call)[0] ?? 'tool';
      return [toolEvent(name.replace(/ToolCall$/, ''), obj(call[name]).args)];
    }
    if (j.type === 'tool_call' && j.subtype === 'completed') {
      const call = obj(j.tool_call);
      const result = obj(obj(call[Object.keys(call)[0] ?? '']).result);
      return [{ type: 'tool_result', ok: !('error' in result) && !('failure' in result), text: str(result).slice(0, 2000) }];
    }
    if (j.type === 'result') return [{ type: 'result', ok: j.is_error !== true, text: str(j.result) }];
    return [];
  },
  classifyFailure: commonFailure,
};

export const gemini: Adapter = {
  name: 'gemini',
  label: 'Gemini CLI',
  binary: 'gemini',
  setupHint: 'Install Gemini CLI (npm i -g @google/gemini-cli) and run `gemini` once to sign in.',
  build(ctx) {
    const args = ['--output-format', 'stream-json'];
    if (ctx.model) args.push('-m', ctx.model);
    args.push('--approval-mode', ctx.readOnly ? 'plan' : ctx.settings.autonomy === 'full' ? 'yolo' : 'auto_edit');
    args.push(...ctx.settings.extraArgs, '-p', ctx.prompt);
    return { command: ctx.settings.command ?? 'gemini', args };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    if (j.type === 'message' && j.role === 'assistant' && str(j.content)) return [{ type: 'text', text: str(j.content) }];
    if (j.type === 'tool_use') return [toolEvent(str(j.tool_name), j.parameters)];
    if (j.type === 'tool_result') return [{ type: 'tool_result', ok: j.status === 'success', text: str(j.output).slice(0, 2000) }];
    if (j.type === 'result') {
      const s = obj(j.stats);
      return [
        { type: 'usage', tokensIn: num(s.input_tokens), tokensOut: num(s.output_tokens), cumulative: true },
        { type: 'result', ok: j.status === 'success', text: '' },
      ];
    }
    if (j.type === 'error') return [{ type: 'error', text: str(j.message) }];
    return [];
  },
  classifyFailure: commonFailure,
};

/** The mock agent is part of Yardmaster itself: a tiny entry file from npm, a hidden subcommand in the binary. */
function mockAgentArgs(): string[] {
  if (inSea) return ['__mock-agent'];
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entry = join(here, '..', `mockagent-main${ext}`);
  if (!existsSync(entry)) throw new Error('mock agent entry not found in this install');
  return [entry];
}

/** Deterministic fake agent driven by `@mock` directives in the prompt. Powers tests and `--dry-run` demos. */
export const mock: Adapter = {
  name: 'mock',
  label: 'Mock agent (tests and demos)',
  binary: process.execPath,
  // Off by default so `@mock` directives keep driving every attempt; tests switch resuming on to exercise it.
  get resumable() {
    return process.env.YARDMASTER_MOCK_RESUMABLE === '1';
  },
  build(ctx) {
    const env: Record<string, string> = { YM_MOCK_ARGS: JSON.stringify({ tier: ctx.tier ?? null, budget: ctx.budgetUsd ?? null, context: ctx.settings.context }) };
    if (ctx.session && 'resume' in ctx.session) env.YM_MOCK_RESUME = ctx.session.resume;
    else if (ctx.session) env.YM_MOCK_SESSION = ctx.session.pin;
    return { command: process.execPath, args: mockAgentArgs(), stdin: ctx.prompt, env };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j || typeof j.type !== 'string') return [];
    return [j as unknown as AgentEvent];
  },
  classifyFailure: commonFailure,
};

/** Wraps any CLI that prints plain text. `{prompt}` in the command is replaced, otherwise the prompt goes to stdin. */
export function commandAdapter(name: string, command: string): Adapter {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? [];
  const [bin = name, ...rest] = parts;
  return {
    name,
    label: name,
    binary: bin,
    build(ctx) {
      const usesArg = rest.includes('{prompt}');
      const args = rest.map((a) => (a === '{prompt}' ? ctx.prompt : a)).concat(ctx.settings.extraArgs);
      return { command: bin, args, stdin: usesArg ? undefined : ctx.prompt };
    },
    parse(line) {
      return line.trim() ? [{ type: 'text', text: line }] : [];
    },
    classifyFailure: commonFailure,
  };
}

export const BUILTIN_ADAPTERS: Adapter[] = [claude, codex, opencode, cursor, gemini, mock];
