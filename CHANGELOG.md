# Changelog

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
