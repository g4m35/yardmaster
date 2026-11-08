import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { basename, relative } from 'node:path';
import type { Client } from './api.ts';
import { mainRepoRoot, projectIdFor } from './git.ts';
import { NewTaskSchema } from './types.ts';
import { clip, formatUsd } from './text.ts';
import { machineId } from './paths.ts';
import { VERSION } from './version.ts';

/**
 * The MCP server is how Yardmaster meets people inside the agent they already use. Any MCP client
 * (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, T3 Code through its agents) gets a small set of
 * coordination tools. Outputs are short plain text on purpose: every token here is paid for by the user.
 */

const INSTRUCTIONS = `Yardmaster coordinates several coding agents on one repo so they don't collide.
- Big or parallelizable request? Split it with yard_add_tasks (give each task the files it will touch), then yard_wait.
- Before editing shared files yourself, call yard_claim_files (automatic when Yardmaster hooks are installed).
- yard_status shows what everyone is doing and anything that needs the user. yard_learn saves repo knowledge for future agents.`;

type Ctx = { client: Client; cwd: string; identity: string; agentName: string | null; profile?: 'full' | 'minimal'; claims?: Map<string, number> };

async function projectId(ctx: Ctx, repo?: string): Promise<{ id: string; root: string }> {
  const cwd = repo ?? ctx.cwd;
  const root = await mainRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository.`);
  const id = await projectIdFor(root);
  try {
    await ctx.client['project.resolve']({ projectId: id });
  } catch {
    await ctx.client['project.register']({ cwd: root });
  }
  return { id, root };
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true });

export function buildMcpServer(ctx: Ctx): McpServer {
  const claims = ctx.claims ?? new Map<string, number>();
  const server = new McpServer({ name: 'yardmaster', version: VERSION }, { instructions: INSTRUCTIONS });
  const repoArg = { repo: z.string().optional().describe('Path inside the repo; defaults to the current directory.') };

  // The SDK's overloads cannot infer through a generic schema parameter; the schema still validates every call at runtime.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: z.ZodObject; annotations?: Record<string, boolean> },
    cb: (args: unknown) => Promise<unknown>,
  ) => void;
  const handlers = new Map<string, { description: string; schema: z.ZodObject; run: (args: unknown) => Promise<string>; readOnly: boolean }>();
  const READ_ONLY = new Set(['yard_status', 'yard_wait', 'yard_task', 'yard_who', 'yard_inbox']);
  const tool = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.infer<S>) => Promise<string>) => {
    handlers.set(name, { description, schema, run: (a) => run(a as z.infer<S>), readOnly: READ_ONLY.has(name) });
  };

  tool('yard_status', 'What every agent is doing on this repo, what is waiting and why, and what needs the user.', z.object(repoArg), async (a) => {
    const p = await projectId(ctx, a.repo);
    return await ctx.client['board.text']({ projectId: p.id });
  });

  tool(
    'yard_add_tasks',
    'Queue work for background agents. Each task runs in its own worktree; tasks with overlapping "files" never run at once; "after" orders them. Use "key" to reference tasks in the same call.',
    z.object({ tasks: z.array(NewTaskSchema).min(1).max(30), ...repoArg }),
    async (a) => {
      const p = await projectId(ctx, a.repo);
      const r = await ctx.client['task.add']({ projectId: p.id, tasks: a.tasks, createdBy: ctx.identity });
      const lines = r.created.map((t) => `+ ${t.id} ${clip(t.title, 70)} [${t.tier}${t.scope.length ? `; ${t.scope.join(', ')}` : ''}]`);
      for (const d of r.duplicates) lines.push(`= skipped "${clip(d.title, 50)}": same as ${d.existing}`);
      lines.push(`Use yard_wait with these ids to get results.`);
      return lines.join('\n');
    },
  );

  tool('yard_wait', 'Wait (up to timeoutSec) until tasks finish or need attention. Cheaper than polling.', z.object({ ids: z.array(z.string()).min(1).max(30), timeoutSec: z.number().min(1).max(300).default(120) }), async (a) => {
    const rs = await ctx.client['task.wait']({ ids: a.ids, timeoutSec: a.timeoutSec });
    return rs.map((t) => `${t.id} [${'label' in t ? t.label : t.status}] ${'summary' in t && t.summary ? clip(t.summary, 200) : ''}${'attention' in t && t.attention ? ` ! ${clip(t.attention, 200)}` : ''}${'waiting' in t && t.waiting ? ` (${t.waiting})` : ''}`).join('\n');
  });

  tool('yard_task', 'Details for one task: status, why it is waiting, summary, last error, branch.', z.object({ id: z.string() }), async (a) => {
    const d = await ctx.client['task.get']({ id: a.id });
    const t = d.task;
    const run = d.runs.at(-1);
    return [
      `${t.id} "${t.title}" [${d.label}] attempt ${t.attempts}/${t.max_attempts}, ${formatUsd(t.cost_usd)}${run ? `, ${run.agent}${run.model ? `/${run.model}` : ''}` : ''}`,
      d.waiting ? `waiting: ${d.waiting}` : '',
      t.attention ? `needs: ${clip(t.attention, 400)}` : '',
      t.summary ? `summary: ${clip(t.summary, 400)}` : '',
      t.last_error && !t.attention ? `last error: ${clip(t.last_error, 400)}` : '',
      t.branch ? `branch: ${t.branch}${t.worktree ? ` (worktree ${t.worktree})` : ''}` : '',
      d.deps.length ? `after: ${d.deps.map((x) => `${x.id}[${x.status}]`).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  });

  tool('yard_claim_files', 'Reserve files/globs before you edit them so background agents and other sessions stay away. Returns who holds them if taken.', z.object({ patterns: z.array(z.string()).min(1), reason: z.string().optional(), minutes: z.number().min(1).max(480).default(30), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    const patterns = a.patterns.map((x) => (x.startsWith('/') ? relative(p.root, x) : x));
    const r = await ctx.client['lock.claim']({ projectId: p.id, holder: ctx.identity, patterns, reason: a.reason ?? null, ttlMinutes: a.minutes });
    if (r.ok) return `Reserved ${patterns.join(', ')} for ${a.minutes} min.`;
    return `Not reserved. Taken:\n${r.conflicts.map((c) => `- ${c.pattern} by ${c.holder}${c.reason ? ` (${c.reason})` : ''}`).join('\n')}\nWork on something else, or coordinate with yard_send.`;
  });

  tool('yard_release_files', 'Release files you reserved (all of them if none listed).', z.object({ patterns: z.array(z.string()).optional(), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    const n = await ctx.client['lock.release']({ projectId: p.id, holder: ctx.identity, patterns: a.patterns });
    return `Released ${n} reservation(s).`;
  });

  tool('yard_who', 'Who is working on these paths right now?', z.object({ paths: z.array(z.string()).min(1), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    const r = await ctx.client['lock.check']({ projectId: p.id, paths: a.paths.map((x) => (x.startsWith('/') ? relative(p.root, x) : x)) });
    return r.length ? r.map((h) => `${h.path}: ${h.holder} (${h.detail})`).join('\n') : 'Nobody. Free to edit.';
  });

  tool('yard_take_task', 'Take a queued task to do yourself in this session (next best one if no id).', z.object({ id: z.string().optional(), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    const t = await ctx.client['session.claim']({ sessionId: ctx.identity, projectId: p.id, taskId: a.id });
    if (!t) return 'Nothing is ready to take right now.';
    claims.set(t.id, t.generation);
    if (t.scope.length) await ctx.client['lock.claim']({ projectId: p.id, holder: ctx.identity, patterns: t.scope, reason: t.title, ttlMinutes: 60 }).catch(() => undefined);
    return `You have ${t.id}: ${t.title}\n${t.prompt !== t.title ? t.prompt + '\n' : ''}${t.scope.length ? `Files: ${t.scope.join(', ')}\n` : ''}When finished call yard_finish_task with a short summary.`;
  });

  tool('yard_finish_task', 'Report a task this connection took as finished (or failed). An optional local branch queues its committed clean artifact for full checks, review and integration without rerunning coding. Remote native export is unsupported.', z.object({ id: z.string(), summary: z.string(), outcome: z.enum(['done', 'failed']).default('done'), branch: z.string().optional() }), async (a) => {
    const generation = claims.get(a.id);
    if (generation === undefined) throw new Error('This connection has no captured claim for that task. Do not finish a claim owned by another or restarted connection; retry/reclaim it through Yardmaster first.');
    const t = await ctx.client['session.finish']({ sessionId: ctx.identity, taskId: a.id, generation, summary: a.summary, outcome: a.outcome, branch: a.branch }).catch(async error => {
      // A rejected capture may have durably retired this generation. Never borrow a new one on retry/restart.
      const current = await ctx.client['task.peek']({ id: a.id }).catch(() => null);
      if (current && (current.generation !== generation || current.assignee !== ctx.identity || current.status !== 'running')) claims.delete(a.id);
      throw error;
    });
    claims.delete(a.id);
    return `${t.id} is now ${t.status}.${a.branch ? ' Native artifact submitted; checks/review and integration are still pending. Source branch/worktree are preserved.' : ' Reported outcome only; no automated verification claimed.'}`;
  });

  tool('yard_send', 'Leave a short note for a task id, a session, or "*" for everyone (handoffs, warnings about shared APIs).', z.object({ to: z.string(), body: z.string().max(2000), taskId: z.string().optional(), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    await ctx.client['msg.send']({ projectId: p.id, from: ctx.identity, to: a.to, body: a.body, taskId: a.taskId });
    return 'Sent.';
  });

  tool('yard_inbox', 'Notes other agents left for you.', z.object(repoArg), async (a) => {
    const p = await projectId(ctx, a.repo);
    const msgs = await ctx.client['msg.inbox']({ projectId: p.id, reader: ctx.identity, aliases: process.env.YARDMASTER_TASK_ID ? [process.env.YARDMASTER_TASK_ID] : [] });
    return msgs.length ? msgs.map((m) => `${m.from}: ${m.body}`).join('\n') : 'No new notes.';
  });

  tool('yard_control', 'retry, cancel, stop, approve (merge), prioritize, or redirect a task (redirect needs a note: what to do differently).', z.object({ id: z.string(), action: z.enum(['retry', 'cancel', 'stop', 'approve', 'prioritize', 'redirect']), note: z.string().max(2000).optional() }), async (a) => {
    const t = await ctx.client['task.control']({ id: a.id, action: a.action, by: ctx.identity, note: a.note });
    return `${t.id} is now ${t.status}.`;
  });

  tool('yard_learn', 'Record something future agents on this repo should know (a required build step, a convention, a trap). It is added to the briefing of related tasks.', z.object({ text: z.string().min(12).max(1000), files: z.array(z.string()).default([]), ...repoArg }), async (a) => {
    const p = await projectId(ctx, a.repo);
    const l = await ctx.client['lesson.add']({ projectId: p.id, text: a.text, files: a.files, source: 'agent', taskId: process.env.YARDMASTER_TASK_ID ?? null });
    return l ? 'Saved. Related tasks will be briefed with it.' : 'Too short to be useful; add a bit more detail.';
  });

  if (ctx.profile === 'minimal') {
    // One tool for clients that load every definition up front: a few hundred tokens instead of a dozen schemas.
    const names = [...handlers.keys()].map((n) => n.replace(/^yard_/, ''));
    register('yard', {
      description: `Coordinate with other coding agents on this repo. action is one of: ${names.join(', ')}. input holds that action's fields, e.g. {"action":"add_tasks","input":{"tasks":[{"title":"...","files":["src/x/**"]}]}}, {"action":"wait","input":{"ids":["t-1"]}}, {"action":"claim_files","input":{"patterns":["src/a.ts"]}}.`,
      inputSchema: z.object({ action: z.enum(names as [string, ...string[]]), input: z.record(z.string(), z.unknown()).default({}) }),
    }, async (raw) => {
      const { action, input } = raw as { action: string; input: Record<string, unknown> };
      const h = handlers.get(`yard_${action}`)!;
      const parsed = h.schema.safeParse(input);
      if (!parsed.success) return fail(new Error(z.prettifyError(parsed.error)));
      try {
        return text(await h.run(parsed.data));
      } catch (err) {
        return fail(err);
      }
    });
  } else {
    for (const [name, h] of handlers) {
      register(name, { description: h.description, inputSchema: h.schema, annotations: { readOnlyHint: h.readOnly, destructiveHint: false, openWorldHint: false } }, async (args) => {
        try {
          return text(await h.run(args));
        } catch (err) {
          return fail(err);
        }
      });
    }
  }
  return server;
}

export async function runMcp(client: Client, opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const taskId = process.env.YARDMASTER_TASK_ID;
  const agentName = process.env.YARDMASTER_AGENT ?? null;
  const identity = taskId ?? `session:${process.env.YARDMASTER_SESSION ?? `${basename(cwd)}-${process.ppid}`}`;
  const ctx: Ctx = { client, cwd, identity, agentName, claims: new Map(), profile: process.env.YARDMASTER_MCP_PROFILE === 'minimal' ? 'minimal' : 'full' };
  if (!taskId) {
    const root = await mainRepoRoot(cwd).catch(() => null);
    let pid: string | null = null;
    if (root) pid = await projectIdFor(root).catch(() => null);
    await client['session.register']({ name: identity.replace(/^session:/, ''), agent: agentName, projectId: pid, cwd, machineId: machineId() }).catch(() => undefined);
    setInterval(() => {
      void client['session.register']({ name: identity.replace(/^session:/, ''), agent: agentName, projectId: pid, cwd, machineId: machineId() }).catch(() => undefined);
      const claims = [...ctx.claims!].map(([taskId, generation]) => ({ taskId, generation }));
      if (claims.length) void client['session.heartbeat']({ sessionId: identity, claims }).then((results) => {
        for (const r of results) if (!r.renewed) ctx.claims!.delete(r.taskId);
      }).catch(() => undefined);
    }, 60_000).unref();
  }
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
