# Changelog

## 0.9.1
- Malformed unauthenticated request targets return400; rejected asynchronous handlers no longer terminate the hub.
- Native hooks exempt only the exact canonical session. Session identities are scoped by project and machine, including MCP connections addressing multiple repositories; matching legacy claims remain intact.
- Owned-process cleanup includes ordinary detached descendants retaining an inherited marker, with private durable receipts and identity-checked restart recovery. Inspection uncertainty keeps recovery holds; environment-clearing/hostile children remain outside this containment.
- Exact request deduplication preserves different scopes, instruction ordering and acceptance options. Learned routing keeps configured-model histories separate and never attributes legacy aggregate results to a replacement model.
- Managed work without configured checks waits for attention; native code cannot bypass artifact verification by reporting completion without a branch. Explicit allowNoChanges research/report tasks retain report-only completion. Requested failed/missing/unresolved reviews stop by default; explicit advisory review remains available through onUnresolved=proceed.
- Scope lean-context savings to Claude Code and document connected-client, cache and containment limits.

Upgrade hub and workers together. Preserve the private process-owners directory with Yardmaster state. This release adds no database migration; old unverified ready work is held until checks are configured, and batch-local dependency keys are not treated as cross-request identity. Native hook/MCP cooperation now requires a deliberately shared unique YARDMASTER_SESSION value; shared cwd is never ownership.

## 0.9.0
- Durable claim generations fence reclaimed work, native handoffs, usage and bundle uploads. Worker channels on the same machine have independent hub/project-scoped journals and exclusive recovery owners, with preserved legacy migration records.
- Native branch submissions capture immutable committed artifacts for checks, review and integration. Reclaim/resubmit works after failure; stale cleanup preserves dirty, detached, locked, advanced, unmerged and process-held work, including ownership changes during artifact scans.
- Setup, coding, Git/copy/bundle utilities, checks, reviews and planning use supervised process lifetimes and proof-gated recovery. Cancellation stops owned groups; uncertain identities keep work and budget held for inspection.
- Atomic budget reservations prevent concurrent admission from spending the same allowance. Sequenced usage retains actual, estimated, mixed and unknown provenance, including failed/canceled work and omitted cache counters. Limits distinguish native caps, reactive stops and admission; no universal hard billing cap is claimed.
- Private, revocable project-scoped worker pairing, guided setup/doctor and a private agent dashboard distinguish managed, observed, stale and unconnected agents. Native/manual effort settings, floors, retry escalation and worker-local configuration remain under operator control; installed native routers are unchanged.

Upgrade the hub and workers together after stopping their existing processes. Existing data migrates transactionally; unknown process identities remain held rather than assumed stopped. Older workers fail clearly, and older binaries refuse newer database schemas. See [fleet setup and legacy journal recovery](docs/FLEET.md) and [budget migration/recovery](docs/BUDGETS.md).

## 0.8.0
- Optional JEV reasoning-effort integration for first-attempt Claude Code and Codex tasks. Uses a separately installed provider-neutral JSON CLI; no new dependency, credentials, or private router source. Disabled by default, shadow by default when enabled, with exact model/effort bindings and cache-policy gates.
- Preserves explicit effort settings, retry escalation, resumed sessions, agent/model selection, coding prompts, permissions and verification. Bound Claude launches suppress duplicate native JEV routing, including on recovery and fallback.
- Bounded router subprocess with strict response validation, output limits, timeout/cancellation cleanup and unchanged-effort fallback. Each worker uses its own local command/configuration and repository path. Routing latency/status appear in task logs and the run's phase timings; classification dollar usage is not reported by the external contract and remains outside Yardmaster budgets.
- Fixed shutdown/cancellation gaps during worktree preparation, remote base fetching, prelaunch bookkeeping and coding-process startup. Canceled/superseded tasks cannot start after a routing wait, and pending shutdown reaches an agent spawned during startup bookkeeping.
- Regression coverage uses fake router/agent subprocesses, real repositories and the remote-worker path; no live inference is required. Setup and limitations: [docs/JEV.md](docs/JEV.md).

## 0.7.0
The audit release: safer by default, cheaper per task, and fast at any amount of history. The full list of what was found and why is in docs/ROADMAP.md.

**Safety**
- One hub per Yardmaster home. A second `ym hub run` used to run startup recovery before failing on its port, killing the first hub's agents and resetting merges in progress. A lock (pid plus process start time, replaced atomically on takeover) now refuses it, the port is bound before recovery, and a hub that finds another took over its home stops.
- Background Claude Code agents that edit files run in Claude Code's sandbox: writes only inside the task's worktree and temp folders, network only to common package registries and GitHub (other hosts are refused, not prompted for), no unsandboxed escape hatch. `agents.<name>.sandbox` adds hosts or folders, or turns it off.
- Agents and check commands never get the hub's token or address in their environment, and `~/.yardmaster` is private to its owner (0700).
- A task's own checks run in addition to the project's, never instead of them, and `yardmaster.json` always gets a review when an agent changes it.
- The RPC endpoint accepts only the API's own method names; a worker's error report is fenced to the attempt it owns.

**Cost**
- Small tasks start cheap: with no tier given, a task that touches 1 to 3 specific files with a short ask starts on the cheap tier when the project has checks (Haiku 5.5 costs about a twentieth of Sonnet 5.5). `cheapFirst: false` turns it off.
- A task that fails the same way twice gets one try on a stronger model before it comes to you; `retry.escalate: false` is honored everywhere.
- `ym plan` is capped (10 minutes; 40 turns and the budget where the CLI supports them), refuses when today's budget is used up, stops on Ctrl-C, and its spend counts toward the daily budget and `ym report` even when planning fails.
- Codex spend: reasoning tokens were counted twice, and prices were from an older model. Codex now defaults to GPT-6.1 Sol prices, and its cheap tier uses GPT-6 Luna.
- Reviews leave lockfiles out, so a dependency bump no longer costs a large review; background Claude runs no longer load web search and fetch.
- Unknown settings are reported with the one probably meant ("budget.daily": did you mean "budget.dailyUsd"?), so a typo can't silently remove a spending cap.

**Speed and reliability**
- Scheduling and the board read only open work: with 20,000 finished tasks, picking the next task went from 253 ms to 0.5 ms and the board from 230 ms to 2.9 ms.
- One import graph per repo in memory instead of up to 20 (about 20 MB each on a big repo); the standalone binary's hooks skip a health check round trip.
- Fixed runs that stayed "running" forever when a fast agent exited before the runner was listening (mostly on remote workers).
- Hub calls time out (60 s; `task.wait` gets its wait plus 15 s) and worker bundle transfers after 10 minutes.
- Database upgrades no longer crash when several processes open it at once, and a database from a newer Yardmaster is refused.
- `ym connect` installs the zero-token hooks for Claude Code and Codex by default (`--no-hooks` skips them); the MCP server and CI commands load only when used.
- `ym disk --dedupe` is experimental: applying it needs `--experimental --yes`.

**Releases and tests**
- Release tags must match the version in the code and sit on main; pre-releases never become "latest"; npm publishes only after the GitHub release.
- A test file left with open handles is ended instead of holding the CI job; test jobs stop after 10 minutes; task waits in tests report where each task stopped.

## 0.6.0
CI guard hardening, plus cheaper and more accurate CI accounting. Upgrade the guard by pinning the new commit SHA that `ym ci init` prints.
- Security: a recorded pass now counts only when the run it links to backs it up: a run of the same workflow file in the same repo, for the commit the status is on, started before the status was posted, with every job passed by then (only the recording job may finish later). Before, any status from `github-actions[bot]` or anyone with write access counted, so another workflow, a write-scoped token or a run that skipped its own suite could make untested code skip CI. Costs two API reads, only when a candidate is found.
- Security: a pull request run vouches only for its own pull request and base (a pull request into another branch can run any workflow), and a push run only for the tree it tested.
- Security: only `push`, `pull_request` and `merge_group` runs can skip or record. `pull_request_target`, `workflow_run` and similar events test a different commit than the one they report.
- Security: a push run that matches the tree counts only if none of its jobs was skipped. New `allow-skipped` input for jobs that legitimately only run on some branches or events.
- Breaking: `trust-local` needs `trusted-users`; without it signoffs are ignored. Bot accounts never count.
- Security: `ym ci init` prints the guard pinned to the release's commit SHA instead of a tag, and the docs explain why. This repo's own workflows pin every action by SHA, scope release permissions per job, and record with the released guard, so code under review never runs with `statuses: write`.
- Faster guard: its API reads run in parallel, a push reads its tree from the event, and with trust-local it only waits for a signoff that could match (a pull request behind its base no longer sits out the 20-second wait).
- Cheaper guard layout: one final `done` job is both the required check and the recorder (two 1-core jobs per run in total). The audit flags small shell-only jobs that could run on `ubuntu-slim`.
- Costs: current runner labels (`xcode-27`, `windows-2025-vs2026`, `windows-11-vs2026-arm`) were counted as free; larger macOS runners are priced at their own rates ($0.077 and $0.102 a minute).
- Budget: the allowance follows your GitHub plan when the token can see it (Free $12, Pro and Team $18, Enterprise Cloud $300), and GitHub's own overage figure counts as over.
- The push gate checks every pushed branch for running CI at once, and the hook says when it falls back to a `ym` found on PATH.

## 0.5.1
- Fix: `ym disk --dedupe` treated installs as different when only tool caches inside node_modules differed (`.vite`, `.vitest-cache`, `.cache`, ...), so it shared nothing in Vite and Vitest projects. Caches are now left out of the comparison and each project keeps its own; packages and generated code (such as `.prisma`) must still match byte for byte. On a real machine: 0 copies shared before, 14 (9.8 GB) after.

## 0.5.0
Speed and cost per task. Measurements in docs/PERFORMANCE.md.
- Lean launch for background agents (default; `agents.<name>.context: "full"` to opt out): Claude Code runs without your MCP servers, skills or optional tools, so each turn re-reads about 14k tokens of context instead of 61k. A real task measured 69% fewer tokens and 68% lower cost. CLAUDE.md, hooks and permission rules still apply; `mcpConfig` keeps chosen MCP servers.
- Retries continue the agent's session (Claude Code `--resume`, Codex `exec resume`) with a short message instead of a fresh brief (measured: 71% cheaper, about twice as fast). A stuck agent starts fresh; a session that can't be resumed falls back to a fresh one without costing an attempt.
- Effort follows the tier (low, medium, high), the CLI enforces the remaining budget (`--max-budget-usd`), and reviews are capped (read-only tools, `review.maxTurns`, `review.budgetUsd`).
- Escalate to a stronger model after a second failure, not the first; an escalated retry no longer triggers review by itself.
- Fix: Claude spend was counted once per content block, about doubling mid-run estimates and tripping budgets early.
- Fix: the merge worktree had no dependencies, so combined checks in JavaScript repos failed and sent good work back. It's now prepared like task worktrees and refreshed when a merge changes a lockfile.
- Dependencies reach new worktrees with one `clonefile(2)` call per folder on macOS (79k-file node_modules: 17.4 s to 1.9 s), from a checkout whose lockfiles match the worktree's. Deletes move to a trash and finish in the background (5.3 s to 0.004 s on the merge path).
- No wait before retrying a failed check; check slots scale with CPU cores and merge checks have their own; routine cleanup no longer pauses scheduling; the import graph rebuild is incremental and no longer blocks the hub.
- `ym report`: spend per merged task, waste, resumed vs fresh retries, median time per phase. Each run records its phases.
- `ym disk --scan` finds duplicate dependency installs across your projects; `--dedupe` replaces provably identical ones (same lockfile, installed packages and native addons) with space-free clones, keeping originals for `--restore` until `--purge` or 3 days.

## 0.4.0
- CI cost control for GitHub Actions (`ym ci`, docs/CI.md). Works without the hub, for agents and people alike.
  - `ym ci audit`: where Actions minutes went (re-tested trees, failed runs, outdated runs, duplicate triggers, per-job rounding, Copilot and Dependabot runs) and workflow fixes ranked by value.
  - Push gate (`ym ci init`): a git pre-push hook that runs your checks once per file tree before anything reaches CI, warns (or holds) when a push would restart CI still in progress, and holds pushes to private repos when the month's Actions allowance is used up. Keeps any existing pre-push hook.
  - Guard Action (`uses: g4m35/yardmaster@v0.4.0`): skips a workflow's heavy jobs when the exact file tree already passed that workflow, using the tree a pull request run actually tested. Optional trust-local mode accepts `ym ci signoff` from someone with write access.
  - `ym ci budget`: this month's spend from GitHub's billing API, or an estimate from job times when the token can't read billing.
  - `ym ci ship`: push the integration branch as one pull request, so a batch of agent work costs one CI run.
- Yardmaster's runner and merge train record the trees they checked, so pushing that work through the gate doesn't check it again.
- GitHub API reads retry transient server errors.

## 0.3.0
- Faster hooks: 3-5 ms when there's nothing to do (no hub, unmanaged repo, inside background agents), 47 ms in managed repos (was 91-119 ms); the post-edit hook no longer blocks the agent.
- Scheduler and board reads about 14x faster on big boards (216 ms to 15 ms at 300 tasks) and linear in board size.
- Event-driven hub: dependent tasks start right after the previous one merges (5-step chain: 15.2 s to 1.9 s).
- Warm start: new worktrees get your installed dependencies by copy-on-write clone instead of reinstalling.
- `verifyQuick`: change-scoped checks per task, full suite at merge.
- Briefs start with a fixed block of rules (cache-friendly) and include an import-graph map of the task's files.
- Fix: a change that failed only the merge-time check could cycle until it ran out of attempts.
- Fix: hooks didn't recognize files reached through symlinked paths (for example /tmp on macOS).

## 0.2.1
- Standalone binaries for macOS (Apple Silicon) and Linux (x64, arm64): no Node or npm needed. Install with `curl -fsSL https://raw.githubusercontent.com/g4m35/yardmaster/main/install.sh | sh`.
- Release workflow: binaries attached to GitHub releases; npm publish when `NPM_TOKEN` is set.
- The mock agent is now part of Yardmaster itself (`ym __mock-agent`), so `ym demo` works from the binary.
- `ym demo` shuts down cleanly on SIGTERM as well as Ctrl+C, and its checks no longer need Node.
- Fix: merging failed on machines where git has no name/email configured ("Committer identity unknown"). Yardmaster now uses your git identity when set and a neutral one otherwise.

## 0.2.0
- Cross-model review, lessons, learned routing, policies, best-of-N races, merge trains, import-graph coupling, critical-path scheduling.
- Hooks for Claude Code and Codex, a Yardmaster skill, and a single-tool MCP profile.

## 0.1.0
- First release: hub, scheduler with file scopes and dependencies, watchdog and fleet supervisor, merge queue, safe cleanup and disk management, MCP server, CLI, dashboard, multi-machine workers.
