import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Client } from './api.ts';
import { mainRepoRoot, projectIdFor, repoRoot } from './git.ts';
import { paths, machineId } from './paths.ts';
import { clip, sha1 } from './text.ts';
import { nativeSessionName } from './hookclient.ts';

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

interface RepoInfo {
  checkout: string | null;
  root: string | null;
  projectId: string | null;
  managed: boolean;
  at: number;
}

/**
 * Which repo (and Yardmaster project) a folder belongs to rarely changes, but finding out costs three git
 * processes and a hub request. Hooks run on every prompt and edit, so the answer is cached per folder:
 * managed repos for 30 minutes, everything else for 2 (so a fresh `ym init` is noticed quickly).
 */
function repoCachePath(): string {
  return join(paths.tmp(), 'hook-repos.json');
}

function readRepoCache(): Record<string, RepoInfo> {
  try {
    return JSON.parse(readFileSync(repoCachePath(), 'utf8')) as Record<string, RepoInfo>;
  } catch {
    return {};
  }
}

async function repoInfo(cwd: string, client: ClientFactory): Promise<{ info: RepoInfo; c: Client | null }> {
  const cache = readRepoCache();
  const hit = cache[cwd];
  const ttl = hit?.managed ? 30 * 60_000 : 2 * 60_000;
  if (hit && Date.now() - hit.at < ttl) return { info: hit, c: hit.managed ? await client() : null };
  const [checkout, root] = await Promise.all([repoRoot(cwd), mainRepoRoot(cwd)]);
  let projectId: string | null = null;
  let managed = false;
  const c = checkout && root ? await client() : null;
  if (c && root) {
    projectId = await projectIdFor(root).catch(() => null);
    if (projectId) managed = await c['project.resolve']({ projectId }).then(() => true, () => false);
  }
  const info: RepoInfo = { checkout, root, projectId, managed, at: Date.now() };
  // The hub being unreachable says nothing about the repo, so don't remember that.
  if (c || !checkout) {
    cache[cwd] = info;
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    writeFileSync(repoCachePath(), JSON.stringify(Object.fromEntries(entries)));
  }
  return { info, c };
}

async function context(input: HookInput, client: ClientFactory) {
  if (process.env.YARDMASTER_TASK_ID) return null; // background agents are briefed and isolated already
  const cwd = real(input.cwd ?? process.cwd());
  const { info, c } = await repoInfo(cwd, client);
  if (!info.managed || !info.checkout || !info.root || !info.projectId || !c) return null;
  const { checkout, root, projectId } = info;
  const sessionName = nativeSessionName(`hook-${sha1(input.session_id ?? String(process.ppid)).slice(0, 8)}`);
  const sessionId = await c['session.register']({ name: sessionName, agent: 'hooked-agent', projectId, cwd, machineId: machineId() });
  return { c, cwd, checkout, root, projectId, sessionName, sessionId };
}

/** Physical path, so /tmp vs /private/tmp (or any symlinked folder) can't hide a file from its repo. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A file about to be created doesn't exist yet: resolve its folder instead.
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

function relToRoot(root: string, cwd: string, f: string): string {
  return relative(root, real(isAbsolute(f) ? f : join(cwd, f)));
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
  const rel = files.map((f) => relToRoot(ctx.root, ctx.cwd, f));
  // Registration returns the exact project/machine identity; other sessions in this folder remain independent.
  const other = await ctx.c['hook.check']({ projectId: ctx.projectId, paths: rel, cwd: ctx.cwd, sessionId: ctx.sessionId });
  if (!other) return { code: 0 };
  return { code: 2, stderr: `Yardmaster: ${other.path} is being changed by ${other.holder} (${other.detail}). Work on something else for now, or ask the user. The yard_who and yard_send tools help coordinate.` };
}

/** Reserve what this session just edited, so background agents leave it alone. No tool call, no tokens. */
export async function postEdit(input: HookInput, client: ClientFactory): Promise<HookResult> {
  const files = editedPaths(input);
  if (!files.length) return { code: 0 };
  const ctx = await context(input, client);
  if (!ctx || ctx.checkout !== ctx.root) return { code: 0 };
  const rel = files.map((f) => relToRoot(ctx.root, ctx.cwd, f)).filter((f) => !f.startsWith('..'));
  if (!rel.length) return { code: 0 };
  const r = await ctx.c['hook.reserve']({ projectId: ctx.projectId, sessionName: ctx.sessionName, cwd: ctx.cwd, paths: rel, machineId: machineId() });
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
