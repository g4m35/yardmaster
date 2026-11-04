# Changelog

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
