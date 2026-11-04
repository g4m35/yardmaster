# Performance

Goal: Yardmaster should never be the thing an agent waits on, and it should remove waiting agents would
otherwise do. Measured on an M-series MacBook (2026-11-03). Reproduce with the scripts in `bench/`.

## Overhead added to agents

| Path | Before | After | How |
|---|---|---|---|
| Hook, no hub running | 91 ms | **3 ms** | A POSIX shell guard exits before Node starts |
| Hook, repo not managed by Yardmaster | 119 ms | **5 ms** | The guard checks a list of managed folders (`~/.yardmaster/roots`) |
| Hook inside Yardmaster's own background agents | ~110 ms | **4 ms** | The guard skips when `YARDMASTER_TASK_ID` is set |
| Hook before an edit, managed repo | 111 ms | **47 ms** | Small dedicated entry (`hook-main`), repo lookup cached per folder, one hub request instead of two or three |
| Hook before a prompt, managed repo | 106 ms | **47 ms** | Same; prints nothing unless the board changed |
| Hook after an edit (reserve the file) | 115 ms, blocking | **0 ms to the agent** | Runs `async` in Claude Code and Codex |

About 38 ms of the remaining 47 ms is Node's own startup.

## Scheduler and dashboard

| Operation | 300 tasks, before | 300 tasks, after | 1,000 tasks, after |
|---|---|---|---|
| One scheduling pass (holds the write lock) | 216 ms | **15 ms** | 47 ms |
| Board read (dashboard, hooks, `yard_status`) | 256 ms | **17 ms** | 50 ms |

The old code re-asked the same questions for every queued task (active work, reservations, dependencies, spend,
agent stats). A per-pass cache answers each once, and indexes cover the hot queries. Cost now grows linearly.

## Time between tasks

| Benchmark | Before | After |
|---|---|---|
| 5 dependent tasks with instant agents (`bench/chain.bench.ts`) | 15.2 s (3.0 s idle per step) | **1.9 s (0.32 s per step)** |

The hub reacts to every state change immediately (debounced 15 ms) instead of waiting for its 1.5 s timer.

## Work agents no longer redo

- **Warm start.** New worktrees get the checkout's installed, git-ignored dependency folders (`node_modules`,
  `target`, `vendor`, ...). Python virtualenvs are never copied, since they hard-code their location and a copy
  would still install into your real environment. Add a `worktree.setup` command such as `uv sync` instead. On APFS, btrfs and XFS this is a copy-on-write clone: this repo's 73 MB
  `node_modules` takes 0.2 s, and the time barely grows with size (it's metadata, not data). It takes no extra
  disk until something changes, and the originals are never touched. Without copy-on-write, folders under
  `worktree.maxPlainCopyMb` are copied and larger ones are skipped. Clones don't count against the disk quota.
- **Quick checks.** `verifyQuick` runs change-scoped checks per task (`{files}` is replaced with the changed
  files), and the full `verify` suite runs at merge time, batched by merge trains. With `integration.mode: "none"`
  there's no merge step, so tasks run the full suite themselves.
- **Shorter exploration.** The brief includes a map of how the task's files connect (imports, importers) and
  starts with a fixed block of rules, so providers can reuse the cached opening across tasks and retries.

## What isn't worth it

- **`claude --bare`** to skip your config on background runs: it also skips your Claude login, so it fails
  for subscription users.
- **Skipping MCP servers** (`--strict-mcp-config`) on background runs saves about 0.2 s of a roughly 1.5 s
  startup, which isn't worth losing your tools. If you want it anyway, add it to `agents.claude.extraArgs`.
