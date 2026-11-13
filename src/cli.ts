#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createInterface as createLineReader } from 'node:readline';
import { homedir as homedirPath, hostname, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildMethods, localClient, remoteClient, type Client } from './api.ts';
import { Coordinator } from './coordinator.ts';
import { openDb } from './db.ts';
import { expandHome, hubToken, machineId, paths, yardHome } from './paths.ts';
import { configWarnings, loadConfig, PRESETS, PROJECT_CONFIG_FILE, writeProjectConfig, type Tier } from './config.ts';
import { detectAgents, getAdapter } from './adapters/index.ts';
import { clearHubInfo, Hub, readHubInfo, writeHubInfo } from './hub.ts';
import { planCleanup, runCleanup, type CleanPlan } from './janitor.ts';
import { currentBranch, mainRepoRoot, repoRoot, projectIdFor, git, revParse } from './git.ts';
import { isAlive, run, which } from './proc.ts';
import { ago, clip, formatUsd } from './text.ts';
import { STATUS_LABEL, type Task } from './types.ts';
import { WorkerLoop } from './worker.ts';
import { connectWorker, fleetClient, joinFleet, normalizeHubUrl, workerCredentialDirectory } from './fleet-client.ts';
import { resolveEffort, describeEffort } from './effort.ts';
import { Semaphore } from './runner.ts';
import { httpTransport } from './transport.ts';
import { applyConnect, connectPlan, hookPlan, installHooks, installSkill, selfCommand } from './connect.ts';
import { HOOK_EVENTS, runHook } from './hook.ts';
import { hookClient } from './hookclient.ts';
import { creatorPrompt, loadPlugins, scaffoldPlugin, testPlugin } from './plugins.ts';
import { PlanError, planGoal } from './planner.ts';
import { VERSION } from './version.ts';
import { serviceFiles, installService, uninstallService } from './service.ts';
import { inSea } from './assets.ts';
import { runMockAgent } from './mockagent.ts';
import { TIERS, agentSettings, defaultAgentSettings, verifySlotsFor } from './config.ts';
import { detectVerify } from './detect.ts';
import { dedupeGroup, defaultScanRoots, purgeDedupeTrash, restoreLatest, scanDeps } from './devdeps.ts';

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
const BOOLEAN_FLAGS = new Set(['confirm-stopped', 'remote', 'adopt-legacy-journal', 'scan', 'dedupe', 'restore', 'purge', 'with-hooks', 'no-hooks', 'experimental', 'no-skill', 'now', 'version', 'follow', 'yes', 'json', 'help', 'all', 'dry-run', 'foreground', 'force', 'no-changes-ok', 'watch', 'with-hook', 'no-hub', 'open', 'draft', 'quiet', 'hooks-path']);

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
  ym setup [--agent codex]     guided repo setup; --dry-run previews without changing configs
  ym init                      set up this repo (detects your agents and test command)
  ym verify [--json]            run committed-artifact checks and configured service verification; save receipts
  ym connect [agent|all]       add Yardmaster tools + skill to Claude Code, Codex, Cursor, OpenCode, Gemini
                               (also installs zero-token hooks for Claude Code and Codex; --no-hooks to skip)
  ym add "what you want"       queue work (--files, --after, --agent, --tier cheap|standard|strong)
  ym plan "a bigger goal"      let an agent split a goal into parallel tasks (--yes to queue them)
  ym status                    what's happening (--watch, --all, --json)
  ym dashboard                 open the live dashboard

${bold('Manage work')}
  ym show <id>   ym logs <id> [-f]   ym retry|cancel|stop|approve <id>
  ym tell <id> "do X instead"  redirect a running agent (it keeps its work so far)
  ym recover                   replay saved planning usage before releasing budget
  ym recover --confirm-stopped <id> --note "exit verified"  attest a PID-less spawn hold stopped
  ym recover --confirm-stopped <task> --remote --note "exit verified"  attest a lost worker stopped
  ym integration adopt <project> --head <SHA> --note "inspected"  check and keep interrupted merge work
  ym pause [--now] [--all]     stop new work from starting (--now parks coding; checks/review finish)
  ym resume                    start queued work again
  ym disk                      what uses disk space and what can be freed (--scan: duplicate dependencies anywhere)
  ym report [--days 7]         spend per merged task, waste, retries, and where the time goes
  ym learn "..." [--files g]   teach every future agent something about this repo
  ym lessons [--all]           what agents have learned here (forget <id> to retire one)
  ym land                      bring finished work into your branch (fast-forward only)
  ym clean [--yes]             remove finished worktrees/branches/locks; never unmerged work

${bold('CI costs')} (GitHub Actions)
  ym ci audit [owner/repo]     where your Actions minutes went and what to fix (--owner, --days)
  ym ci init                   push gate: checks before push, once per file tree; prints the workflow guard
  ym ci budget | status | ship push finished agent work as one PR (ym ci help for all)

${bold('Machines')}
  ym hub start|stop|status|run [--host 0.0.0.0] [--port 7777]
  ym service install|uninstall keep the hub running across crashes and reboots
  ym pair invite --project ID  create a one-use, expiring worker invitation (owner only)
  ym pair list                 list paired device/invitation metadata (owner only)
  ym pair revoke ID [--invitation]  revoke a worker credential or unused invitation
  ym pair join CODE --hub URL  save a project-scoped credential on this machine
  ym worker --hub URL [--repo path]  use the saved credential for this repo
  ym token                     explicitly display the privileged owner secret; never share it
                               Non-loopback HTTP needs --private-network (encrypted overlay).
                               HTTPS or loopback is the default; no network setup is performed.

${bold('Extend')}
  ym plugin new <name> [--kind adapter|notifier|provider] [--describe "..."] [--with claude]
  ym plugin test <name>   ym plugin list   ym presets   ym doctor   ym demo
  ym providers list [--json]              configured service providers and routing
  ym providers plan <capability> [--input file.json] [--json]  explain selection without dispatch
  ym providers run <capability> [--input file.json] [--json]  explicitly execute once
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
  const client = await getClient(a);
  const project = await currentProject(client, root);
  console.log(dim(`Asking ${getAdapter(agent, config)?.label ?? agent} to plan (read-only; admission and reactive budget limits apply)...`));
  const { planGoalManaged } = await import('./planner.ts');
  const plan = await planGoalManaged(goal, { hub: (flag(a, 'hub') ?? process.env.YARDMASTER_HUB) || `local:${resolve(paths.db())}`, cwd: root, agent, config, client, projectId: project.id, machineId: machineId() });
  const { tasks, costUsd } = plan;
  console.log(bold(`\nPlan (${tasks.length} tasks, planning cost ${formatUsd(costUsd)}):`));
  for (const t of tasks) console.log(`  ${cyan(t.key ?? '-')} ${t.title} ${dim(`[${t.tier ?? 'auto'}${t.files?.length ? `; ${t.files.join(', ')}` : ''}${t.after?.length ? `; after ${t.after.join(', ')}` : ''}]`)}`);
  let go = Boolean(a.flags.yes);
  if (!go && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    go = /^y/i.test(await rl.question('\nQueue these tasks? [y/N] '));
    rl.close();
  }
  if (!go) return console.log(dim('Nothing queued. Re-run with --yes to queue.'));
  const hubClient = await getClient(a, { needHub: true });
  const target = await currentProject(hubClient, root);
  const res = await hubClient['task.add']({ projectId: target.id, tasks, createdBy: `plan:${agent}` });
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

async function cmdRecover(a: Args) {
  const client = await getClient(a);
  const { recoverPlanningReceipts } = await import('./planning-journal.ts');
  const receipts = await recoverPlanningReceipts(client, { hub: (flag(a, 'hub') ?? process.env.YARDMASTER_HUB) || `local:${resolve(paths.db())}`, machineId: machineId() });
  if (!a._[1] && a.flags['confirm-stopped'] !== true) {
    if (a.flags.json) return console.log(JSON.stringify(receipts));
    console.log(green(`Planning receipts recovered: ${receipts.replayed.length}.`));
    for (const item of receipts.pending) console.log(yellow(`${item.runId}: ${item.reason}`));
    if (receipts.skippedLive.length) console.log(dim(`Kept ${receipts.skippedLive.length} live or unverified invocation receipt(s).`));
    return;
  }
  if (a.flags['confirm-stopped'] !== true) die('Use ym recover --confirm-stopped <task> --note "how you verified process exit".');
  const id = a._[1] ?? die('Pass the task id shown by the process-recovery warning.');
  const note = flag(a, 'note');
  if (!note || note.trim().length < 12) die('Pass --note with how you confirmed every process has stopped (at least 12 characters).');
  if (receipts.replayed.includes(id)) return console.log(green(`✔ ${id}: final planning usage replayed and exit acknowledged.`));
  if (id.startsWith('r-')) await client['plan.confirmStopped']({ runId: id, by: 'you', note });
  else if (id.startsWith('p-')) await client['integration.confirmStopped']({ projectId: id, by: 'you', note });
  else await client['task.control']({ id, action: 'confirm-stopped', by: 'you', note, remote: a.flags.remote === true });
  console.log(green(`✔ ${id}: owner exit attestation recorded. Work is preserved.${id.startsWith('t-') ? ` Retry with ym retry ${id}.` : ''}`));
}

async function cmdIntegration(a: Args) {
  if (a._[1] !== 'adopt') die('Use ym integration adopt <project> --head <inspected SHA> --note "what you verified".');
  const projectId = a._[2] ?? die('Pass the project id shown by the integration warning.');
  const head = flag(a, 'head'); const note = flag(a, 'note');
  if (!head || !/^[a-f0-9]{40,64}$/.test(head) || !note || note.trim().length < 12) die('Pass --head with the exact inspected SHA and --note with at least 12 characters.');
  const client = await getClient(a);
  await client['integration.adopt']({ projectId, head, by: 'you', note });
  console.log(green('✔ Inspected integration commit checked and preserved. Pending artifacts return to verification and integration.'));
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
    console.log(green(`✔ Paused ${projectId ? 'this project' : 'everything'}.`) + (a.flags.now ? ' Coding stop requested; reported state confirms exit. Checks and reviews already running can finish.' : ' Running agents finish their current task; nothing new starts.'));
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

const fmtBytes = (b: number) => (b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1)} GB`);

/** Duplicate dependency installs anywhere on this machine (no hub needed), and recoverable sharing of them. */
async function cmdDiskDeps(a: Args): Promise<boolean> {
  if (a.flags.restore) {
    const r = restoreLatest();
    if (!r.restored.length && !r.skipped.length) console.log('Nothing to restore.');
    for (const p of r.restored) console.log(green(`✔ restored ${p}`));
    for (const s of r.skipped) console.log(yellow(`  kept ${s.path}: ${s.why}`));
    return true;
  }
  if (a.flags.purge) {
    const n = purgeDedupeTrash();
    console.log(n ? green(`✔ Deleting ${n} kept batch(es) of originals in the background; the space comes back as it goes.`) : 'The dedupe trash is empty.');
    return true;
  }
  if (!a.flags.scan && !a.flags.dedupe) return false;
  // Originals kept for undo are deleted for good after 3 days.
  purgeDedupeTrash(3 * 86_400_000);
  const roots = a._.slice(1).length ? a._.slice(1).map((p) => expandHome(p)) : defaultScanRoots();
  if (!roots.length) die('No project folders found. Pass the folders to scan: ym disk --scan ~/code');
  const progress = process.stderr.isTTY ? (d: number, t: number) => process.stderr.write(`\r  measuring ${d}/${t} dependency folders`.padEnd(50)) : undefined;
  const r = await scanDeps(roots, { onProgress: progress });
  if (progress) process.stderr.write('\r'.padEnd(52) + '\r');
  if (a.flags.json && !a.flags.dedupe) return (console.log(JSON.stringify(r, null, 2)), true);
  const reclaim = r.identical.reduce((n, g) => n + g.reclaimable, 0);
  console.log(`${bold(`${r.dirs.length} node_modules folders`)} in ${roots.map((x) => x.replace(homedirPath(), '~')).join(', ')}: ${bold(fmtBytes(r.total))}`);
  if (r.identical.length) {
    console.log(`\n${bold('Identical installs')} (same lockfile and same installed packages) ${green(`${fmtBytes(reclaim)} reclaimable`)}`);
    for (const g of r.identical.slice(0, 10)) console.log(`  ${String(g.dirs.length).padStart(2)} copies  ${fmtBytes(g.reclaimable).padStart(8)}  ${dim(g.dirs.slice(0, 3).map((d) => d.project.replace(homedirPath(), '~')).join(', '))}${g.dirs.length > 3 ? dim(', ...') : ''}`);
  }
  if (r.sameLock.length) {
    const n = r.sameLock.reduce((x, g) => x + g.dirs.length, 0);
    console.log(dim(`\n${n} more folders share a lockfile but were installed differently, so they can't be shared as they are (a fresh "npm ci" in each would make them identical).`));
  }
  console.log(dim('Sizes count every copy in full; copies that are already clones of each other take less real space.'));
  if (!a.flags.dedupe) {
    if (reclaim > 0) console.log(`\nShare them (experimental): ${cyan('ym disk --dedupe')} shows what would change; add ${cyan('--experimental --yes')} to do it. Originals are kept for undo until ${cyan('ym disk --purge')} or 3 days.`);
    return true;
  }
  // It replaces dependency folders across projects (other tools' worktrees included), so it stays opt-in for now.
  if (a.flags.yes && !a.flags.experimental) die('Sharing installs is experimental: it replaces node_modules folders across your projects. Review the dry run, then add --experimental --yes. Undo with ym disk --restore.');
  const apply = !!a.flags.yes;
  let freed = 0;
  for (const g of r.identical) {
    const out = await dedupeGroup(g, { dryRun: !apply });
    for (const e of out.replaced) {
      freed += g.dirs.find((d) => d.path === e.path)?.bytes ?? 0;
      console.log(`${apply ? green('✔ shared') : '  would share'} ${e.path.replace(homedirPath(), '~')} ${dim(`with ${e.from.replace(homedirPath(), '~')}`)}`);
    }
    for (const s of out.skipped) console.log(yellow(`  left ${s.path.replace(homedirPath(), '~')}: ${s.why}`));
  }
  if (!apply) console.log(`\nAbout ${bold(fmtBytes(freed))} would come back. Close dev servers in those projects, then run ${cyan('ym disk --dedupe --yes')}.`);
  else console.log(`\n${green(`✔ About ${fmtBytes(freed)} will come back`)} once the kept originals are purged (${cyan('ym disk --purge')}, or automatically after 3 days). Undo: ${cyan('ym disk --restore')}.`);
  return true;
}

async function cmdDisk(a: Args) {
  if (await cmdDiskDeps(a)) return;
  const client = await getClient(a);
  const projectId = a.flags.all ? null : (await currentProject(client).catch(() => null))?.id ?? null;
  const r = await client['disk.report']({ projectId });
  if (a.flags.json) return console.log(JSON.stringify(r, null, 2));
  const fmt = fmtBytes;
  const low = r.freeGb < r.minFreeGb;
  console.log(`${bold('Disk')}  ${low ? red(`${r.freeGb.toFixed(1)} GB free`) : green(`${r.freeGb.toFixed(1)} GB free`)} ${dim(`(new work pauses below ${r.minFreeGb} GB)`)}`);
  console.log(`Worktrees use ${bold(fmt(r.worktreesBytes))}${r.quotaGb ? dim(` of a ${r.quotaGb} GB quota`) : ''}, logs ${fmt(r.logsBytes)}.`);
  if (r.worktrees.length) {
    console.log(bold('\nLargest worktrees'));
    for (const w of r.worktrees.slice(0, 12)) console.log(`  ${fmt(w.bytes).padStart(8)}  ${(STATUS_COLOR[w.status] ?? dim)((STATUS_LABEL[w.status as keyof typeof STATUS_LABEL] ?? w.status).padEnd(14))} ${w.taskId} ${dim(clip(w.title ?? '', 50))}`);
  }
  console.log(r.reclaimableBytes > 0 ? `\n${green(fmt(r.reclaimableBytes))} can be freed safely: run ${cyan('ym clean --yes')}.` : dim('\nNothing more can be freed without touching unmerged work.'));
}

async function cmdReport(a: Args) {
  const client = await getClient(a);
  const projectId = a.flags.all ? null : (await currentProject(client).catch(() => null))?.id ?? null;
  const days = Number(flag(a, 'days') ?? 7);
  const r = await client['report.summary']({ projectId, days });
  if (a.flags.json) return console.log(JSON.stringify(r, null, 2));
  const usd = (n: number | null) => (n === null ? 'n/a' : formatUsd(n));
  const secs = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : n < 90 ? `${Math.round(n)}s` : `${(n / 60).toFixed(1)} min`);
  console.log(bold(`Last ${days} day${days === 1 ? '' : 's'}${projectId ? '' : ', all projects'}`));
  console.log(`  Tasks: ${green(`${r.tasks.done} merged`)}, ${r.tasks.open} open, ${r.tasks.needsYou ? yellow(`${r.tasks.needsYou} need you`) : '0 need you'}, ${r.tasks.failed} failed, ${r.tasks.canceled} canceled`);
  console.log(`  Spend: ${bold(usd(r.spend.total))}${r.spend.estimated ? dim(' (partly estimated)') : ''}  (agents ${usd(r.spend.implement)}, reviews ${usd(r.spend.review)}${r.spend.plan ? `, planning ${usd(r.spend.plan)}` : ''})`);
  console.log(`  Per merged task: ${bold(usd(r.perMergedTask))}   Wasted on work that never merged: ${r.wasted > 0 ? yellow(usd(r.wasted)) : usd(0)}`);
  if (r.retries.runs) {
    const saved = r.retries.avgFresh && r.retries.avgResumed !== null ? dim(` (a resumed retry cost ${usd(r.retries.avgResumed)} on average vs ${usd(r.retries.avgFresh)} fresh)`) : '';
    console.log(`  Retries: ${r.retries.runs}, of which ${r.retries.resumed} continued the earlier session${saved}`);
  }
  const ph = r.phases;
  if (Object.keys(ph).length) console.log(`  Typical attempt: prepare ${secs(ph.prepare)}, agent ${secs(ph.agent)}, checks ${secs(ph.verify)}${ph.review !== undefined ? `, review ${secs(ph.review)}` : ''}, other ${secs(ph.collect)}`);
  console.log(`  Waits: ${secs(r.waits.toStart)} from added to started, ${secs(r.waits.toMerge)} from checks passing to merged`);
  if (r.byAgent.length) {
    console.log('  By agent:');
    for (const x of r.byAgent.slice(0, 8)) console.log(`    ${`${x.agent}${x.model ? ` (${x.model})` : ''}`.padEnd(28)} ${String(x.runs).padStart(4)} runs  ${usd(x.cost).padStart(8)}  ${dim(`${x.runs ? Math.round((x.success / x.runs) * 100) : 0}% succeeded`)}`);
  }
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
  console.log(`${bold('Privileged owner token')} (full hub administration; keep private): ${hubToken()}`);
  console.log('For another worker machine, use ym pair invite --project ID, then ym pair join CODE --hub URL there.');
  console.log('Use HTTPS or an existing encrypted private overlay. Never put this owner token in a URL or share it as a worker invitation.');
}

async function cmdPair(a: Args) {
  const sub = a._[1];
  const privateNetwork = a.flags['private-network'] === true || flag(a, 'private-network') === 'true';
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  if (sub === 'join') {
    const hub = remote ?? die('ym pair join CODE --hub https://hub-host:7777');
    // Validate before reading or creating any local identity files.
    normalizeHubUrl(hub, { privateNetwork });
    workerCredentialDirectory();
    const result = await joinFleet({ hub, code: a._[2] ?? flag(a, 'code') ?? '', machineId: machineId(), projectId: flag(a, 'project'), privateNetwork });
    console.log(green(`✔ Paired ${hostname()} for project ${result.identity.projectId}. Credential saved privately; expires ${new Date(result.identity.expiresAt).toISOString()}.`));
    console.log(`Run ym worker --hub ${normalizeHubUrl(hub, { privateNetwork })}${privateNetwork ? ' --private-network' : ''} --repo /path/to/this/project`);
    return;
  }
  if (!['invite', 'list', 'revoke'].includes(sub ?? '')) die('ym pair invite --project ID [--ttl-ms N] [--credential-ttl-ms N] | list | revoke ID [--invitation] | join CODE --hub URL [--private-network]');
  let client: Client;
  if (remote) {
    const hub = normalizeHubUrl(remote, { privateNetwork });
    const explicit = flag(a, 'token') ?? process.env.YARDMASTER_TOKEN;
    const local = readHubInfo();
    const localUrl = local ? normalizeHubUrl(local.url, { privateNetwork }) : null;
    const token = explicit ?? (hub === localUrl ? hubToken() : die('Remote owner operations require an explicit owner credential. Prefer running ym pair invite/list/revoke on the owner hub machine.'));
    client = fleetClient(hub, token, { privateNetwork });
  } else client = await getClient(a);
  const identity = await client['fleet.identity']({});
  if (identity.kind !== 'owner') die('Pair invitations, device lists and revocation require owner access. Run this on the owner hub.');
  if (sub === 'invite') {
    const projectId = flag(a, 'project') ?? (await currentProject(client)).id;
    const ttl = (name: string) => {
      const value = flag(a, name);
      if (a.flags[name] !== undefined && (!value || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) die(`--${name} requires a positive integer in milliseconds.`);
      return value ? Number(value) : undefined;
    };
    const result = await client['fleet.invite']({ projectId, ttlMs: ttl('ttl-ms'), credentialTtlMs: ttl('credential-ttl-ms') });
    if (a.flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`One-use pairing code: ${result.code}`);
    console.log(`Invitation ${result.invitation.id}, project ${result.invitation.projectId}, expires ${new Date(result.invitation.expiresAt).toISOString()}.`);
    console.log('On the worker: ym pair join CODE --hub https://hub-host:7777 (then run ym worker there).');
    console.log('Only give this short-lived code to the intended worker. Do not share the owner token.');
  } else if (sub === 'list') {
    const devices = await client['fleet.devices']({});
    if (a.flags.json) return console.log(JSON.stringify(devices, null, 2));
    for (const device of devices.credentials) console.log(`${device.id}  machine ${device.machineId}  project ${device.projectId}  ${device.revokedAt !== null ? 'revoked' : device.expiresAt <= Date.now() ? 'expired' : 'active'}  expires ${new Date(device.expiresAt).toISOString()}`);
    for (const invitation of devices.invitations) console.log(`${invitation.id}  invitation for ${invitation.projectId}  ${invitation.revokedAt !== null ? 'revoked' : invitation.redeemedAt !== null ? 'used' : invitation.expiresAt <= Date.now() ? 'expired' : 'unused'}  expires ${new Date(invitation.expiresAt).toISOString()}`);
    if (!devices.credentials.length && !devices.invitations.length) console.log('No paired devices or invitations. Run ym pair invite --project ID.');
  } else {
    const id = a._[2] ?? die('ym pair revoke ID [--invitation]');
    const changed = await client['fleet.revoke']({ id, invitation: a.flags.invitation === true || flag(a, 'invitation') === 'true' });
    console.log(changed ? `Revoked ${id}. Subsequent authenticated requests will be refused.` : `No active matching credential/invitation ${id}.`);
  }
}

async function cmdSetup(a: Args) {
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  if (remote) {
    const hub = normalizeHubUrl(remote, { privateNetwork: a.flags['private-network'] === true || flag(a, 'private-network') === 'true' });
    if (!flag(a, 'token') && !process.env.YARDMASTER_TOKEN) die('Run setup on the owner hub machine, or supply an explicit owner credential for remote setup.');
    a = { ...a, flags: { ...a.flags, hub } };
  }
  const choices = ['claude', 'codex', 'cursor', 'opencode', 'gemini', 'all', 'none'];
  let selected = flag(a, 'agent');
  if (a.flags.agent !== undefined && (!selected || !choices.includes(selected))) die(`--agent must be one of ${choices.join(', ')}.`);
  const root = await mainRepoRoot(process.cwd());
  if (!root) die('Run setup inside a git repository with a first commit.');
  if (a.flags['dry-run']) console.log(`Setup plan for ${root}: ym init (register repo; create ${PROJECT_CONFIG_FILE} only when absent).`);
  else await cmdInit(a);
  console.log('Keep using your editor/native agent. Choose which client receives Yardmaster MCP tools, skill and optional hooks.');
  if (!selected && process.stdin.isTTY && process.stdout.isTTY && !a.flags['dry-run']) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { selected = (await rl.question(`Connect which agent? ${choices.join(' / ')} [none]: `)).trim() || 'none'; }
    finally { rl.close(); }
    if (!choices.includes(selected)) die('Unknown agent. Run ym setup --agent codex, or ym connect AGENT --dry-run.');
  }
  if (selected && selected !== 'none') {
    await cmdConnect({ ...a, _: ['connect', selected] });
  } else {
    console.log('No native client settings changed. Preview: ym connect codex --dry-run (or claude, cursor, opencode, gemini).');
    console.log('Connect your chosen client explicitly: ym connect codex. Use --no-hooks to skip native hooks.');
  }
  console.log('Open the local owner dashboard: ym dashboard. Diagnose checks and connected-client coverage: ym doctor.');
  console.log('For another machine: configure HTTPS or an encrypted private overlay, then ym pair invite --project ID. See docs/FLEET.md.');
}

async function cmdWorker(a: Args) {
  const inputHub = flag(a, 'hub') ?? process.env.YARDMASTER_HUB ?? die('Pass --hub https://hub-host:7777 (pair this machine first).');
  const privateNetwork = a.flags['private-network'] === true || flag(a, 'private-network') === 'true';
  normalizeHubUrl(inputHub, { privateNetwork });
  const repoPaths = list(a, 'repo') ?? [process.cwd()];
  const repos: Record<string, string> = {};
  for (const p of repoPaths) {
    const root = await mainRepoRoot(expandHome(p));
    if (!root) die(`${p} is not a git repository.`);
    repos[await projectIdFor(root)] = root;
  }
  if (!flag(a, 'token') && !process.env.YARDMASTER_TOKEN) workerCredentialDirectory();
  const id = machineId();
  const { hub, token, client, identity } = await connectWorker({ hub: inputHub, token: flag(a, 'token') ?? process.env.YARDMASTER_TOKEN, machineId: id, projectIds: Object.keys(repos), privateNetwork });
  if (identity.kind === 'owner') console.log(yellow('Privileged legacy owner channel: this explicit token grants full hub administration. Prefer ym pair invite/join for workers.'));
  for (const projectId of Object.keys(repos)) {
    if (identity.kind === 'worker') await client['task.list']({ projectId });
    else await client['project.resolve']({ projectId });
  }
  if (a.flags['adopt-legacy-journal'] && identity.kind !== 'owner') die('Legacy adoption requires an explicit owner channel and all affected repos; scoped credentials remain restricted.');
  const loop = new WorkerLoop({
    hub, adoptLegacyJournal: Boolean(a.flags['adopt-legacy-journal']), client, machineId: id, repos: () => repos, agents: () => detectAgents(loadConfig()), localConfig: () => loadConfig(),
    transport: httpTransport(hub, token, id), verifySlots: new Semaphore(verifySlotsFor(loadConfig())),
  });
  await loop.heartbeat();
  console.log(green(`✔ ${hostname()} joined ${hub}`) + dim(` with ${Object.keys(repos).length} repo(s) and agents: ${detectAgents(loadConfig()).join(', ') || 'none'}`));
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
    void loop.heartbeat().then(() => loop.tick()).then(() => (beats % 20 === 0 ? loop.tidyLocal() : undefined)).catch((e: Error) => console.error(dim(`hub request failed: ${e.message}`)));
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
  // Hooks are the zero-token part (file reservations, the edit guard, a session briefing): on unless asked not to.
  const withHooks = !a.flags['no-hooks'];
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
  } else console.log(dim('Hooks skipped (--no-hooks). Without them agents reserve files and see the board only through tool calls.'));
  console.log(dim('\nRestart open agent sessions to load the new tools. T3 Code picks these up through its Claude Code and Codex agents.'));
}

async function cmdMcp(a: Args) {
  // The MCP server needs a hub to run background work; start one quietly if needed.
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  let client: Client;
  if (remote) client = remoteClient(remote, flag(a, 'token') ?? process.env.YARDMASTER_TOKEN ?? hubToken());
  else {
    // Inside a background task the hub is whoever launched it; never start a stray one (on a remote worker there is
    // no local hub, and the agent's tools then just say so).
    if (process.env.YARDMASTER_TASK_ID && !(await runningHubUrl())) die('No Yardmaster hub on this machine for this background task.');
    const url = (await runningHubUrl()) ?? (await startHubInBackground());
    client = remoteClient(url, hubToken());
  }
  // Loaded only for this command: the MCP SDK is the slowest import, and every other command skips it.
  const { runMcp } = await import('./mcp.ts');
  await runMcp(client);
}

async function cmdHook(a: Args) {
  const event = a._[1] ?? '';
  if (![...HOOK_EVENTS, 'claude-pretool'].includes(event as never)) die(`Unknown hook "${event}". Events: ${HOOK_EVENTS.join(', ')}`);
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  // The same fast path as the npm build's hook entry (the standalone binary comes through here): no health check
  // round trip, and a short timeout so a stuck hub never holds up the agent.
  const r = await runHook(event, stdin, async () => hookClient());
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
    for (const p of loaded.providers) console.log(`  ${green('provider')} ${p.name}: ${Object.keys(p.capabilities).join(', ')}`);
    for (const e of loaded.errors) console.log(`  ${red('broken')}   ${e.dir}: ${clip(e.error, 120)}`);
    if (!loaded.adapters.length && !loaded.notifiers.length && !loaded.providers.length && !loaded.errors.length) console.log(dim('  none yet. Try: ym plugin new my-agent --describe "drive the aider CLI" --with claude'));
    return;
  }
  const name = a._[2] ?? die(`ym plugin ${sub ?? 'new'} <name>`);
  if (sub === 'test') {
    const r = await testPlugin(join(paths.plugins(), name));
    for (const ch of r.checks) console.log(`${ch.ok ? green('✔') : red('✖')} ${ch.name}${ch.detail ? dim(`  ${clip(ch.detail, 160)}`) : ''}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (sub === 'new') {
    const kind = (flag(a, 'kind') ?? 'adapter') as 'adapter' | 'notifier' | 'provider';
    if (kind !== 'adapter' && kind !== 'notifier' && kind !== 'provider') die('--kind must be adapter, notifier or provider');
    const describe = flag(a, 'describe');
    const dir = scaffoldPlugin(name, kind, describe);
    console.log(green(`✔ Created ${dir}`));
    const builder = flag(a, 'with');
    if (!builder) return console.log(`Edit ${join(dir, 'index.mjs')} (guide: PLUGIN_GUIDE.md), then run ${cyan(`ym plugin test ${name}`)}.`);
    if (!describe) die('Creator mode needs --describe "what the plugin should do".');
    const config = loadConfig();
    const adapter = getAdapter(builder, config) ?? die(`Unknown agent ${builder}`);
    console.log(dim(`Creator mode: ${adapter.label} is writing the plugin...`));
    const spec = adapter.build({ prompt: creatorPrompt(name, kind, describe), cwd: dir, model: null, settings: defaultAgentSettings({ maxParallel: 1 }) });
    const child = spawn(spec.command, spec.args, { cwd: dir, stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'inherit'], env: process.env });
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    const rl = createLineReader({ input: child.stdout! });
    rl.on('line', (line) => {
      for (const ev of adapter.parse(line)) if (ev.type === 'tool') console.log(dim(`  · ${ev.name}`));
    });
    await new Promise((r) => child.on('close', r));
    const r = await testPlugin(dir);
    for (const ch of r.checks) console.log(`${ch.ok ? green('✔') : red('✖')} ${ch.name}`);
    console.log(r.ok ? green(kind === 'provider' ? `\n✔ Provider ${name} manifest valid; commands not executed. Implement provider.mjs, enable a route and verify the real service.` : `\n✔ Plugin ${name} works. Run "ym hub restart" to load it.`) : yellow(`\nThe plugin needs more work: edit ${dir} or run the command again.`));
    return;
  }
  die('ym plugin new|test|list');
}

async function cmdProviders(a: Args) {
  const { planService, providerInventory, runService } = await import('./providers.ts');
  const sub = a._[1] ?? 'list';
  if (sub === 'pending' || sub === 'resolve') {
    for (const name of Object.keys(a.flags)) if (!['json', 'repo', 'note', 'hub', 'token'].includes(name)) die(`Unknown provider option --${name}`);
    const client = await getClient(a);
    if (sub === 'pending') {
      if (a._.length !== 2) die('ym providers pending');
      return console.log(JSON.stringify(await client['providers.pending']({}), null, 2));
    }
    const requestId = a._[2], note = flag(a, 'note');
    if (!requestId || !note || a._.length !== 3) die('ym providers resolve <request-id> --note "inspected remote state"');
    return console.log(JSON.stringify(await client['providers.resolve']({ requestId, note }), null, 2));
  }
  if (!['list', 'plan', 'run'].includes(sub)) die('ym providers list|plan|run [capability]');
  for (const name of Object.keys(a.flags)) if (!['json', 'input', 'dry-run', 'repo'].includes(name)) die(`Unknown provider option --${name}`);
  if (a._.length > (sub === 'list' ? 2 : 3)) die('Too many provider arguments. Use --input file.json for request data.');
  if (a.flags.input === true) die('--input needs a JSON file path');
  let cwd = process.cwd();
  const root = await repoRoot(cwd).catch(() => null);
  while (root && cwd !== root && !existsSync(join(cwd, PROJECT_CONFIG_FILE))) cwd = dirname(cwd);
  const config = loadConfig(cwd);
  const loaded = await loadPlugins();
  const report = providerInventory(config.services, loaded.providers, cwd);
  if (sub === 'list') {
    if (a.flags.json) return console.log(JSON.stringify({ ...report, errors: loaded.errors }, null, 2));
    console.log(`Services: ${report.categories.join(', ')}`);
    console.log('Discovery checks executable and environment presence only; sign-in and quota are not checked.');
    for (const p of report.providers) console.log(`${p.name}: ${p.installed ? (p.enabled ? 'enabled' : 'disabled') : 'not installed'} (${p.capabilities.join(', ')})`);
    for (const r of report.routes) console.log(`${r.capability}: ${r.selected ?? 'no eligible provider'}`);
    for (const error of loaded.errors) console.log(`Plugin failed to load: ${error.dir}`);
    if (!report.routes.length) console.log('No service routes configured. Add services.local commands or enable a provider; see docs/PROVIDERS.md.');
    return;
  }
  const capability = a._[2] ?? die(`ym providers ${sub} <capability>`);
  if (a.flags['dry-run']) {
    console.log(JSON.stringify(planService(capability, config.services, loaded.providers, cwd), null, 2));
    return;
  }
  const inputFile = flag(a, 'input');
  if (inputFile && statSync(resolve(inputFile)).size > 1024 * 1024) die('Provider input exceeds 1 MiB');
  const input = inputFile ? JSON.parse(readFileSync(resolve(inputFile), 'utf8')) as unknown : {};
  if (sub === 'plan') {
    console.log(JSON.stringify(planService(capability, config.services, loaded.providers, cwd, process.env, input), null, 2));
    return;
  }
  const stop = new AbortController();
  const abort = () => stop.abort('provider command interrupted');
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await runService(capability, input, config.services, loaded.providers, { cwd, signal: stop.signal, context: { sha: await revParse(cwd, 'HEAD') } });
    console.log(JSON.stringify(result, null, 2));
    if (result.result.status !== 'passed') process.exitCode = 1;
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}

async function cmdVerify(a: Args) {
  for (const name of Object.keys(a.flags)) if (!['json', 'dry-run', 'repo'].includes(name)) die(`Unknown verification option --${name}`);
  if (a._.length !== 1) die('ym verify [--json] [--dry-run]');
  let cwd = process.cwd();
  const root = await repoRoot(cwd).catch(() => null);
  while (root && cwd !== root && !existsSync(join(cwd, PROJECT_CONFIG_FILE))) cwd = dirname(cwd);
  const config = loadConfig(cwd);
  const { verifyArtifact } = await import('./verification.ts');
  if (a.flags['dry-run']) {
    const { planService } = await import('./providers.ts'), loaded = await loadPlugins();
    return console.log(JSON.stringify({ commands: config.verify, services: config.services.verify.map(check => planService(check.capability, config.services, loaded.providers, cwd, process.env, check.input)) }, null, 2));
  }
  const stop = new AbortController();
  const abort = () => stop.abort('verification interrupted');
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const receipts: string[] = [];
    const result = await verifyArtifact(cwd, config.verify, config.verifyTimeoutMinutes, stop.signal, undefined, {
      services: config.services, onServiceResult: run => { receipts.push(run.receiptPath); },
    });
    console.log(JSON.stringify({ ...result, receipts }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}

async function cmdDoctor(a: Args) {
  const checks: [string, boolean, string][] = [];
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  checks.push(['Node.js 22.16+', major > 22 || (major === 22 && minor >= 16), process.versions.node]);
  const g = await run('git', ['--version']).catch(() => null);
  checks.push(['git installed', !!g && g.code === 0, g?.stdout.trim() ?? 'missing']);
  const root = await mainRepoRoot(process.cwd()).catch(() => null);
  checks.push(['inside a git repository', !!root, root ?? 'run from your project folder']);
  const config = loadConfig(root ?? undefined);
  const { providerInventory } = await import('./providers.ts');
  const servicePlugins = await loadPlugins();
  const services = providerInventory(config.services, servicePlugins.providers, root ?? process.cwd());
  console.log(`Service providers: ${services.providers.filter(p => p.enabled && p.installed).length} enabled/installed, ${services.routes.filter(r => r.selected).length} eligible routes; sign-in, entitlement and quota unverified. Run "ym providers list" for details.`);
  const agents = detectAgents(config);
  checks.push(['at least one coding agent', agents.length > 0, agents.join(', ') || 'install Claude Code, Codex, OpenCode, Cursor CLI or Gemini CLI']);
  const remote = flag(a, 'hub') ?? process.env.YARDMASTER_HUB;
  const privateNetwork = a.flags['private-network'] === true || flag(a, 'private-network') === 'true';
  const url = remote ? normalizeHubUrl(remote, { privateNetwork }) : await runningHubUrl();
  checks.push([remote ? 'hub endpoint configured' : 'hub running', !!url, url ?? 'ym hub start (starts automatically when needed)']);
  try {
    const fs = statfsSync(yardHome());
    const freeGb = (fs.bavail * fs.bsize) / 1e9;
    checks.push(['disk space for worktrees', freeGb > 5, `${freeGb.toFixed(1)} GB free`]);
  } catch {
    // statfs unsupported
  }
  if (root) checks.push(['checks configured (verify)', config.verify.length > 0, config.verify.join(' && ') || `add "verify" to ${PROJECT_CONFIG_FILE} so finished work is tested`]);
  checks.push(['required review policy', !config.review.required || config.review.mode !== 'never', `required=${config.review.required}, mode=${config.review.mode}; configured policy, not proof a review passed`]);
  for (const agent of [...new Set([...agents, ...Object.keys(config.agents)])]) {
    const settings = agentSettings(config, agent);
    if (!settings.enabled) continue;
    try {
      const resolutions = TIERS.map(tier => resolveEffort(agent, { settings, tier }));
      checks.push([`${agent} effort policy`, true, resolutions.map((r, i) => `${TIERS[i]}: ${describeEffort(r)}`).join('; ') + '; launch configuration, model behavior unmeasured']);
    } catch (err) { checks.push([`${agent} effort policy`, false, (err as Error).message]); }
  }
  console.log(`Cost coverage: provider-reported / estimated / unknown; missing usage is not free. JEV classifier cost is excluded from task totals. Configured task/day budgets: ${config.budget.perTaskUsd ?? 'unset'} / ${config.budget.dailyUsd ?? 'unset'} USD; native hard caps only where supported, other limits use admission/reactive checks.`);
  if (url) {
    try {
      let client: Client;
      if (remote) {
        const explicit = flag(a, 'token') ?? process.env.YARDMASTER_TOKEN;
        const local = readHubInfo();
        if (explicit || (local && normalizeHubUrl(local.url, { privateNetwork }) === url)) client = fleetClient(url, explicit ?? hubToken(), { privateNetwork });
        else {
          const projectId = flag(a, 'project') ?? (root ? await projectIdFor(root) : undefined);
          if (!projectId) throw new Error('Pass --project ID or run from the paired repo to check this worker channel.');
          workerCredentialDirectory();
          client = (await connectWorker({ hub: url, projectIds: [projectId], machineId: machineId(), privateNetwork })).client;
        }
      } else client = fleetClient(url, hubToken(), { privateNetwork });
      const identity = await client['fleet.identity']({});
      if (identity.kind === 'worker') {
        await client['task.list']({ projectId: identity.projectId! });
        checks.push(['paired connection', true, `machine ${identity.machineId}, project ${identity.projectId}; registry requires owner access`]);
      } else {
        const registry = await client['registry.list']({ projectId: flag(a, 'project') });
        const counts = { managed: 0, observed: 0, stale: 0, unconnected: 0 };
        for (const entry of registry.entries) counts[entry.state]++;
        checks.push(['connected registry', true, Object.entries(counts).map(([name, n]) => `${name}=${n}`).join(', ')]);
        console.log(`Registry coverage: ${JSON.stringify(registry.coverage)}. Unconnected means advertised availability, not an active process. Native clients without a bridge/hook are not discovered.`);
      }
    } catch (err) { checks.push(['connection / registry', false, (err as Error).message]); }
  } else console.log('Registry coverage: unknown until the hub is running. Install/detection alone does not prove a connected client.');
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
    case 'setup': return cmdSetup(a);
    case 'pair': return cmdPair(a);
    case 'add': return cmdAdd(a);
    case 'plan': return cmdPlan(a);
    case 'recover': return cmdRecover(a);
    case 'integration': return cmdIntegration(a);
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
    case 'report': return cmdReport(a);
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
    case 'providers': return cmdProviders(a);
    case 'verify': return cmdVerify(a);
    case 'doctor': return cmdDoctor(a);
    case 'presets': return cmdPresets();
    case 'dashboard': return cmdDashboard(a);
    case 'demo': return cmdDemo(a);
    case 'ci': return (await import('./ci/cli.ts')).runCi(a._[1], { positional: a._.slice(2), flag: (k) => flag(a, k), has: (k) => a.flags[k] !== undefined }, { bold, dim, red, green, yellow, cyan });
    case 'version': case '--version': return console.log(VERSION);
    default: die(`Unknown command "${cmd}". Run "ym help".`);
  }
}

const QUIET_COMMANDS = new Set(['hook', 'mcp', '__mock-agent', 'version', '--version']);

/** Typos in config files are reported once per command, after its output, so they never go unnoticed. */
function reportConfigWarnings(): void {
  const [cmd, sub] = [process.argv[2] ?? '', process.argv[3] ?? ''];
  // Machine-facing or long-running: hooks, the MCP server, the git push gate, and the hub (which logs them as events).
  if (QUIET_COMMANDS.has(cmd) || (cmd === 'ci' && sub === 'gate') || cmd === 'hub' || process.argv.includes('--json')) return;
  for (const w of configWarnings()) {
    process.stderr.write(yellow(`! ${w.file}:\n`) + w.problems.map((p) => yellow(`  ${p}\n`)).join(''));
  }
}

main().then(reportConfigWarnings, (err: Error) => {
  reportConfigWarnings();
  die(err.message);
});
