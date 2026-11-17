# Changelog

## Unreleased

### iPhone apps on a real device
- Safety: validate the artifact's actual bundle ID before installing, reject unbound prebuilt apps for commit acceptance, detect unexpected app exit without a crash report, redact build transcripts before persistence, and guarantee app/console cleanup when evidence writes fail.
- New built-in `apple-device` provider (opt-in, `device.test`, macOS with Xcode): tests on a paired iPhone or iPad through `xcrun devicectl`, holding the machine-wide `physical` lease for the whole run. It finds the configured device (UDID or name) or the only paired one; a missing, unpaired, locked, unreachable or Developer-Mode-off device, several candidates, or a missing `devicectl` is unavailable with the reason, never a pass. It installs only a build you configure, from the run's own hashed copy, never over a copy it did not install unless `install.replaceExisting` is set, and removes only what it installed fresh, only with `install.uninstallAfter`. Without a build it tests the copy already installed. It launches the app attached to its console (stdout and stderr become `app-console.log`), confirms the process is running, takes screenshots, runs your smoke commands with the device's UDID, stops what it launched, and fails the run on a new crash report from the app, which it keeps. See [docs/DEVICES.md](docs/DEVICES.md#physical-devices).
- Physical evidence: `device.kind: "physical"`, model, model identifier, iOS version and build, and `physical: passed|failed|unknown|untested`, bound to the commit, artifact sha256 and Xcode version like simulator evidence. The device is identified by a stable hashed key; the UDID, serial number, ECID, CoreDevice identifier and the device's own name are redacted from every saved text file. New `deviceApp` field records the app's version on the device and whether the run installed it. Acceptance does not accept a physical pass of an app that was already installed, since it is not a build of the commit.
- A lease now records the device it uses, so two runs never share one device when `limits.physical` allows several.
- `examples/ios-device-runner`: a small XCUITest runner that drives any installed app by bundle ID (foreground, tap, find text with scrolling, permission alert, Home, screenshots), built once with your development team, plus `stays-running.mjs`, a smoke check that needs no UI automation.
- Dashboard Details show the app found on the device and whether it was built from the commit.

## 0.9.6
- Fixed: a killed or crashed Yardmaster process left its dependency-reuse proof folders in `~/.yardmaster/clone-proofs`. Proof folders now carry their owner's process ID, and the next process to share dependencies removes folders whose owner is gone (including the unnamed ones earlier releases left behind).
- Docs: `docs/JEV.md` says that the JEV router this integration was built against is not publicly released.

## 0.9.5
- Fixed: a high load average held the first task too, so a busy machine with nothing running could wait indefinitely (GitHub's macOS runners report a load of 11 to 18 per CPU, and `ym demo` never started there). Memory limits still apply before the first task; the load limit applies once a task is running, as it did before 0.9.4.

0.9.4 was tagged but never published: its macOS binary failed the release smoke test on this bug. Its changes, listed below, ship in 0.9.5. CI now runs that smoke test on macOS as well as Linux before anything is tagged.

## 0.9.4

### iPhone apps on the simulator
- Device verification for iPhone apps with no account: the built-in `apple-simulator` provider (opt-in, `device.test`) builds with your existing command, takes a machine-wide simulator lease, creates its own simulator, installs, launches, screenshots and runs your smoke tests (any command, Maestro, `xcodebuild test` or agent-device), then deletes that simulator and releases the slot. Missing or broken tools are unavailable, never a pass. See [docs/DEVICES.md](docs/DEVICES.md) and `examples/ios-smoke`.
- Machine-wide leases for `build`, `simulator` and `physical` slots, shared by every project and Yardmaster process on the machine, in arrival order, surviving hub restarts. Holders are identified by PID and process start time; a slot is freed only once its holder's process is gone (a live holder that stops renewing keeps it), by the hub, the next request or `ym devices reap`, which first delete only the simulators that lease recorded. A failed cleanup keeps the slot occupied. Simulators Yardmaster did not create are never touched.
- A command under a lease that cannot be confirmed stopped keeps the slot until the reaper confirms its recorded process is gone.
- Device evidence binds each run to the commit, the artifact's sha256, machine and Xcode, device model, iOS runtime and the checks that ran, with screenshots and logs in the receipt. Code, simulator and physical-device results are separate: a simulator pass never satisfies a physical-device requirement, which stays untested. Acceptance rejects device evidence for a different commit or request, a lower requirement than the check or configuration asked for, or a physical pass without a physical device. Shown by `ym devices evidence`, the `yard_devices` MCP tool, `devices.status` and a task's Details tab in the dashboard.
- Build reuse only on an exact compatibility key your tool reports, with the stored artifact re-hashed before use; an unreadable key builds normally.
- New `ym devices status|evidence|reap|release|recover|lease`. `recover` is an owner-only way to free a stale claim whose holder cannot be identified; it still deletes only the simulators the lease recorded. `ym devices lease <pool> -- <command>` holds a slot for any tool.
- Admission checks load and memory before the first task, not only when one is already running (Linux reads `MemAvailable`, which counts reclaimable cache), and holds new tasks at macOS memory pressure `critical` (`resources.holdAtPressure`). Heavy device work waits from `warn` (`devices.holdAtPressure`).
- CI runs the sample app on `macos-latest`: acceptance, two projects contending for one simulator, a physical requirement, cancellation and a crashed holder.

### Security
- Remote CLI and hook connections require explicit credentials or a saved pairing credential for the exact hub, project and machine. The local owner token is used only for loopback or for the address this machine's own running hub published (an overlay IP it is bound to). Non-loopback HTTP requires `--private-network` (hooks: `YARDMASTER_PRIVATE_NETWORK=1`); authenticated RPCs reject redirects.
- Secret-shaped environment variables are removed from agents and shell checks by default; only the selected agent keeps its own sign-in. Configure `env.pass` for agent exceptions and `env.checks.pass` for setup and verification exceptions; see `docs/INTEGRATION.md`.
- Worker run telemetry is validated before storage; corrupt historical run JSON is read as empty values, with one durable warning per run.
- Scope matching uses bounded dynamic programming instead of backtracking, and new scope patterns are limited at RPC and config boundaries. Reported touched paths are literal file names (glob characters in a real name match only that name); lock checks and `yard_who` take patterns and folders. Stored oversized scopes use conservative matching and one durable task warning.
- Temporary base bundles are always removed after creation, authorization or streaming failures. Outstanding downloads are limited to four per hub and one per worker (HTTP 429 when busy); clients retry with bounded backoff and jitter, honoring Retry-After, within the transfer deadline.
- Release builds never restore or save an Actions cache, and CI and release checkouts no longer keep git credentials.

### Efficiency
- Runner usage and activity reports skip repeats the hub already acknowledged; one control polling loop remains, and ordinary usage growth is recorded from persisted run totals. The supervisor shares its reads within each pass. Task log reads and patch output are bounded, and immutable artifact diffs are cached with size and count limits.
- The dashboard uses its live stream while connected, polls only when disconnected, and pauses while the page is hidden. The hub shares one bounded event read and one serialized batch per group of clients at the same cursor, gives older cursors separate catch-up reads, and pauses writes to backpressured connections.
- Migration 14 adds a backward-compatible `(status, finished_at DESC)` index for recent completions.
- CI jobs compile and type-check once instead of three times; the OS and Node matrix and device checks are unchanged.

### Dependency reuse and disk accounting
- Fresh and rewritten dependency installs count toward worktree disk quotas. Only recorded copy-on-write clones whose source was verified unchanged through the copy, and that stay unchanged under continuous monitoring, are exempt. If the source disappears or changes, one surviving clone is charged for it. Concurrent clones of one source share one record.
- Warm start compares tracked root, nested and submodule lockfiles (submodule locks only where the new worktree has that submodule), ignoring untracked agent worktrees and shared directories. Unreadable tracked inputs never authorize reuse or deletion, and skipped reuse suggests a setup command such as `npm ci`.
- Projects with no lockfile refresh their dependencies only when a tracked manifest such as `package.json` changes, instead of on every merge. Lockless projects with no setup command keep reuse with an explicit warning.
- Disk measurement accepts the total `du` prints even when it reports an unreadable or vanished file, and its fallback walk no longer blocks the worker.

### Reliability
- Process cleanup retries a failed or slow ownership inspection (twice, with backoff) before calling cleanup unverified, and allows `ps` five seconds instead of two. On a busy machine a slow `ps` no longer holds finished work for recovery or keeps a device slot occupied.

### Docs
- Proofread README, docs, skill and installer text; corrected CLI help; added `SECURITY.md`, `CONTRIBUTING.md` and an iPhone section in the README.

Database migrations 12, 13 and 14 add the `resource_leases` and `device_evidence` tables and one index; no existing data changes. Workers that run device checks need this version too.

## 0.9.3
- Fixed: while a task merged newer work in to resolve a conflict, every merged-in file counted as changed by the task (994 files for a 9-file change). Those counts feed live overlap checks and the file reservations that keep tasks apart, so a conflict fix could block or pause unrelated work. Uncommitted edits now count only where they differ from the task's base, and the paths are compared in memory so very large merges cannot exceed the command-line limit.
- Dashboard: the Changes tab counts the change itself once read; the status line counts projects instead of listing folder names; feed events name tasks briefly; machines say "idle" or how many are busy; agents and connections sit above the feed.

No database migration.

## 0.9.2
- Dashboard rebuilt as a three-pane console after the owner rejected the first redesign as looking the same: a left rail with the stage counts, machines and today's spend; the work list in the middle with a filter; and on the right either an overview (what needs you, what just happened, cleanup, connections) or the selected task beside the list. Dark scheme. On narrow screens it becomes one column with what needs you first, and a task opens full screen. See [docs/DASHBOARD.md](docs/DASHBOARD.md).
- The selected task has tabs: Changes, Activity, Request, History and Details. Changes shows the actual diff, file by file, read from the hub with the new owner-only `task.diff` method: the saved commit once it exists (what approval merges), or the live working copy while the attempt runs. Large changes are cut at a line and say so.
- Keyboard: J and K (or the arrow keys) move through the list and open each task, A then A (or Enter) approves, R jumps to guidance, N adds work, / filters, Esc closes the task.
- Stopped tasks ("Needs you") are rows in the list too, not only a banner.
- "Approve and merge" now appears in the "Needs you" banner; it was only reachable from the task detail.
- When work is stopped for changing files outside its list, the task detail names the files and lets the owner allow them (`task.setScope`, owner-only), then retry.
- Task names are the first sentence of the request instead of its first 200 characters, from `ym add` and the dashboard. Activity lines drop the worktree path and the "cd there first" prefix before clipping.
- Fixed: the first changed file reported by a running task lost its first character when it was an unstaged edit (`rc/app.ts` for `src/app.ts`), so edit-time overlap checks could miss it.
- `board.status` rows add `budget`, `attempt`, `maxAttempts`, `phase`, `createdAt`, `startedAt`, `readyAt` and `needsApproval`.
- Optional service-provider plugins and project-local commands share capability routing across research, builds, CI, browsers, devices, deployment, data, observability and notifications. Existing coding-agent adapters and notifier plugins remain compatible.
- `ym providers list|plan|run` exposes provider prerequisites, ordered preferences, locality and cost policies. Fallback is pre-dispatch only; failed, interrupted or malformed service results never trigger automatic replay through another provider.
- `services.verify` and `ym verify` run providers through committed-artifact acceptance and integration checks. Private pending/completed receipts survive restarts; dashboard activity/task details report real plans and results. Unknown results stop automatic repair/replay, including merge trains.
- Optional built-in Browserbase support connects an existing test command to one bounded cloud session and confirms release. Local commands remain account-free; discovery checks prerequisites without claiming account/quota access. Public JavaScript provider APIs and checksum-validated hosted receipt collection are included.

No database migration. Upgrade the hub to get the new dashboard and the provider commands; workers that run service checks need 0.9.2 too.

## 0.9.1
- Malformed unauthenticated request targets return400; rejected asynchronous handlers no longer terminate the hub.
- Native hooks exempt only the exact canonical session. Session identities are scoped by project and machine, including MCP connections addressing multiple repositories; matching legacy claims remain intact. Native submissions retain the checkout captured at claim time across later nested-directory or linked-checkout status calls.
- Owned-process cleanup includes ordinary detached descendants retaining an OS-visible inherited marker, with private durable receipts and identity-checked restart recovery. Inspection uncertainty keeps recovery holds; children clearing/hiding their environment and hostile children remain outside this containment.
- Exact request deduplication preserves different scopes, instruction ordering and acceptance options; request edits invalidate stale identities. Learned routing keeps configured-model histories separate and never attributes legacy aggregate results to a replacement model.
- Managed code changes without configured checks wait for attention; native code cannot bypass artifact verification by reporting completion without a branch. Explicit allowNoChanges research/report tasks with no changed files complete without code integration, including when file-scoped quick checks have no inputs. Requested failed/missing/unresolved reviews stop by default; explicit advisory review remains available through onUnresolved=proceed.
- Scope lean-context savings to Claude Code and document connected-client, cache and containment limits.
- Commit report completion and its notification together behind owner/control/process fences for local and paired workers. Report winners cancel best-of-N rivals through the normal race controls. Cleanup planning skips a merged branch concurrently removed by integration tidy rather than aborting the whole plan.

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
