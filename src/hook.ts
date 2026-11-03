import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Client } from './api.ts';
import { mainRepoRoot, projectIdFor, repoRoot } from './git.ts';
import { paths, machineId } from './paths.ts';
import { clip, sha1 } from './text.ts';

/**
 * Hooks are the cheapest way to coordinate an interactive agent: they run outside the model, so they cost no
 * tool calls and add context only when there is something new. One set of handlers serves Claude Code and Codex
 * (same JSON shapes). Every handler fails open: if the hub is down or anything goes wrong, the agent carries on.
 */

export interface HookInput {
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string; path?: string };
}

export interface HookResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

type ClientFactory = () => Promise<Client | null>;

export function parseHookInput(stdin: string): HookInput | null {
  try {
    return JSON.parse(stdin) as HookInput;
  } catch {
    return null;
  }
}

/** Files a tool call is about to write: Claude-style file_path, or the paths in a Codex apply_patch. */
export function editedPaths(input: HookInput): string[] {
  const ti = input.tool_input ?? {};
  const out = new Set<string>();
  for (const p of [ti.file_path, ti.notebook_path, ti.path]) if (typeof p === 'string' && p) out.add(p);
  if (typeof ti.command === 'string' && /\*\*\* (Begin Patch|Update File|Add File)/.test(ti.command)) {
    for (const m of ti.command.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) out.add(m[1]!.trim());
  }
  return [...out];
}

async function context(input: HookInput, client: ClientFactory) {
  if (process.env.YARDMASTER_TASK_ID) return null; // background agents are briefed and isolated already
  const cwd = input.cwd ?? process.cwd();
  const checkout = await repoRoot(cwd);
  const root = await mainRepoRoot(cwd);
  if (!checkout || !root) return null;
  const c = await client();
  if (!c) return null;
  const projectId = await projectIdFor(root);
  try {
    await c['project.resolve']({ projectId });
  } catch {
    return null; // repo not managed by Yardmaster: stay invisible
  }
  const sessionName = `hook-${sha1(input.session_id ?? String(process.ppid)).slice(0, 8)}`;
  return { c, cwd, checkout, root, projectId, sessionName, sessionId: `session:${sessionName}` };
}

function contextOutput(event: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** Block an edit only when another agent genuinely holds the file. */
export async function preEdit(input: HookInput, client: ClientFactory): Promise<HookResult> {
  const files = editedPaths(input);
  if (!files.length) return { code: 0 };
  const ctx = await context(input, client);
  if (!ctx) return { code: 0 };
  // Separate worktrees don't share files; any overlap surfaces at merge time instead.
  if (ctx.checkout !== ctx.root) return { code: 0 };
  const rel = files.map((f) => relative(ctx.root, isAbsolute(f) ? f : join(ctx.cwd, f)));
  const holders = await ctx.c['lock.check']({ projectId: ctx.projectId, paths: rel });
  const board = await ctx.c['board.status']({ projectId: ctx.projectId });
  // The hook can't see an MCP server's identity, so "mine" means any session registered from this same folder.
  const mine = new Set(board.sessions.filter((s) => s.cwd === ctx.cwd).map((s) => s.id));
  mine.add(ctx.sessionId);
  const other = holders.find((h) => !mine.has(h.holder));
  if (!other) return { code: 0 };
  return { code: 2, stderr: `Yardmaster: ${other.path} is being changed by ${other.holder} (${other.detail}). Work on something else for now, or ask the user. The yard_who and yard_send tools help coordinate.` };
}

/** Reserve what this session just edited, so background agents leave it alone. No tool call, no tokens. */
export async function postEdit(input: HookInput, client: ClientFactory): Promise<HookResult> {
  const files = editedPaths(input);
  if (!files.length) return { code: 0 };
  const ctx = await context(input, client);
  if (!ctx || ctx.checkout !== ctx.root) return { code: 0 };
  const rel = files.map((f) => relative(ctx.root, isAbsolute(f) ? f : join(ctx.cwd, f))).filter((f) => !f.startsWith('..'));
  if (!rel.length) return { code: 0 };
  await ctx.c['session.register']({ name: ctx.sessionName, agent: 'hooked-agent', projectId: ctx.projectId, cwd: ctx.cwd, machineId: machineId() });
  const r = await ctx.c['lock.claim']({ projectId: ctx.projectId, holder: ctx.sessionId, patterns: rel, reason: 'edited in an interactive session', ttlMinutes: 20 });
  if (!r.ok && r.conflicts.length) {
    const c = r.conflicts[0]!;
    return { code: 0, stdout: contextOutput('PostToolUse', `Heads up from Yardmaster: ${c.pattern} is also being changed by ${c.holder}${c.reason ? ` (${c.reason})` : ''}. Coordinate before editing it further.`) };
  }
  return { code: 0 };
}

const INTRO = 'Yardmaster coordinates the coding agents on this repo. Files you edit are reserved for you automatically. To run work in parallel, use yard_add_tasks (give each task the files it will change) and yard_wait. yard_status shows what everyone is doing.';

/** Session start: a short briefing (board + the repo's most useful lessons). Re-sent after compaction. */
export async function sessionStart(input: HookInput, client: ClientFactory): Promise<HookResult> {
  const ctx = await context(input, client);
  if (!ctx) return { code: 0 };
  await ctx.c['session.register']({ name: ctx.sessionName, agent: 'hooked-agent', projectId: ctx.projectId, cwd: ctx.cwd, machineId: machineId() }).catch(() => undefined);
  const board = await ctx.c['board.text']({ projectId: ctx.projectId });
  const lessons = (await ctx.c['lesson.list']({ projectId: ctx.projectId })).filter((l) => l.source === 'you' || l.source === 'review').slice(0, 3);
  remember(input, board);
  const parts = [INTRO, `Now: ${clip(board, 900)}`];
  if (lessons.length) parts.push(`Lessons for this repo:\n${lessons.map((l) => `- ${clip(l.text, 200)}`).join('\n')}`);
  return { code: 0, stdout: contextOutput('SessionStart', parts.join('\n\n')) };
}

/** Before each prompt: only what changed on the board since this session last heard, and nothing if nothing did. */
export async function promptSubmit(input: HookInput, client: ClientFactory): Promise<HookResult> {
  const ctx = await context(input, client);
  if (!ctx) return { code: 0 };
  const board = await ctx.c['board.text']({ projectId: ctx.projectId });
  const prev = recall(input);
  remember(input, board);
  if (prev === null) return { code: 0 };
  const before = new Set(prev.split('\n'));
  const fresh = board.split('\n').filter((l) => !before.has(l) && !l.startsWith('Tasks:'));
  if (!fresh.length) return { code: 0 };
  return { code: 0, stdout: contextOutput('UserPromptSubmit', `Yardmaster update:\n${clip(fresh.join('\n'), 800)}`) };
}

function stateFile(input: HookInput): string {
  return join(paths.tmp(), `hook-${sha1(input.session_id ?? String(process.ppid)).slice(0, 12)}.txt`);
}

function remember(input: HookInput, board: string): void {
  writeFileSync(stateFile(input), board);
}

function recall(input: HookInput): string | null {
  const f = stateFile(input);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

export const HOOK_EVENTS = ['session-start', 'prompt', 'pre-edit', 'post-edit'] as const;

export async function runHook(event: string, stdin: string, client: ClientFactory): Promise<HookResult> {
  const input = parseHookInput(stdin);
  if (!input) return { code: 0 };
  try {
    switch (event) {
      case 'pre-edit':
      case 'claude-pretool':
        return await preEdit(input, client);
      case 'post-edit':
        return await postEdit(input, client);
      case 'session-start':
        return await sessionStart(input, client);
      case 'prompt':
        return await promptSubmit(input, client);
      default:
        return { code: 0 };
    }
  } catch (err) {
    if (process.env.YARDMASTER_DEBUG) console.error('hook error', err);
    return { code: 0 };
  }
}

/** Kept for older settings files that call `ym hook claude-pretool`. */
export async function claudePreTool(stdin: string, client: ClientFactory): Promise<{ code: number; message?: string }> {
  const r = await runHook('pre-edit', stdin, client);
  return { code: r.code, message: r.stderr };
}
