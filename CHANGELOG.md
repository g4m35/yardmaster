# Changelog

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
