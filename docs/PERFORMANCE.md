# Performance

# Current local stress check

Run `node scripts/benchmark.ts` from a source checkout on Node 24. It creates and removes a disposable home/repository, seeds 1,000 tasks and 10,000 events, warms each operation five times, and measures 100 samples without provider calls. No personal hub is connected. Admission samples explicitly release their unattached allowance because no child is launched.

On macOS arm64, Node 24.22.2, during concurrent test/agent activity on 2026-11-07:

| Operation | Median | p95 |
| --- | ---: | ---: |
| Board API | 153.7 ms | 282.5 ms |
| Registry API | 0.12 ms | 0.32 ms |
| Last 100 events | 0.14 ms | 0.41 ms |
| Queue admission | 26.4 ms | 41.5 ms |

End-of-run RSS was 245 MiB. These are in-process API dispatch measurements, excluding HTTP, browser rendering, provider latency and cold startup. There is no measured baseline comparison or cross-machine performance guarantee. Raw measurement is retained in the hillclimb evidence; rerun on the target machine for a meaningful comparison.

Registry history and passive machine/session inventories are bounded; live runs remain visible. SSE refreshes coalesce and serialize. Cleanup removes up to 1,000 expired project events per pass, using `cleanup.eventRetentionDays` (30 by default, `null` to retain indefinitely). Unfinished and process-held task evidence survives retention and stale cleanup plans. Accepted artifact refs are pruned only after terminal integration, ancestry validation and compare-and-delete; unmerged artifacts remain reachable.

# Historical measurements

These earlier measurements are retained for context and have not been requalified by the current hillclimb. The current stress check above has a different dataset and load; it is not a direct regression comparison.

Goal: Yardmaster should never be the thing an agent waits on, and it should remove waiting agents would
otherwise do. Measured on an M-series MacBook (2026-11-03). Reproduce with the scripts in `bench/`.

## Cost and speed per task (0.5)

Measured 2026-11-04 on Claude Code 2.1.318 and the owner's real projects; reproduce with `bench/deps.bench.ts`.

| What | Before | After | How |
|---|---|---|---|
| Context every background turn re-reads | 61,135 tokens | **about 14,000** | Lean launch (below) |
| A real one-line task with Claude Haiku, end to end | 146,590 tokens, $0.0079 | **45,847 tokens, $0.0025** | Same task, same result, lean launch |
| A retry after a failed check | fresh session: re-sends the brief, re-reads the code | **resumed: $0.0008 vs $0.0028, 5.7 s vs 10.7 s** | Continue the agent's own session |
| Copy a 79,455-file node_modules into a new worktree | 17.4 s (`cp -cR`, file by file) | **1.9 s** | One `clonefile(2)` call for the whole folder |
| Delete it when the task merges | 5.3 s on the merge path | **0.004 s** | Move to a trash folder, delete in the background |
| Check runs at the same time | 1 | **1 per 4 cores** (max `maxParallel`), plus 1 for merges | Merge checks no longer queue behind task checks |
| Wait before retrying a failed check | 20 s × attempt | **0** | Waiting only helps flaky infrastructure |

**Lean launch** (`agents.<name>.context: "lean"`, the default) is where most of the money is. A background
Claude Code run used to load everything an interactive session loads: every MCP server's instructions, every
skill and plugin, the subagent catalog, and tools no unattended coding run needs (artifacts, scheduling, remote
triggers). Measured context at startup:

| Launch | Context |
|---|---|
| Everything (0.4) | 61,135 |
| No MCP servers | 46,840 |
| + no skills or slash commands | 42,936 |
| + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (drops the Artifact and DesignSync tools) | 29,907 |
| + only the coding tools (Bash, Read, Edit, Write, NotebookEdit, LSP, WebFetch, WebSearch) | **about 14,000 per turn** |

Repeated context may be cheaper when the provider reports cache reuse. Cache identity depends on the provider and launch/session shape; neither a worktree change nor a matching Yardmaster launch fingerprint proves a cache miss or hit. Your CLAUDE.md,
AGENTS.md, hooks and permission rules still apply in lean runs. `"full"` restores the old behavior;
`mcpConfig` keeps chosen MCP servers.

Also cheaper by default:
- **Effort follows the tier**: cheap work runs at low reasoning effort, standard at medium, strong at high (Claude Code `--effort`, Codex `model_reasoning_effort`). Override per agent with `effort`.
- **Escalation after the second failure**, not the first: the same model usually fixes its first failure once it sees the error, especially with its session resumed. A retry escalated to a stronger model no longer triggers a review by itself.
- **Claude receives its native budget flag** with the reserved allowance; reported usage drives reactive stops. These are not a guaranteed hard cap; see BUDGETS.md.
- **Reviews are capped**: read-only tools, 15 turns, $1 (`review.maxTurns`, `review.budgetUsd`).
- **Spend is counted once per message.** Claude Code repeats a message's usage once per content block; counting each copy doubled the mid-run estimate, so budgets tripped at about half the real spend.
- **The brief says which checks matter**: with `verifyQuick`, agents are told to run the quick checks on their changes rather than the whole suite.

**Merge checks have dependencies now.** The merge worktree used to have no installed dependencies, so in JavaScript
repos every combined check failed ("command not found"), sending good work back for another paid attempt. It now
gets them like task worktrees, and refreshes them when a merge changes a lockfile.

**Dependency reuse is lockfile-aware.** A new worktree takes dependencies from a checkout whose lockfiles match
it exactly: your checkout, or another Yardmaster worktree (often the one that just installed a new package). When
none match, the event log says so.

`ym report` shows the result for your own work: spend per merged task, money spent on work that never merged,
how many retries resumed their session and what they cost compared with fresh ones, and median time per phase.

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

- **Warm start.** New worktrees get installed, git-ignored dependency folders (`node_modules`, `target`, `vendor`,
  ...) from a checkout with matching lockfiles. Python virtualenvs are never copied, since they hard-code their
  location and a copy would still install into your real environment. Add a `worktree.setup` command such as
  `uv sync` instead. On APFS a whole folder is cloned with one `clonefile(2)` call (through macOS's built-in
  JavaScript for Automation, so nothing extra is installed); on btrfs and XFS with reflinks. It takes no extra disk
  until something changes, and the originals are never touched. Without copy-on-write, folders under
  `worktree.maxPlainCopyMb` are copied and larger ones are skipped. Clones don't count against the disk quota.
- **Quick checks.** `verifyQuick` runs change-scoped checks per task (`{files}` is replaced with the changed
  files), and the full `verify` suite runs at merge time, batched by merge trains. With `integration.mode: "none"`
  there's no merge step, so tasks run the full suite themselves.
- **Shorter exploration.** The brief includes a map of how the task's files connect (imports, importers) and
  starts with a fixed block of rules, so providers can reuse the cached opening across tasks and retries.

## What isn't worth it

- **`claude --bare`** to skip your config on background runs: it also skips your Claude login, so it fails
  for subscription users.
- **Recycling worktrees** between tasks instead of creating new ones: `git worktree add` takes 0.47 s on a
  3,900-file repo, so a pool would save about a quarter second per task. Worth revisiting for repos with tens of
  thousands of tracked files.
- (Corrected in 0.5: 0.3 measured only the startup time of skipping MCP servers, about 0.2 s, and called it not
  worth it. The token cost, measured since, is the real saving; see the lean launch above.)

The existing `bench/scheduler.bench.ts` was also rerun with `N=1000` on this checkpoint: no-match claim pass 189.0 ms, board read 136.6 ms, and calling blockers individually outside a pass 1605.1 ms. The earlier same-harness historical figures above were lower. Concurrent machine load and different dates limit attribution, but repeated budget reads are a concrete optimization target; no claim of no performance regression is made.

## Budget display cache (2026-11-07)

Budget displays now share one ephemeral read snapshot per synchronous coordinator pass: today's ledger totals, every held reservation's unspent amount, and aggregated lifetime spend per task. Task-specific allowances use those integer-micro-dollar totals. Local midnight, same-connection writes (`total_changes()`), external commits (`PRAGMA data_version`), observed transaction-state changes and existing coordinator invalidation discard the snapshot. The reader and its maps are discarded when the pass ends. Reads outside a pass remain fresh. `reserve()` never accepts a snapshot or displayed allowance: it recomputes under the existing write transaction, including reservations made by independent processes. No process-lifetime or ownership gate changed, and the cleanup-failed lookup remains fresh on each blocker call.

A paired rerun against immutable checkpoint `cfc5d31` on the same macOS arm64 / Node 24.22.2 host measured:

| Existing scheduler harness, `N=1000` | Checkpoint | Display cache |
| --- | ---: | ---: |
| No-match claim pass | 115.2 ms | 84.2 ms |
| Board read | 119.6 ms | 88.0 ms |
| Individual blocker calls, outside a pass | 666.3 ms | 645.5 ms |

| API harness, 1,000 tasks / 10,000 events | Checkpoint median / p95 | Display cache median / p95 |
| --- | ---: | ---: |
| Board API | 134.2 / 220.4 ms | 78.7 / 115.0 ms |
| Registry API | 0.235 / 0.767 ms | 0.100 / 0.135 ms |
| Last 100 events | 0.318 / 0.519 ms | 0.127 / 0.160 ms |
| Queue admission | 26.6 / 40.7 ms | 22.4 / 36.9 ms |

The scheduler harness uses one warmup and five timed repetitions; the API harness uses five warmups and 100 samples. These runs were sequential with no tests launched by this task during the paired measurements; other host activity was not controlled. Baseline budget/coordinator sources were loaded from `git show cfc5d31` in memory, without a copied checkout. A loader hook was removed before execution, and deterministic `Math.random` suffixes were used only while creating fixtures, then restored before warmup/timing. This avoids an observed pre-existing `shortId` collision during rapid task seeding; measured operation bodies and sample counts were unchanged. `scripts/benchmark.ts` now separately retries only that specific rolled-back fixture collision, at most four times, and reports the retry count. Both paired API runs reported zero retries.

Board API median fell 41.4% and p95 fell 47.8% in this pair; no provider calls were made and no provider-cost savings were measured. End-of-run RSS increased from 165.6 to 199.8 MiB, so these numbers do not establish a memory improvement. Registry/event paths and individual blocker calls do not use the new pass snapshot; their changes illustrate measurement/load variability and should not be attributed to it. The historical 47/50 ms scheduler/board numbers remain faster than these reruns; this is not a claim of recovering historical performance or a general no-regression guarantee. The harnesses seed no usage ledger history or attached budget holds, so they do not characterize large-ledger or many-held-run scaling.

Every benchmark ran under a wrapper-owned `mkdtemp` TMPDIR removed in `finally`; the scheduler's otherwise-unremoved fixture root was contained within it. New tests verify a single aggregation for 100 repeated display reads, cache/fresh equivalence, same-connection and external-process reserve/usage/release refreshes, two independently warmed process displays racing for one $5 budget, coordinator board updates within a pass, rollback exit, and midnight with lifetime task spend and cross-day holds retained. Detailed commands, raw results, checks and limitations are in `outputs/hillclimb-2026-11-07/gpt-budget-performance.md` and its adjacent `budget-*.log` evidence.

Validation for this bounded change: typecheck, build and all 299 tests passed; the full test process exited naturally in 98.8 seconds without force-exit.

The production test command now logs its executable, Node/platform, arguments and completion code and exits naturally; `npm test` no longer uses `--test-force-exit`. Package smoke verification (`node scripts/package-smoke.mjs`, after building) creates a temporary tarball install and checks version, help, packaged dashboard and doctor without a personal hub. `YM_SMOKE_NODE=/path/to/node` selects the installed runtime to test. Both Node22.23.4 and24.22.2 passed this check. Test directories are removed in finally cleanup.

A separate stress-fixture failure exposed collisions in millisecond/three-character IDs. New short IDs use 64 bits of cryptographic randomness, retaining existing prefixes; a fixed-clock/fixed-weak-RNG regression exercises tight creation without duplicate IDs.
