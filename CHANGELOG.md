# Changelog

## Unreleased
- Small tasks start cheap: with no tier given, a task that touches 1 to 3 specific files with a short ask starts on the cheap tier when the project has checks (Haiku 5.5 costs about a twentieth of Sonnet 5.5). Failures retry, then escalate. `cheapFirst: false` turns it off.
- `ym connect` installs the zero-token hooks for Claude Code and Codex by default; `--no-hooks` skips them.
- `ym disk --dedupe` is experimental: applying it needs `--experimental --yes`. Scanning, restoring and purging are unchanged.
- The MCP server and the CI commands load only when used, so other commands start faster.
- Background Claude Code agents that edit files run in Claude Code's sandbox by default: writes only inside the task's worktree and temp folders, network only to common package registries and GitHub (other hosts are refused instead of prompting), no unsandboxed escape hatch. Configure or turn off with `agents.claude.sandbox`.
- Hub calls time out (60 s; `task.wait` gets its own wait plus 15 s), and worker bundle transfers stop after 10 minutes, so a hub that stops answering can't hang the CLI, a worker or an MCP call forever.
- Tests: a test file left with open handles is ended instead of holding the CI job; test jobs stop after 10 minutes.

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
