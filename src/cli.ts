#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createInterface as createLineReader } from 'node:readline';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMethods, localClient, remoteClient, type Client } from './api.ts';
import { Coordinator } from './coordinator.ts';
import { openDb } from './db.ts';
import { expandHome, hubToken, machineId, paths, yardHome } from './paths.ts';
import { loadConfig, PRESETS, PROJECT_CONFIG_FILE, writeProjectConfig, type Tier } from './config.ts';
import { detectAgents, getAdapter } from './adapters/index.ts';
import { clearHubInfo, Hub, readHubInfo, writeHubInfo } from './hub.ts';
import { planCleanup, runCleanup, type CleanPlan } from './janitor.ts';
import { currentBranch, mainRepoRoot, projectIdFor, git, revParse } from './git.ts';
import { isAlive, run, which } from './proc.ts';
import { ago, clip, formatUsd } from './text.ts';
import { STATUS_LABEL, type Task } from './types.ts';
import { WorkerLoop } from './worker.ts';
import { Semaphore } from './runner.ts';
import { httpTransport } from './transport.ts';
import { runMcp } from './mcp.ts';
import { applyConnect, connectPlan, hookPlan, installHooks, installSkill, selfCommand } from './connect.ts';
import { HOOK_EVENTS, runHook } from './hook.ts';
import { creatorPrompt, loadPlugins, scaffoldPlugin, testPlugin } from './plugins.ts';
import { planGoal } from './planner.ts';
import { VERSION } from './version.ts';
import { serviceFiles, installService, uninstallService } from './service.ts';
import { inSea } from './assets.ts';
import { runMockAgent } from './mockagent.ts';
import { TIERS } from './config.ts';

// ---------- tiny argument parser ----------

interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (v !== undefined) out.flags[k] = v;
      else if (next !== undefined && !next.startsWith('-') && !BOOLEAN_FLAGS.has(k)) {
        out.flags[k] = next;
        i++;
      } else out.flags[k] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      const k = SHORT[a[1]!] ?? a[1]!;
      if (BOOLEAN_FLAGS.has(k)) out.flags[k] = true;
      else {
        out.flags[k] = argv[i + 1] ?? true;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const SHORT: Record<string, string> = { f: 'follow', n: 'lines', y: 'yes', j: 'json', h: 'help' };
const BOOLEAN_FLAGS = new Set(['with-hooks', 'no-skill', 'now', 'version', 'follow', 'yes', 'json', 'help', 'all', 'dry-run', 'foreground', 'force', 'no-changes-ok', 'watch', 'with-hook', 'no-hub', 'open']);

const flag = (a: Args, k: string) => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
const list = (a: Args, k: string) => flag(a, k)?.split(',').map((s) => s.trim()).filter(Boolean);

// ---------- output helpers ----------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const cyan = c('36');

const STATUS_COLOR: Record<string, (s: string) => string> = {
  queued: dim, running: cyan, verifying: cyan, ready: green, merging: green, done: green, needs_human: yellow, failed: red, canceled: dim,
};

function die(msg: string): never {
  console.error(red(`✖ ${msg}`));
  process.exit(1);
}

// ---------- hub discovery ----------

async function hubAlive(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && ((await r.json()) as { name?: string }).name === 'yardmaster';
  } catch {
    return false;
  }
}

async function runningHubUrl(): Promise<string | null> {
  const info = readHubInfo();
  if (info && isAlive(info.pid) && (await hubAlive(info.url))) return info.url;
  return null;
}

async function startHubInBackground(extra: string[] = []): Promise<string> {
  const existing = await runningHubUrl();
  if (existing) return existing;
  const log = openSync(paths.hubLog(), 'a');
  const [cmd, ...pre] = selfCommand();
  const child = spawn(cmd!, [...pre, 'hub', 'run', ...extra], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const url = await runningHubUrl();
    if (url) return url;
  }
  die(`The hub did not start. See ${paths.hubLog()}`);
}

/** Remote hub if configured, the local running hub if any, otherwise direct database access. */
async function getClient(a: Args, opts: { needHub?: boolean } = {}): Promise<Client> {
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  if (remote) return remoteClient(remote, flag(a, 'token') ?? process.env.YARDMASTER_TOKEN ?? hubToken());
  let url = await runningHubUrl();
  if (!url && opts.needHub && !a.flags['no-hub']) {
    url = await startHubInBackground();
    console.log(dim(`Started the Yardmaster hub in the background (${url}).`));
  }
  if (url) return remoteClient(url, hubToken());
  const coord = new Coordinator(openDb());
  return localClient(buildMethods(coord, { machineId: machineId(), cleanPlan: (p) => planCleanup(coord, p), cleanRun: async (p) => runCleanup(coord, await planCleanup(coord, p)) }));
}

async function currentProject(client: Client, cwd = process.cwd()) {
  const root = await mainRepoRoot(cwd);
  if (!root) die('Run this inside a git repository (or pass --repo).');
  const id = await projectIdFor(root).catch((e: Error) => die(e.message));
  try {
    return await client['project.resolve']({ projectId: id });
  } catch {
    return await client['project.register']({ cwd: root });
  }
}

// ---------- commands ----------

const HELP = `${bold('Yardmaster')} ${VERSION}: run many coding agents at once without the mess.

${bold('Get started')}
  ym init                      set up this repo (detects your agents and test command)
  ym connect [agent|all]       add Yardmaster tools + skill to Claude Code, Codex, Cursor, OpenCode, Gemini
                               (--with-hooks: zero-token coordination for Claude Code and Codex)
  ym add "what you want"       queue work (--files, --after, --agent, --tier cheap|standard|strong)
  ym plan "a bigger goal"      let an agent split a goal into parallel tasks (--yes to queue them)
  ym status                    what's happening (--watch, --all, --json)
  ym dashboard                 open the live dashboard

${bold('Manage work')}
  ym show <id>   ym logs <id> [-f]   ym retry|cancel|stop|approve <id>
  ym tell <id> "do X instead"  redirect a running agent (it keeps its work so far)
  ym pause [--now] [--all]     stop new work from starting (--now also parks running agents)
  ym resume                    start queued work again
  ym disk                      what uses disk space and what can be freed
  ym learn "..." [--files g]   teach every future agent something about this repo
  ym lessons [--all]           what agents have learned here (forget <id> to retire one)
  ym land                      bring finished work into your branch (fast-forward only)
  ym clean [--yes]             remove finished worktrees/branches/locks; never unmerged work

${bold('Machines')}
  ym hub start|stop|status|run [--host 0.0.0.0] [--port 7777]
  ym service install|uninstall keep the hub running across crashes and reboots
  ym token                     show how to connect another machine
  ym worker --hub URL --token T [--repo path]

${bold('Extend')}
  ym plugin new <name> [--kind adapter|notifier] [--describe "..."] [--with claude]
  ym plugin test <name>   ym plugin list   ym presets   ym doctor   ym demo
`;

async function cmdInit(a: Args) {
  const root = await mainRepoRoot(process.cwd());
  if (!root) die('Not a git repository. Run "git init" and make a first commit first.');
  const client = await getClient(a);
  const project = await client['project.register']({ cwd: root });
  const cfgFile = join(root, PROJECT_CONFIG_FILE);
  if (!existsSync(cfgFile)) {
    const verify = detectVerify(root);
    const preset = flag(a, 'preset') ?? 'balanced';
    if (!(preset in PRESETS)) die(`Unknown preset ${preset}. Options: ${Object.keys(PRESETS).join(', ')}`);
    writeProjectConfig(root, { preset, verify });
    console.log(green(`✔ Wrote ${PROJECT_CONFIG_FILE}`) + dim(` (preset ${preset}${verify.length ? `, checks: ${verify.join(' && ')}` : ', no test command found: add one to "verify"'})`));
    console.log(dim(`  Commit it so every machine and teammate uses the same settings.`));
  }
  const agents = detectAgents(loadConfig(root));
  console.log(green(`✔ ${project.name} is ready`) + dim(` (base branch ${project.base_branch}, id ${project.id})`));
  console.log(agents.length ? `Agents found: ${agents.map((x) => bold(x)).join(', ')}` : yellow('No coding agents found on PATH. Install Claude Code, Codex, OpenCode, Cursor CLI or Gemini CLI.'));
  console.log(`\nNext:\n  ${cyan('ym connect all')}      so your agents can use Yardmaster from where you already work\n  ${cyan('ym add "..."')}        or ask your agent to "split this into parallel tasks with yardmaster"`);
}

function detectVerify(root: string): string[] {
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      const runner = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) ? 'bun' : 'npm';
      const out: string[] = [];
      if (scripts.typecheck) out.push(`${runner} run typecheck`);
      if (scripts.test && !/no test specified/.test(scripts.test)) out.push(`${runner} test`);
      if (out.length) return out;
    } catch {
      // unreadable package.json: fall through
    }
  }
  if (existsSync(join(root, 'Cargo.toml'))) return ['cargo test'];
  if (existsSync(join(root, 'go.mod'))) return ['go test ./...'];
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini'))) return [which('uv') ? 'uv run pytest' : 'pytest'];
  return [];
}

async function cmdAdd(a: Args) {
  const title = a._.slice(1).join(' ').trim();
  if (!title) die('Say what you want done: ym add "fix the login redirect"');
  const client = await getClient(a, { needHub: true });
  const project = await currentProject(client);
  const tier = flag(a, 'tier') as Tier | undefined;
  if (tier && !TIERS.includes(tier)) die(`--tier must be one of ${TIERS.join(', ')}`);
  const res = await client['task.add']({
    projectId: project.id,
    createdBy: 'cli',
    force: Boolean(a.flags.force),
    tasks: [{
      title: clip(title.split('\n')[0], 200),
      prompt: flag(a, 'prompt') ?? title,
      files: list(a, 'files'),
      after: list(a, 'after'),
      agent: flag(a, 'agent'),
      tier,
      verify: flag(a, 'verify') ? [flag(a, 'verify')!] : undefined,
      priority: flag(a, 'priority') ? Number(flag(a, 'priority')) : undefined,
      budgetUsd: flag(a, 'budget') ? Number(flag(a, 'budget')) : undefined,
      allowNoChanges: Boolean(a.flags['no-changes-ok']),
      bestOf: flag(a, 'best-of') ? Number(flag(a, 'best-of')) : undefined,
      review: flag(a, 'review') === 'always' || flag(a, 'review') === 'never' ? (flag(a, 'review') as 'always' | 'never') : undefined,
    }],
  });
  for (const t of res.created) console.log(green(`✔ Queued ${bold(t.id)}`) + ` ${t.title} ${dim(`[${t.tier}${t.scope.length ? `; files ${t.scope.join(', ')}` : ''}]`)}`);
  for (const d of res.duplicates) console.log(yellow(`= Already queued as ${d.existing} "${d.existingTitle}". Use --force to add it anyway.`));
}

async function cmdPlan(a: Args) {
  const goal = a._.slice(1).join(' ').trim();
  if (!goal) die('Describe the goal: ym plan "add CSV export to reports with tests"');
  const root = (await mainRepoRoot(process.cwd())) ?? die('Run inside a git repository.');
  const config = loadConfig(root);
  const agent = flag(a, 'agent') ?? detectAgents(config)[0] ?? die('No coding agent installed to plan with.');
  console.log(dim(`Asking ${getAdapter(agent, config)?.label ?? agent} to plan (read-only)...`));
  const { tasks, costUsd } = await planGoal(goal, { cwd: root, agent, config });
  console.log(bold(`\nPlan (${tasks.length} tasks${costUsd !== null ? `, planning cost ${formatUsd(costUsd)}` : ''}):`));
  for (const t of tasks) console.log(`  ${cyan(t.key ?? '-')} ${t.title} ${dim(`[${t.tier ?? 'auto'}${t.files?.length ? `; ${t.files.join(', ')}` : ''}${t.after?.length ? `; after ${t.after.join(', ')}` : ''}]`)}`);
  let go = Boolean(a.flags.yes);
  if (!go && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    go = /^y/i.test(await rl.question('\nQueue these tasks? [y/N] '));
    rl.close();
  }
  if (!go) return console.log(dim('Nothing queued. Re-run with --yes to queue.'));
  const client = await getClient(a, { needHub: true });
  const project = await currentProject(client, root);
  const res = await client['task.add']({ projectId: project.id, tasks, createdBy: `plan:${agent}` });
  console.log(green(`✔ Queued ${res.created.length} task(s).`) + (res.duplicates.length ? yellow(` Skipped ${res.duplicates.length} duplicate(s).`) : ''));
}

function taskLine(t: { id: string; title: string; status: string; label: string; agent?: string | null; waiting?: string | null; lastActivity?: string | null; cost?: number; assignee?: string | null }) {
  const color = STATUS_COLOR[t.status] ?? ((s: string) => s);
  const who = t.assignee?.startsWith('session:') ? t.assignee.slice(8) : t.agent ?? '';
  const detail = t.waiting ?? t.lastActivity ?? '';
  return `  ${color(t.label.padEnd(14))} ${bold(t.id)} ${clip(t.title, 50)}${who ? dim(` · ${who}`) : ''}${t.cost ? dim(` · ${formatUsd(t.cost)}`) : ''}${detail ? `\n${' '.repeat(17)}${dim(clip(detail, 100))}` : ''}`;
}

async function cmdStatus(a: Args) {
  const client = await getClient(a);
  const projectId = a.flags.all ? null : (await currentProject(client).catch(() => null))?.id ?? null;
  const render = async () => {
    const b = await client['board.status']({ projectId });
    if (a.flags.json) return console.log(JSON.stringify(b, null, 2));
    const lines: string[] = [];
    const hub = await runningHubUrl();
    lines.push(`${bold('Yardmaster')} ${hub ? green('● hub running') : yellow('○ hub not running (ym hub start)')}  ${dim(`spent today ${formatUsd(b.spentToday)}`)}`);
    const machines = b.machines.filter((m) => m.online);
    if (machines.length) lines.push(dim(`Machines: ${machines.map((m) => `${m.name} (${m.running}/${m.maxParallel} busy, ${m.agents.join(' ') || 'no agents'}${m.diskFreeGb !== null ? `, ${m.diskFreeGb} GB free` : ''})`).join(', ')}`));
    if (b.paused.paused) lines.push(yellow(bold(`Paused by ${b.paused.by}`)) + yellow(': no new work starts. Resume with "ym resume".'));
    if (b.budgetRunsOutAt) lines.push(yellow(`At this pace today's budget runs out around ${new Date(b.budgetRunsOutAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
    if (b.attention.length) {
      lines.push('', yellow(bold(`Needs you (${b.attention.length})`)));
      for (const t of b.attention) lines.push(`  ${yellow('!')} ${bold(t.id)} ${clip(t.title, 60)}\n    ${clip(t.why, 220)}`);
    }
    if (b.warnings.length) {
      lines.push('', bold('Heads up'));
      for (const w of b.warnings) lines.push(`  ${cyan('~')} ${clip(w.message, 220)}`);
    }
    if (b.active.length) {
      lines.push('', bold('In progress'));
      for (const t of b.active) lines.push(taskLine(t));
    }
    if (b.recentDone.length) {
      lines.push('', bold('Recently done'));
      for (const t of b.recentDone) lines.push(`  ${green('✔')} ${bold(t.id)} ${clip(t.title, 60)}${t.summary ? dim(` · ${clip(t.summary, 70)}`) : ''}`);
    }
    if (!b.active.length && !b.attention.length && !b.recentDone.length) lines.push('', dim('Nothing queued. Try: ym add "describe a change"'));
    if (a.flags.watch && tty) process.stdout.write('\x1b[2J\x1b[H');
    console.log(lines.join('\n'));
  };
  await render();
  if (a.flags.watch) setInterval(() => void render(), 2000);
}

async function cmdShow(a: Args) {
  const id = a._[1] ?? die('Which task? ym show <id>');
  const client = await getClient(a);
  const d = await client['task.get']({ id });
  if (a.flags.json) return console.log(JSON.stringify(d, null, 2));
  const t = d.task;
  console.log(`${bold(t.id)} ${t.title}\n${(STATUS_COLOR[t.status] ?? dim)(d.label)}  attempt ${t.attempts}/${t.max_attempts}  tier ${t.tier}  ${formatUsd(t.cost_usd)}  created ${ago(t.created_at)} ago`);
  if (d.waiting) console.log(yellow(`Waiting: ${d.waiting}`));
  if (t.attention) console.log(yellow(`Needs you: ${t.attention}`));
  if (t.scope.length) console.log(`Files: ${t.scope.join(', ')}${t.scope_inferred ? dim(' (guessed from the request)') : ''}`);
  if (d.deps.length) console.log(`After: ${d.deps.map((x) => `${x.id} (${x.status})`).join(', ')}`);
  if (t.branch) console.log(`Branch: ${t.branch}${t.worktree ? dim(`  worktree ${t.worktree}`) : ''}`);
  if (t.summary) console.log(`\n${bold('Summary')}\n${t.summary}`);
  if (t.last_error && t.status !== 'done') console.log(`\n${bold('Last problem')}\n${clip(t.last_error, 1500)}`);
  if (d.runs.length) {
    console.log(`\n${bold('Runs')}`);
    for (const r of d.runs) {
      const verdict = r.role === 'review' && r.verdict ? (JSON.parse(r.verdict) as { verdict: string }).verdict : null;
      console.log(`  #${r.attempt} ${r.role === 'review' ? 'review by ' : ''}${r.agent}${r.model ? `/${r.model}` : ''} ${verdict ?? r.status}${r.stop_reason ? ` (${r.stop_reason})` : ''} ${formatUsd(r.cost_usd)}${r.cost_estimated ? dim(' est.') : ''}${r.lessons.length ? dim(` briefed with ${r.lessons.length} lesson(s)`) : ''} ${dim(`${ago(r.started_at)} ago on ${r.machine_id}`)}`);
    }
    if (t.policies.length) console.log(dim(`  rules applied: ${t.policies.join(', ')}`));
    if (t.race_group) console.log(dim(`  part of a race: ${t.race_group}`));
  }
  console.log(`\n${bold('Recent events')}`);
  for (const e of d.events.slice(-12)) console.log(`  ${dim(new Date(e.ts).toLocaleTimeString())} ${e.message}`);
}

async function cmdLogs(a: Args) {
  const id = a._[1] ?? die('Which task? ym logs <id>');
  const client = await getClient(a);
  const n = Number(flag(a, 'lines') ?? 60);
  let printed = '';
  const show = async () => {
    const text = await client['task.logs']({ id, lines: a.flags.follow ? 2000 : n });
    const fresh = text.startsWith(printed) ? text.slice(printed.length) : text;
    if (fresh) process.stdout.write(fresh);
    printed = text;
  };
  await show();
  if (a.flags.follow) setInterval(() => void show(), 1000);
}

async function cmdControl(a: Args, action: 'retry' | 'cancel' | 'stop' | 'approve') {
  const id = a._[1] ?? die(`Which task? ym ${action} <id>`);
  const client = await getClient(a);
  const t = await client['task.control']({ id, action, by: 'you' });
  console.log(green(`✔ ${t.id} is now ${STATUS_LABEL[t.status]}`));
}

async function cmdPause(a: Args, pause: boolean) {
  const client = await getClient(a);
  const projectId = a.flags.all ? null : (await currentProject(client).catch(() => null))?.id ?? null;
  if (pause) {
    await client['fleet.pause']({ projectId, stopRunning: Boolean(a.flags.now), by: 'you' });
    console.log(green(`✔ Paused ${projectId ? 'this project' : 'everything'}.`) + (a.flags.now ? ' Running agents saved their work and stopped; they continue on resume.' : ' Running agents finish their current task; nothing new starts.'));
  } else {
    await client['fleet.resume']({ projectId, by: 'you' });
    console.log(green('✔ Resumed. Queued work will start again.'));
  }
}

async function cmdTell(a: Args) {
  const id = a._[1] ?? die('Which task? ym tell <id> "what to do differently"');
  const note = a._.slice(2).join(' ').trim() || die('Say what the agent should do differently.');
  const client = await getClient(a);
  const t = await client['task.control']({ id, action: 'redirect', by: 'you', note });
  console.log(green(`✔ ${t.id} will ${t.status === 'running' ? 'restart with your guidance, keeping its work so far' : 'use your guidance on its next attempt'}.`));
}

async function cmdDisk(a: Args) {
  const client = await getClient(a);
  const projectId = a.flags.all ? null : (await currentProject(client).catch(() => null))?.id ?? null;
  const r = await client['disk.report']({ projectId });
  if (a.flags.json) return console.log(JSON.stringify(r, null, 2));
  const fmt = (b: number) => (b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1)} GB`);
  const low = r.freeGb < r.minFreeGb;
  console.log(`${bold('Disk')}  ${low ? red(`${r.freeGb.toFixed(1)} GB free`) : green(`${r.freeGb.toFixed(1)} GB free`)} ${dim(`(new work pauses below ${r.minFreeGb} GB)`)}`);
  console.log(`Worktrees use ${bold(fmt(r.worktreesBytes))}${r.quotaGb ? dim(` of a ${r.quotaGb} GB quota`) : ''}, logs ${fmt(r.logsBytes)}.`);
  if (r.worktrees.length) {
    console.log(bold('\nLargest worktrees'));
    for (const w of r.worktrees.slice(0, 12)) console.log(`  ${fmt(w.bytes).padStart(8)}  ${(STATUS_COLOR[w.status] ?? dim)((STATUS_LABEL[w.status as keyof typeof STATUS_LABEL] ?? w.status).padEnd(14))} ${w.taskId} ${dim(clip(w.title ?? '', 50))}`);
  }
  console.log(r.reclaimableBytes > 0 ? `\n${green(fmt(r.reclaimableBytes))} can be freed safely: run ${cyan('ym clean --yes')}.` : dim('\nNothing more can be freed without touching unmerged work.'));
}

async function cmdService(a: Args) {
  const sub = a._[1] ?? 'status';
  const files = serviceFiles(flag(a, 'host'), flag(a, 'port'));
  if (sub === 'install') {
    if (a.flags['dry-run']) return console.log(`${bold(files.path)}\n${files.content}`);
    await installService(files);
    return console.log(green(`✔ The hub now starts at login and restarts if it crashes (${files.path}).`) + dim('\n  Stop it for good with: ym service uninstall'));
  }
  if (sub === 'uninstall') {
    await uninstallService(files);
    return console.log(green('✔ Removed the hub service. Start it by hand with "ym hub start" when needed.'));
  }
  console.log(existsSync(files.path) ? green(`● Installed: ${files.path}`) : dim('Not installed. Run "ym service install" to keep the hub running in the background.'));
}

async function cmdLand(a: Args) {
  const root = (await mainRepoRoot(process.cwd())) ?? die('Run inside the repository.');
  const config = loadConfig(root);
  const client = await getClient(a);
  const project = await currentProject(client, root);
  const integration = config.integration.branch;
  if (!(await revParse(root, integration))) die('Nothing has been merged yet.');
  const branch = await currentBranch(root);
  const ahead = (await git(root, ['rev-list', '--count', `${project.base_branch}..${integration}`])).stdout.trim();
  if (ahead === '0') return console.log(green('✔ Your branch already has all finished work.'));
  if (branch !== project.base_branch) die(`Switch to ${project.base_branch} first (you are on ${branch ?? 'a detached HEAD'}).`);
  const tracked = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (tracked) die('You have uncommitted changes to tracked files. Commit or stash them, then run ym land again.');
  const ff = await git(root, ['merge', '--ff-only', integration], { allowFail: true });
  if (ff.code === 0) return console.log(green(`✔ ${project.base_branch} now includes ${ahead} commit(s) of finished agent work.`));
  console.log(yellow(`${project.base_branch} has new commits of its own, so this is not a fast-forward.`));
  console.log(`Review and merge yourself:  ${cyan(`git merge ${integration}`)}`);
}

function printPlan(plan: CleanPlan, executed: boolean) {
  if (!plan.remove.length) console.log(green('✔ Nothing to clean up.'));
  else {
    console.log(bold(executed ? `Removed ${plan.remove.length} item(s):` : `Would remove ${plan.remove.length} item(s):`));
    for (const i of plan.remove) console.log(`  ${dim(i.kind.padEnd(8))} ${clip(i.target, 90)}\n           ${dim(i.reason)}`);
  }
  if (plan.keep.length) {
    console.log(bold(`\nKept on purpose (${plan.keep.length}):`));
    for (const i of plan.keep) console.log(`  ${yellow(i.kind.padEnd(8))} ${clip(i.target, 90)}\n           ${dim(i.reason)}`);
  }
}

async function cmdClean(a: Args) {
  const client = await getClient(a);
  const projectId = a.flags.all ? undefined : (await currentProject(client).catch(() => null))?.id;
  const plan = (await client['clean.plan']({ projectId })) as CleanPlan;
  if (!a.flags.yes) {
    printPlan(plan, false);
    if (plan.remove.length) console.log(dim('\nRun "ym clean --yes" to do it.'));
    return;
  }
  const res = (await client['clean.run']({ projectId })) as { removed: CleanPlan['remove']; failed: { item: { target: string }; error: string }[] };
  printPlan({ remove: res.removed, keep: plan.keep }, true);
  for (const f of res.failed) console.log(yellow(`  kept ${f.item.target}: ${f.error}`));
}

async function cmdHub(a: Args) {
  const sub = a._[1] ?? 'status';
  const extra: string[] = [];
  if (flag(a, 'host')) extra.push('--host', flag(a, 'host')!);
  if (flag(a, 'port')) extra.push('--port', flag(a, 'port')!);
  if (sub === 'run') {
    const hub = new Hub({ host: flag(a, 'host'), port: flag(a, 'port') ? Number(flag(a, 'port')) : undefined });
    const url = await hub.start();
    writeHubInfo(url);
    console.log(`Yardmaster hub ${VERSION} on ${url} (machine ${hub.machineId})`);
    const shutdown = async () => {
      await hub.stop();
      clearHubInfo();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return;
  }
  if (sub === 'start') {
    const url = await startHubInBackground(extra);
    return console.log(green(`✔ Hub running at ${url}`) + dim(`  (logs: ${paths.hubLog()})`));
  }
  if (sub === 'stop' || sub === 'restart') {
    const info = readHubInfo();
    if (info && isAlive(info.pid)) {
      process.kill(info.pid, 'SIGTERM');
      for (let i = 0; i < 100 && isAlive(info.pid); i++) await new Promise((r) => setTimeout(r, 200));
      console.log(green('✔ Hub stopped. Running agents were paused and will resume from their worktrees.'));
    } else console.log(dim('Hub was not running.'));
    clearHubInfo();
    if (sub === 'restart') console.log(green(`✔ Hub running at ${await startHubInBackground(extra)}`));
    return;
  }
  const url = await runningHubUrl();
  console.log(url ? green(`● Hub running at ${url}`) : yellow('○ Hub not running. Start it with: ym hub start'));
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const ad of addrs ?? []) if (ad.family === 'IPv4' && !ad.internal) out.push(`${ad.address}${/^(utun|tailscale)/.test(name) || ad.address.startsWith('100.') ? ' (tailscale)' : ''}`);
  }
  return out;
}

async function cmdToken() {
  const token = hubToken();
  const info = readHubInfo();
  console.log(`${bold('Hub token')} (keep it secret): ${token}\n`);
  console.log('To add another machine:');
  console.log(`  1. On this machine, let the hub accept network connections:  ${cyan('ym hub restart --host 0.0.0.0')}`);
  console.log(`     ${dim('Prefer a private network such as Tailscale over exposing it on public Wi-Fi.')}`);
  console.log('  2. On the other machine, inside its clone of the repo:');
  for (const ip of lanAddresses().slice(0, 3)) console.log(`     ${cyan(`ym worker --hub http://${ip.split(' ')[0]}:${info ? new URL(info.url).port : 7777} --token ${token}`)} ${dim(ip.includes('tailscale') ? 'tailscale' : '')}`);
}

async function cmdWorker(a: Args) {
  const hub = flag(a, 'hub') ?? process.env.YARDMASTER_HUB ?? die('Pass --hub http://<hub-machine>:7777');
  const token = flag(a, 'token') ?? process.env.YARDMASTER_TOKEN ?? die('Pass --token (run "ym token" on the hub machine).');
  if (!(await hubAlive(hub))) die(`Can't reach a Yardmaster hub at ${hub}.`);
  const client = remoteClient(hub, token);
  const repoPaths = list(a, 'repo') ?? [process.cwd()];
  const repos: Record<string, string> = {};
  for (const p of repoPaths) {
    const root = await mainRepoRoot(expandHome(p));
    if (!root) die(`${p} is not a git repository.`);
    const id = await projectIdFor(root);
    await client['project.resolve']({ projectId: id }).catch(() => die(`The hub doesn't manage ${root} yet. Run "ym init" in that repo on the hub machine.`));
    repos[id] = root;
  }
  const loop = new WorkerLoop({
    client, machineId: machineId(), repos: () => repos, agents: () => detectAgents(loadConfig()), localConfig: () => loadConfig(),
    transport: httpTransport(hub, token, machineId()), verifySlots: new Semaphore(loadConfig().verifyParallel),
  });
  await loop.heartbeat();
  console.log(green(`✔ ${hostname()} joined ${hub}`) + dim(` with ${Object.keys(repos).length} repo(s) and agents: ${detectAgents(loadConfig()).join(', ') || 'none'}`));
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
    void loop.heartbeat().then(() => loop.tick()).then(() => (beats % 20 === 0 ? loop.tidyLocal() : undefined)).catch((e: Error) => console.error(dim(`hub unreachable: ${e.message}`)));
  }, 3000);
  const shutdown = async () => {
    clearInterval(timer);
    loop.stopAll('shutdown', 'worker stopping');
    await loop.drain();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdConnect(a: Args) {
  const which_ = a._[1] ?? 'all';
  const agents = which_ === 'all' ? ['claude', 'codex', 'cursor', 'opencode', 'gemini'].filter((x) => x !== 'cursor' || which('cursor-agent') || existsSync(join(process.env.HOME ?? '', '.cursor'))).filter((x) => x !== 'gemini' || which('gemini')).filter((x) => x !== 'opencode' || which('opencode')) : which_.split(',');
  const steps = connectPlan(agents);
  const withHooks = Boolean(a.flags['with-hooks'] || a.flags['with-hook']);
  const hookTargets = (['claude', 'codex'] as const).filter((x) => agents.includes(x) && which(x));
  if (a.flags['dry-run']) {
    for (const s of steps) console.log(s.skipped ? dim(`- ${s.agent}: ${s.skipped}`) : `- ${bold(s.agent)}: ${s.action}\n    ${dim(s.command?.join(' ') ?? '')}`);
    console.log(`- ${bold('skill')}: copy the Yardmaster skill to ~/.claude/skills and ~/.agents/skills`);
    if (withHooks) for (const t of hookTargets) console.log(`- ${bold(`${t} hooks`)}: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse in ${hookPlan(t).file}`);
    return;
  }
  for (const r of await applyConnect(steps)) console.log(r.ok ? green(`✔ ${r.step.agent}: ${r.detail || 'connected'}`) : dim(`- ${r.step.agent}: ${r.detail}`));
  if (!a.flags['no-skill']) console.log(green(`✔ skill installed: ${installSkill().join(', ')}`));
  if (withHooks) {
    for (const t of hookTargets) console.log(green(`✔ ${t} hooks: ${installHooks(t)}`) + (t === 'codex' ? dim('  (approve them once with /hooks in Codex)') : ''));
  } else console.log(dim('Tip: add --with-hooks for automatic file reservations and live board updates with no tool calls.'));
  console.log(dim('\nRestart open agent sessions to load the new tools. T3 Code picks these up through its Claude Code and Codex agents.'));
}

async function cmdMcp(a: Args) {
  // The MCP server needs a hub to run background work; start one quietly if needed.
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  let client: Client;
  if (remote) client = remoteClient(remote, flag(a, 'token') ?? process.env.YARDMASTER_TOKEN ?? hubToken());
  else {
    const url = (await runningHubUrl()) ?? (await startHubInBackground());
    client = remoteClient(url, hubToken());
  }
  await runMcp(client);
}

async function cmdHook(a: Args) {
  const event = a._[1] ?? '';
  if (![...HOOK_EVENTS, 'claude-pretool'].includes(event as never)) die(`Unknown hook "${event}". Events: ${HOOK_EVENTS.join(', ')}`);
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const r = await runHook(event, stdin, async () => {
    const remote = process.env.YARDMASTER_HUB;
    if (remote) return remoteClient(remote, process.env.YARDMASTER_TOKEN ?? hubToken());
    const url = await runningHubUrl();
    return url ? remoteClient(url, hubToken()) : null;
  });
  if (r.stdout) process.stdout.write(r.stdout + '\n');
  if (r.stderr) process.stderr.write(r.stderr + '\n');
  process.exit(r.code);
}

async function cmdLearn(a: Args) {
  const text = a._.slice(1).join(' ').trim();
  if (text.length < 12) die('Write the lesson in a sentence, e.g. ym learn "Run npm run build before the e2e tests" --files "e2e/**"');
  const client = await getClient(a);
  const project = await currentProject(client);
  const l = await client['lesson.add']({ projectId: project.id, text, files: list(a, 'files') ?? [], source: 'you' });
  console.log(l ? green('✔ Saved. Agents working on related files will be briefed with it.') : yellow('Not saved: too short.'));
}

async function cmdLessons(a: Args) {
  const client = await getClient(a);
  const project = await currentProject(client);
  if (a._[1] === 'forget') {
    const id = a._[2] ?? die('ym lessons forget <id>');
    await client['lesson.forget']({ id });
    return console.log(green(`✔ ${id} will no longer be used.`));
  }
  const lessons = await client['lesson.list']({ projectId: project.id, all: Boolean(a.flags.all) });
  if (a.flags.json) return console.log(JSON.stringify(lessons, null, 2));
  if (!lessons.length) return console.log(dim('No lessons yet. They are learned from fixed failures, reviews and your redirects, or add one with ym learn "...".'));
  const label: Record<string, string> = { you: 'you', review: 'review', fix: 'fix', agent: 'agent' };
  for (const l of lessons) {
    const track = l.uses ? dim(` helped ${l.wins}/${l.uses}`) : '';
    console.log(`${bold(l.id)} ${cyan(`[${label[l.source] ?? l.source}]`)}${l.disabled ? red(' retired') : ''}${track}${l.scope.length ? dim(` ${l.scope.join(', ')}`) : ''}\n  ${l.text}`);
  }
}

async function cmdPlugin(a: Args) {
  const sub = a._[1];
  if (sub === 'list') {
    const loaded = await loadPlugins();
    console.log(`Plugins in ${paths.plugins()}:`);
    for (const n of loaded.adapters) console.log(`  ${green('adapter')}  ${n}`);
    for (const n of loaded.notifiers) console.log(`  ${green('notifier')} ${n.name}`);
    for (const e of loaded.errors) console.log(`  ${red('broken')}   ${e.dir}: ${clip(e.error, 120)}`);
    if (!loaded.adapters.length && !loaded.notifiers.length && !loaded.errors.length) console.log(dim('  none yet. Try: ym plugin new my-agent --describe "drive the aider CLI" --with claude'));
    return;
  }
  const name = a._[2] ?? die(`ym plugin ${sub ?? 'new'} <name>`);
  if (sub === 'test') {
    const r = await testPlugin(join(paths.plugins(), name));
    for (const ch of r.checks) console.log(`${ch.ok ? green('✔') : red('✖')} ${ch.name}${ch.detail ? dim(`  ${clip(ch.detail, 160)}`) : ''}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (sub === 'new') {
    const kind = (flag(a, 'kind') ?? 'adapter') as 'adapter' | 'notifier';
    if (kind !== 'adapter' && kind !== 'notifier') die('--kind must be adapter or notifier');
    const describe = flag(a, 'describe');
    const dir = scaffoldPlugin(name, kind, describe);
    console.log(green(`✔ Created ${dir}`));
    const builder = flag(a, 'with');
    if (!builder) return console.log(`Edit ${join(dir, 'index.mjs')} (guide: PLUGIN_GUIDE.md), then run ${cyan(`ym plugin test ${name}`)}.`);
    if (!describe) die('Creator mode needs --describe "what the plugin should do".');
    const config = loadConfig();
    const adapter = getAdapter(builder, config) ?? die(`Unknown agent ${builder}`);
    console.log(dim(`Creator mode: ${adapter.label} is writing the plugin...`));
    const spec = adapter.build({ prompt: creatorPrompt(name, kind, describe), cwd: dir, model: null, settings: { enabled: true, models: {}, maxParallel: 1, extraArgs: [], autonomy: 'workspace' } });
    const child = spawn(spec.command, spec.args, { cwd: dir, stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'inherit'], env: process.env });
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    const rl = createLineReader({ input: child.stdout! });
    rl.on('line', (line) => {
      for (const ev of adapter.parse(line)) if (ev.type === 'tool') console.log(dim(`  · ${ev.name}`));
    });
    await new Promise((r) => child.on('close', r));
    const r = await testPlugin(dir);
    for (const ch of r.checks) console.log(`${ch.ok ? green('✔') : red('✖')} ${ch.name}`);
    console.log(r.ok ? green(`\n✔ Plugin ${name} works. Run "ym hub restart" to load it.`) : yellow(`\nThe plugin needs more work: edit ${dir} or run the command again.`));
    return;
  }
  die('ym plugin new|test|list');
}

async function cmdDoctor() {
  const checks: [string, boolean, string][] = [];
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  checks.push(['Node.js 22.16+', major > 22 || (major === 22 && minor >= 16), process.versions.node]);
  const g = await run('git', ['--version']).catch(() => null);
  checks.push(['git installed', !!g && g.code === 0, g?.stdout.trim() ?? 'missing']);
  const root = await mainRepoRoot(process.cwd()).catch(() => null);
  checks.push(['inside a git repository', !!root, root ?? 'run from your project folder']);
  const config = loadConfig(root ?? undefined);
  const agents = detectAgents(config);
  checks.push(['at least one coding agent', agents.length > 0, agents.join(', ') || 'install Claude Code, Codex, OpenCode, Cursor CLI or Gemini CLI']);
  const url = await runningHubUrl();
  checks.push(['hub running', !!url, url ?? 'ym hub start (starts automatically when needed)']);
  try {
    const fs = statfsSync(yardHome());
    const freeGb = (fs.bavail * fs.bsize) / 1e9;
    checks.push(['disk space for worktrees', freeGb > 5, `${freeGb.toFixed(1)} GB free`]);
  } catch {
    // statfs unsupported
  }
  if (root) checks.push(['checks configured (verify)', config.verify.length > 0, config.verify.join(' && ') || `add "verify" to ${PROJECT_CONFIG_FILE} so finished work is tested`]);
  for (const [name, ok, detail] of checks) console.log(`${ok ? green('✔') : yellow('!')} ${name.padEnd(28)} ${dim(detail)}`);
}

function cmdPresets() {
  console.log(bold('Presets') + dim(' (set "preset" in yardmaster.json)'));
  const desc: Record<string, string> = {
    frugal: 'fewest tokens: 2 agents, small models first, tight budgets, escalate only on failure',
    balanced: 'default: 3 agents, model size picked per task, $3/task and $25/day caps',
    fast: 'most parallelism: 6 agents, mid-size models, quick retries',
    careful: 'strong models, strict file scopes, every merge waits for your approval',
  };
  for (const [k, v] of Object.entries(desc)) console.log(`  ${cyan(k.padEnd(9))} ${v}`);
}

async function cmdDashboard(a: Args) {
  const url = (await runningHubUrl()) ?? (await startHubInBackground());
  const full = `${url}/#token=${hubToken()}`;
  console.log(`Dashboard: ${full}`);
  if (a.flags.open !== undefined || process.stdout.isTTY) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    if (which(opener)) spawn(opener, [full], { stdio: 'ignore', detached: true }).unref();
  }
}

/** An isolated sandbox with a fake agent, so anyone can see how Yardmaster behaves without spending tokens. */
async function cmdDemo(a: Args) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'yardmaster-demo-')));
  process.env.YARDMASTER_HOME = join(base, 'home');
  process.env.YARDMASTER_ENABLE_MOCK = '1';
  mkdirSync(process.env.YARDMASTER_HOME, { recursive: true });
  writeFileSync(paths.globalConfig(), JSON.stringify({ notify: false, worktreeRoot: join(base, 'worktrees'), routing: { cheap: ['mock'], standard: ['mock'], strong: ['mock'] }, retry: { backoffSeconds: 2 }, liveOverlapIntervalSeconds: 1, watchdog: { repeatThreshold: 6 }, supervision: { slowProgressMinutes: 0.4, queueStallMinutes: 0.3 } }));
  const repo = join(base, 'shop');
  mkdirSync(repo);
  const g = (args: string[]) => git(repo, args);
  await g(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# Demo shop\n');
  // A plain shell check, so the demo works on machines without Node (the standalone binary's audience).
  writeFileSync(join(repo, 'check.sh'), '#!/bin/sh\nif grep -rl "TODO-BUG" --include="*.js" . 2>/dev/null | grep -v "/.git/"; then echo "bug markers found" >&2; exit 1; fi\necho "checks ok"\n');
  writeFileSync(join(repo, PROJECT_CONFIG_FILE), JSON.stringify({ verify: ['sh check.sh'] }, null, 2));
  await g(['add', '-A']);
  await g(['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init']);
  const port = Number(flag(a, 'port') ?? 7788);
  const hub = new Hub({ host: flag(a, 'host') ?? '127.0.0.1', port, includeMock: true, tickMs: 700 });
  const url = await hub.start();
  const project = await hub.coord.registerProject(repo);
  const slow = (ms: number) => `@mock sleep ${ms}`;
  hub.coord.addTasks(project.id, [
    { key: 'cart', title: 'Build the shopping cart module', prompt: `@mock write src/cart/cart.js export const cart = []\n${slow(9000)}\n@mock write src/cart/total.js export const total = 0\n${slow(4000)}`, files: ['src/cart/**'], agent: 'mock' },
    { key: 'search', title: 'Add product search', prompt: `${slow(4000)}\n@mock write src/search/index.js export const search = () => []\n${slow(8000)}`, files: ['src/search/**'], agent: 'mock' },
    { key: 'cart-tests', title: 'Add discount codes to the cart', prompt: `@mock write src/cart/discount.js export const discount = 0\n${slow(3000)}`, files: ['src/cart/**'], agent: 'mock' },
    { key: 'checkout', title: 'Checkout page that uses cart and search', prompt: `@mock write src/checkout.js import './cart/cart.js'\n${slow(5000)}`, files: ['src/checkout.js'], after: ['cart', 'search'], agent: 'mock' },
    { title: 'Fix the README wording', prompt: `${slow(2000)}\n@mock attempt 1 write src/readme-helper.js TODO-BUG\n@mock attempt 2 write src/readme-helper.js export const ok = true\n${slow(3000)}`, tier: 'cheap', agent: 'mock' },
    { title: 'Investigate flaky config loader', prompt: '@mock loop', agent: 'mock' },
    { title: 'Profile the slow product listing', prompt: `@mock cost 0.4\n@mock unless-prompt FOCUS sleep 240000\n@mock write src/listing.js export const pageSize = 24`, agent: 'mock', allowNoChanges: true },
  ], 'demo');
  writeHubInfo(url);
  console.log(`${bold('Yardmaster demo')} running with a fake agent (no tokens spent).\n  Dashboard: ${cyan(`${url}/#token=${hub.token}`)}\n  Repo:      ${repo}\n  Press Ctrl+C to stop.`);
  const stop = () => void hub.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  if (process.argv[2] === '__mock-agent') return runMockAgent();
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.flags.version && !cmd) return console.log(VERSION);
  if (!cmd || a.flags.help || cmd === 'help') return console.log(HELP);
  if (a.flags.repo && typeof a.flags.repo === 'string' && cmd !== 'worker') process.chdir(expandHome(a.flags.repo));
  switch (cmd) {
    case 'init': return cmdInit(a);
    case 'add': return cmdAdd(a);
    case 'plan': return cmdPlan(a);
    case 'status': case 'ls': return cmdStatus(a);
    case 'show': return cmdShow(a);
    case 'logs': return cmdLogs(a);
    case 'retry': case 'cancel': case 'stop': case 'approve': return cmdControl(a, cmd);
    case 'land': return cmdLand(a);
    case 'pause': return cmdPause(a, true);
    case 'resume': return cmdPause(a, false);
    case 'tell': return cmdTell(a);
    case 'learn': return cmdLearn(a);
    case 'lessons': return cmdLessons(a);
    case 'disk': return cmdDisk(a);
    case 'service': return cmdService(a);
    case 'clean': return cmdClean(a);
    case 'hub': return cmdHub(a);
    case 'up': return cmdHub({ ...a, _: ['hub', 'start'] });
    case 'token': return cmdToken();
    case 'worker': return cmdWorker(a);
    case 'connect': return cmdConnect(a);
    case 'mcp': return cmdMcp(a);
    case 'hook': return cmdHook(a);
    case 'plugin': return cmdPlugin(a);
    case 'doctor': return cmdDoctor();
    case 'presets': return cmdPresets();
    case 'dashboard': return cmdDashboard(a);
    case 'demo': return cmdDemo(a);
    case 'version': case '--version': return console.log(VERSION);
    default: die(`Unknown command "${cmd}". Run "ym help".`);
  }
}

main().catch((err: Error) => die(err.message));
