import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { type Adapter, type AgentEvent, WRITE_TOOL, arr, commonFailure, num, obj, safeJson, str } from './types.ts';

const toolEvent = (name: string, input: unknown): AgentEvent => ({ type: 'tool', name, input, write: WRITE_TOOL.test(name) });

export const claude: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  setupHint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to sign in.',
  build(ctx) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.readOnly) args.push('--permission-mode', 'plan');
    else if (ctx.settings.autonomy === 'full') args.push('--permission-mode', 'bypassPermissions');
    // Edits are auto-accepted and shell is allowed so the agent can run tests; the user's own deny rules still apply.
    else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash');
    args.push(...ctx.settings.extraArgs);
    return { command: ctx.settings.command ?? 'claude', args, stdin: ctx.prompt };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    const out: AgentEvent[] = [];
    const msg = obj(j.message);
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
  setupHint: 'Install Codex CLI (npm i -g @openai/codex) and run `codex login`.',
  build(ctx) {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', ctx.cwd];
    if (ctx.model) args.push('-m', ctx.model);
    if (ctx.readOnly) args.push('-s', 'read-only');
    else if (ctx.settings.autonomy === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', 'workspace-write');
    args.push(...ctx.settings.extraArgs, '-');
    return { command: ctx.settings.command ?? 'codex', args, stdin: ctx.prompt };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return [];
    const item = obj(j.item);
    switch (j.type) {
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

function mockAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../../bin/mock-agent.mjs'), join(here, '../bin/mock-agent.mjs')]) if (existsSync(p)) return p;
  throw new Error('mock-agent.mjs not found');
}

/** Deterministic fake agent driven by `@mock` directives in the prompt. Powers tests and `--dry-run` demos. */
export const mock: Adapter = {
  name: 'mock',
  label: 'Mock agent (tests and demos)',
  binary: process.execPath,
  build(ctx) {
    return { command: process.execPath, args: [mockAgentPath()], stdin: ctx.prompt };
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
