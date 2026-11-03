import { isAbsolute, join, relative } from 'node:path';
import type { Client } from './api.ts';
import { mainRepoRoot, projectIdFor, repoRoot } from './git.ts';

interface PreToolInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
}

/**
 * Claude Code PreToolUse hook. Blocks an edit (exit 2, reason on stderr) only when another agent
 * genuinely holds the file. Any error, a missing hub, or an unknown repo lets the edit through:
 * coordination must never stop someone from working.
 */
export async function claudePreTool(stdin: string, client: () => Promise<Client | null>): Promise<{ code: number; message?: string }> {
  let input: PreToolInput;
  try {
    input = JSON.parse(stdin) as PreToolInput;
  } catch {
    return { code: 0 };
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const cwd = input.cwd ?? process.cwd();
  if (!file || process.env.YARDMASTER_TASK_ID) return { code: 0 }; // background agents are already isolated
  try {
    const abs = isAbsolute(file) ? file : join(cwd, file);
    const checkout = await repoRoot(cwd);
    const root = await mainRepoRoot(cwd);
    if (!checkout || !root) return { code: 0 };
    if (checkout !== root) return { code: 0 }; // separate worktrees do not share files; any overlap surfaces at merge time instead
    const c = await client();
    if (!c) return { code: 0 };
    const projectId = await projectIdFor(root);
    const rel = relative(root, abs);
    const holders = await c['lock.check']({ projectId, paths: [rel] });
    const sessions = await c['board.status']({ projectId });
    // The hook cannot see the MCP server's identity, so "mine" means a session registered from this same folder.
    const mine = new Set(sessions.sessions.filter((s) => s.cwd === cwd).map((s) => s.id));
    const others = holders.filter((h) => !mine.has(h.holder));
    if (!others.length) return { code: 0 };
    const h = others[0]!;
    return { code: 2, message: `Yardmaster: ${rel} is being changed by ${h.holder} (${h.detail}). Work on something else for now, or ask the user. Use the yard_who / yard_send tools to coordinate.` };
  } catch (err) {
    if (process.env.YARDMASTER_DEBUG) console.error('hook error', err);
    return { code: 0 };
  }
}
