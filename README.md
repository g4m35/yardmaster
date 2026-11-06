# Yardmaster

Run several coding agents at once (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, or anything with a CLI) without them colliding, looping, or leaving a mess. It works from inside the agent you already use, on as many machines as you have, and shows everything on one dashboard.

- **Stay where you work.** Yardmaster adds a few tools to your agent over MCP. In Claude Code, Codex, Cursor, OpenCode, Gemini CLI, or T3 Code, say *"split this into parallel tasks with yardmaster"* and keep working.
- **No collisions.** Tasks that touch the same files never run at the same time. If two agents start editing the same file anyway, the later one pauses and resumes after the first merges. Your own branch and checkout are never touched.
- **No runaway agents.** Repeated actions, back-and-forth loops, repeated errors, silence, questions nobody will answer, and budget overruns are caught by plain code (no AI babysitter burning tokens) and stopped with an explanation.
- **"Done" means tested.** Work only counts once your own checks pass. The same failure twice stops early instead of using every retry.
- **Cheaper by default.** Small jobs go to small models, retries escalate only when needed, and per-task and per-day budgets are enforced.
- **Cleans up after itself.** Finished worktrees, merged branches, stale reservations and orphaned processes are removed. Anything unmerged or yours is kept and listed.
- **You stay in charge.** Pause new work (or park running agents with their work saved), redirect a running agent with one sentence, and see "heads up" notes when something is slow, stuck in the queue, or about to blow the budget.
- **Disk-aware.** New worktrees wait when the disk is low or Yardmaster's quota is used. Finished worktrees, old logs, and rebuildable build output (`node_modules`, `dist`, `target`, ...) in kept worktrees are cleaned automatically.
- **Agents get better here over time.** A second model from a different family reviews risky changes before they merge. Fixed failures, review findings and your redirects become lessons that brief future agents on related files. The router learns which agent and model actually pass checks on this repo, and at what cost.
- **Smarter scheduling.** Work on the critical path starts first. Tasks editing files that import each other are warned (or kept apart). Several verified tasks merge together with one check run. Hard tasks can be raced by two agents, and the first verified result wins.
- **Your rules.** Policies like "anything under `src/auth` uses a strong model, gets reviewed, and needs my approval" or "docs tasks are cheap" apply automatically.
- **Lighter on CI.** More agents means more pushes, and every push runs your GitHub Actions suite. A git push gate runs your checks once per file tree before anything reaches CI, a workflow guard skips re-testing a tree that already passed, finished agent work ships as one pull request, and pushes to private repos pause before the month's Actions allowance runs out. `ym ci audit` shows where your minutes go.
- **Many machines.** Run `ym worker` on a laptop, desktop or server and they share one queue. Work moves between them as git bundles, so you don't need GitHub or SSH between them.

## Install

Needs git and at least one coding agent you are signed in to.

**No Node needed** (macOS on Apple Silicon, Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/g4m35/yardmaster/main/install.sh | sh
```

**With Node 22.16+** (everyone else, and Intel Macs):

```sh
npm install -g yardmaster                    # once it's on npm (see docs/PUBLISHING.md)
npm install -g github:g4m35/yardmaster       # straight from GitHub (builds on install)
```

Then try it with a fake agent, spending no tokens: `ym demo`.

## Five-minute start

```sh
cd your-project
ym init                 # finds your agents and test command, writes yardmaster.json (commit it)
ym connect all          # adds the yard_* tools to Claude Code, Codex, Cursor, OpenCode, Gemini
ym add "Fix the typo in README.md"
ym add "Add CSV export to the reports page with tests" --files "src/reports/**"
ym dashboard            # live view in your browser
```

Or let an agent plan it: `ym plan "add dark mode across the app" --yes`.

When work is done, it waits on the `yardmaster/integration` branch. Bring it into your branch with `ym land`.

Want to see it first without spending tokens? `ym demo` starts an isolated sandbox with a fake agent.

## Everyday commands

| | |
|---|---|
| `ym status` | What's running, what's waiting and why, what needs you (`--watch`, `--all`) |
| `ym show <id>` / `ym logs <id> -f` | One task's details and live activity |
| `ym retry`, `stop`, `cancel`, `approve` `<id>` | Control a task |
| `ym land` | Fast-forward your branch to the finished work |
| `ym tell <id> "use the existing date helper"` | Redirect a running agent; it restarts with your guidance and keeps its work |
| `ym pause [--now]` / `ym resume` | Stop new work from starting (`--now` also parks running agents, saving their work) |
| `ym disk` | What uses disk space and what can be freed safely |
| `ym service install` | Keep the hub running across crashes and reboots (launchd on macOS, systemd on Linux) |
| `ym clean` | Show what can be cleaned up; `--yes` to do it |
| `ym doctor` | Check your setup |
| `ym presets` | `frugal`, `balanced`, `fast`, `careful` |

`ym add` options: `--files a,b` (what it will change), `--after t-123`, `--agent codex`, `--tier cheap|standard|strong`, `--verify "npm run e2e"` (extra checks, on top of the project's), `--budget 1.5`, `--best-of 2`, `--review always|never`, `--no-changes-ok` (for reviews and research).

## Making agents better

| Feature | What happens | Configure |
|---|---|---|
| Cross-model review | After checks pass, a reviewer from a different model family reads the diff. Blocking issues go back to the implementer (keeping its work); approval lets it merge. | `review.mode` (`auto`/`always`/`never`), `review.reviewers`, `review.maxRounds` |
| Lessons | Learned from fixed failures, accepted review points and your redirects; injected into briefs of related tasks; retired automatically if they don't help. | `learning.lessons`, `ym learn "..."`, `ym lessons` |
| Learned routing | Picks the agent with the best verified-per-dollar record for that kind of work on this repo, and explores now and then. | `learning.routing`, `learning.costWeight`, `learning.explore` |
| Best-of-N | `--best-of 2` (or a policy) races agents on the same task in separate worktrees; the first verified one merges, the rest stop. | `bestOf` on a task or policy |
| Critical path | Tasks that unblock long chains start first. | automatic |
| Coupling | An import graph finds tasks that touch files importing each other; their briefs say what to keep stable, or they wait. | `coupling` (`warn`/`serialize`/`off`) |
| Merge trains | Several verified tasks merge together and are checked once; on failure they go one at a time to find the culprit. | `integration.trainSize` |
| Policies | Rules matched by files, wording, tier or creator set model size, agent, review, races, checks, budgets, approval and house rules. | `policies` |

```json
{
  "policies": [
    { "name": "auth is sensitive", "when": { "files": ["src/auth/**"] },
      "set": { "tier": "strong", "review": "always", "requireApproval": true, "guidance": "Never log tokens or passwords." } },
    { "name": "docs are cheap", "when": { "text": "readme|docs?\\b" }, "set": { "tier": "cheap", "review": "never" } },
    { "name": "hard bugs get two tries at once", "when": { "text": "race condition|flaky|deadlock" }, "set": { "bestOf": 2 } }
  ]
}
```

## From inside your agent

After `ym connect`, your agent has these tools:

| Tool | Use |
|---|---|
| `yard_add_tasks` | Queue background work with files, order, and model size |
| `yard_wait` | Wait for results without polling |
| `yard_status`, `yard_task` | See what everyone is doing and why things wait |
| `yard_claim_files`, `yard_release_files`, `yard_who` | Reserve files you are editing by hand so background agents stay away |
| `yard_take_task`, `yard_finish_task` | Do a queued task yourself in this session |
| `yard_send`, `yard_inbox` | Short handoff notes between agents |
| `yard_control` | Retry, cancel, stop, approve, or redirect with a note |
| `yard_learn` | Save repo knowledge for future agents |

`ym connect` also installs a short skill that teaches agents when and how to fan out. For Claude Code and Codex it also installs hooks that coordinate with zero tool calls (skip them with `--no-hooks`): a briefing at session start, board changes before a prompt (only when something changed), automatic reservation of files the agent edits, and a guard on edits to files another agent holds. Hooks fail open: if the hub isn't running, nothing is blocked. Why this layering beats MCP alone: [docs/INTEGRATION.md](docs/INTEGRATION.md).

## More machines

On the hub machine:

```sh
ym hub restart --host 0.0.0.0     # or bind to your Tailscale IP
ym token                          # prints the join command
```

On each other machine, inside its clone of the repo:

```sh
ym worker --hub http://hub-host:7777 --token <token>
```

Each machine uses its own installed agents and logins. Prefer a private network such as Tailscale. The token is the only thing protecting the hub, and anyone holding it can queue work that runs commands on your machines (that is what agents and checks do), so treat it like an SSH key.

## Supervision

Three layers, none of which spend tokens:

1. **Per-agent watchdog** stops a run on: the same action repeated, back-and-forth between two actions, the same error repeated, silence, a question nobody will answer, a runtime cap, or the task's budget.
2. **Fleet supervisor** (every few seconds) adds "heads up" notes: an agent running a while without changing any files; work that could start but hasn't, with the reason (no machine has that agent, all slots busy, low disk); today's budget projected to run out soon. It also releases file reservations left by agent sessions that went away.
3. **Process supervision**: agents run in their own process groups and nothing they start outlives the attempt; a restarted hub kills orphaned agents (verified by pid and start time) and resumes their tasks from the saved worktree; `ym service install` has the OS restart the hub itself.

Every state change from an agent run is tied to its attempt, so a canceled task, or one taken over by another machine after a laptop slept, can never be overwritten by the old run.

## Disk space

- Before starting work a machine checks free space (`disk.minFreeGb`, default 5) and Yardmaster's own usage (`disk.maxWorktreesGb`, default 40). Over either, it holds new work and cleans up.
- Merged worktrees and branches are removed right after merging. Worktrees kept on purpose (needs you, unmerged work) lose only git-ignored build output from `disk.artifactDirs`.
- Logs are capped (`disk.maxLogsMb`) and expire (`cleanup.logRetentionDays`).
- `ym disk` lists the largest worktrees and how much `ym clean --yes` would free.

## CI costs

```sh
ym ci audit owner/repo   # where the Actions minutes went and the fixes worth making
ym ci init               # push gate in this repo, plus the guard to paste into your workflow
ym ci budget             # this month's spend against your allowance
ym ci ship               # finished agent work as one pull request: one CI run for the batch
```

On agent-heavy private repos, 15 to 20% of billed minutes typically go to re-testing an identical file tree after a pull request merges, and another 10 to 25% to failed runs that local checks would have caught. None of this needs the hub, and it works the same for agents and people. Details, the guard's safety rules, and alternatives: [docs/CI.md](docs/CI.md).

## Configuration

`yardmaster.json` in the repo (shared) and `~/.yardmaster/config.json` (this machine). Everything is optional:

```json
{
  "preset": "balanced",
  "verify": ["npm run typecheck", "npm test"],
  "maxParallel": 3,
  "routing": { "cheap": ["claude", "codex"], "standard": ["codex", "claude"], "strong": ["claude"] },
  "agents": {
    "claude": { "models": { "cheap": "haiku", "standard": "sonnet", "strong": "opus" }, "maxParallel": 2 },
    "codex": { "autonomy": "workspace" },
    "aider": { "command": "aider --yes-always --message {prompt}" }
  },
  "budget": { "perTaskUsd": 3, "dailyUsd": 25 },
  "integration": { "requireApproval": false },
  "watchdog": { "repeatThreshold": 4, "stallMinutes": 10, "maxRuntimeMinutes": 45 },
  "hotFiles": ["package-lock.json", "**/migrations/**"]
}
```

Background agents run lean by default: your CLAUDE.md, AGENTS.md, hooks and permission rules apply, but your MCP servers, skills and the tools no unattended coding run needs don't load, which cuts the context every turn re-reads by about three quarters (`agents.<name>.context: "full"` turns that off; `mcpConfig` keeps chosen MCP servers). `autonomy: "workspace"` (default) keeps unattended agents inside their task. Claude Code runs in its sandbox: shell commands can write only inside the task's worktree and temp folders (not your checkout, the repo's `.git` folder or `~/.yardmaster`) and reach only common package registries and GitHub; any other host is refused. Add hosts or writable folders with `agents.claude.sandbox.allowedDomains` / `allowWrite` (the list replaces the defaults), or turn it off with `"sandbox": { "enabled": false }`. On Linux the sandbox needs bubblewrap; without it commands run unsandboxed. Codex uses its workspace-write sandbox. `"full"` uses each agent's bypass mode, with no sandbox.

Costs are what the agent reports (Claude Code, OpenCode). For agents that only report tokens (Codex, Gemini) they are estimates from list prices, shown as "est.". Override them in `pricing`.

## Plugins

Everything an agent needs is a small plugin, the same shape as the built-ins. Let your agent write one:

```sh
ym plugin new aider --describe "drive the aider CLI non-interactively" --with claude
ym plugin test aider
ym hub restart
```

Notifier plugins can send updates to Slack, ntfy, or a webhook. See `~/.yardmaster/plugins/<name>/PLUGIN_GUIDE.md`.

## Speed

Yardmaster stays out of your agents' way and cuts what each task costs:

- Background agents start with about 14k tokens of context instead of 61k; a real task measured 69% fewer tokens and 68% lower cost.
- A retry continues the agent's own session (measured: 71% cheaper and twice as fast as starting over).
- A 79k-file `node_modules` reaches a new worktree in 1.9 s instead of 17.4 s, and is deleted in milliseconds when the task merges.
- Hooks cost 3 to 5 ms when there's nothing to do; dependent tasks start the moment the previous one merges.
- `ym report` shows spend per merged task, waste, and where the time goes; `ym disk --scan` finds duplicate dependency installs anywhere on your Mac (20 GB on the machine we measured) and `--dedupe` shares them, recoverably.

The measurements are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For the research behind it (Gas Town, Symphony, Overstory, OpenWeft, DeepSeek Harness, and real developer complaints), see [docs/RESEARCH.md](docs/RESEARCH.md).

## Status

Early (0.5). Tested end to end with the mock agent (84 tests, including the CI gate, guard, budget and audit against a mock GitHub API and real git pushes, and policies, cross-model review rounds, lessons and their credit, critical-path ordering, races, merge trains, import-graph coupling, hooks, the minimal MCP profile, and parallel scheduling, scopes, dependencies, loops, budgets, retries, conflicts, edit-time overlap, approval, cleanup safety, a two-machine run, the MCP server, pause/redirect, supervisor warnings, disk holds and artifact trimming, and regression tests for cancel-during-verify, stale attempts, detached HEADs and hand edits in the integration worktree). Smoke-tested with real Claude Code and Codex. The Cursor and Gemini adapters follow their documented stream formats but haven't been run against live sessions yet.

## License

MIT
