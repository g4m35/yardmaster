# Architecture

```
  Your agent (Claude Code, Codex, Cursor,            Dashboard (browser)       CLI (ym ...)
  OpenCode, Gemini, T3 Code via its agents)               │ HTTP + stream            │
          │ MCP (stdio): yard_* tools                     │                          │
          ▼                                               ▼                          ▼
  ┌──────────────────────────── Hub (one per user, any machine) ─────────────────────────────┐
  │  API (one method table: HTTP, local, MCP and workers all call the same functions)        │
  │  Coordinator  ── SQLite (WAL) ── tasks, deps, locks, runs, events, messages, machines    │
  │  Scheduler: claimNext()  — deps, file scopes, locks, budgets, agent routing (atomic)     │
  │  Integrator: merge queue → yardmaster/integration (own worktree), re-verify if base moved│
  │  Janitor: leases, orphan processes, blocked deps, safe cleanup                           │
  │  WorkerLoop (local machine)                                                              │
  └──────────────┬───────────────────────────────────────────────────────────────────────────┘
                 │ HTTP: worker.claim / run.* / task.* , git bundles both ways
        ┌────────┴────────┐
        ▼                 ▼
  ym worker (laptop)   ym worker (GPU box) ...   each: WorkerLoop → runAttempt()
```

## A task's life

```
queued ──claim──▶ running ──agent exits──▶ verifying ──checks pass──▶ ready ──merge──▶ done
   ▲                │  watchdog/budget stop        │ checks fail              │ conflict / re-verify fails
   │                ▼                              ▼                          ▼
   └──── retry (failure as context, stronger tier) ◀─────────────────── back to its agent
                    │ same failure twice / attempts used / needs info
                    ▼
               needs_human  (plain-language reason, one-click retry)
```

1. **Create.** `task.add` dedupes exact requests against open tasks (ordered instructions, case, scope, dependencies and acceptance options; similar wording is not automatically discarded), validates `after` links, rejects dependency cycles, infers a file scope from paths mentioned in the request, and infers a tier (cheap/standard/strong) from the wording.
2. **Claim.** `claimNext` runs inside `BEGIN IMMEDIATE`, so any number of processes and machines can call it. A task is skipped if a dependency isn't done, its retry backoff hasn't passed, it is paused behind another task (`wait_for`), its scope overlaps an active task's declared scope *or files that task has actually touched*, a reservation (lock) overlaps it, or today's budget is spent. The router then picks the first installed agent with a free slot from the tier's preference list, skipping agents that keep failing on this project.
3. **Run.** `runAttempt` creates `~/.yardmaster/worktrees/<repo>/<task>` on branch `yardmaster/<task>` from the integration head, builds a short brief (task, owned files, files others are editing, summaries of finished prerequisites, notes, previous failure), and spawns the agent CLI in its own process group with leaky git variables removed. Output is normalized by the adapter into events: tool calls, results, text, usage, final result.
4. **Watch.** Every event goes through the watchdog and budget meter; a timer checks for silence, questions, runtime limits, cancel/stop requests, and polls the worktree diff to catch two agents editing the same file (the later one is paused and resumes after the first merges).
5. **Collect.** Commit (repo hooks still run), compute the real diff, reject "done but nothing changed", conflict markers, and (in `careful`) out-of-scope edits.
6. **Verify.** Run the repo's `verify` commands with a separate concurrency limit.
7. **Integrate.** The integrator merges ready branches one at a time into `yardmaster/integration` inside its own worktree, re-runs checks only if the integration head moved since the task started, and sends conflicts back to the agent (the newer work is merged into its worktree first). `ym land` fast-forwards your branch when you want the results.
8. **Tidy.** Merged worktrees and branches are removed immediately; `ym clean` handles the rest with a dry-run plan by default.

## Supervision and fencing

- **Watchdog** (per run, `src/watchdog.ts`): event-stream rules, deterministic.
- **Supervisor** (fleet, `src/supervisor.ts`): slow progress, unexplained queue stalls, abandoned reservations, budget burn-rate projection. Raises each warning once, clears it when the condition goes away.
- **Human controls**: `fleet.pause` / `fleet.resume` (global or per project; `stopRunning` parks agents through the same path as a hub shutdown: partial work committed, attempt not counted), and `task.control redirect` (guidance stored as the task's note; a running agent restarts with it and keeps its worktree).
- **Fencing**: runners write task state with `updateTaskIfOwner` (attempt number + assignee + running/verifying). Stale runners find out on their next poll and stop without writing. Uploaded bundles are accepted only from the owning machine and only if they contain the exact verified commit, and they land in `refs/yardmaster/incoming/*`, never in a checked-out branch.
- **Integration lock**: one mutex per project around every operation on the integration worktree; merges use the verified commit SHA; a marker in the database records the pre-merge head so an interrupted merge rolls back exactly; uncommitted changes without that marker are treated as a person's and are never reset.

## Making agents better (0.2)

- **Policies** (`src/policies.ts`) are applied when a task is created; the matched rule names are stored on the task and shown in `ym show`.
- **Review gate** (`src/review.ts`): after verification, `shouldReview` decides (strong tier, hot files, big diffs, or forced). `chooseReviewer` prefers a different model family. The reviewer runs read-only in the task's worktree and must answer with a JSON verdict; unreadable answers never block. Blocking issues requeue the task with the issues as its note (a review round, not a failed attempt).
- **Lessons** (`src/lessons.ts`): created on success after a failure (`lessonFromFix`), from review points that were then addressed, from redirects (widened to the folder), and by agents (`yard_learn`). `lessonsFor` ranks by file overlap, word similarity, source and track record; runs record which lessons they were given, and `creditLessons` rewards first-try successes and retires lessons that keep appearing in struggling tasks.
- **Learned routing** (`chooseAgent`): Laplace-smoothed verified rate per agent and tier on this project, list order as a weak prior, divided by relative cost^costWeight, with epsilon exploration of agents with little history.
- **Critical path**: queued tasks are ordered by priority, then the length of the longest chain of open dependents, then age.
- **Races**: `bestOf` creates N tasks in one `race_group` (distinct agents where available). Race members don't block each other's scopes; dependencies on any member are satisfied by the first one done; the integrator cancels the rest when one is ready.
- **Merge trains**: when two or more ready tasks were verified against an older base, the integrator merges them together and runs checks once; a failed train falls back to one-at-a-time.
- **Coupling** (`src/imports.ts`): the hub rebuilds an import graph per project when HEAD moves; `coupling()` finds direct import edges between scopes. In `warn` mode briefs get a "keep these signatures stable" note; in `serialize` mode the later task waits.

## Disk management

`src/disk.ts` measures free space and directory sizes (`du`, cached). Workers gate new claims on `disk.minFreeGb` and `disk.maxWorktreesGb` and, on the hub, trigger a cleanup pass. The cleanup planner adds `artifacts` items: allow-listed directory names that `git check-ignore` confirms are ignored and `git ls-files` confirms are untracked, inside worktrees that are kept but idle. Remote workers remove their own worktrees once the hub reports the task done.

## Why these choices

- **No LLM supervisors.** Loops, stalls, budget, and conflicts are detected by code. Watching ten agents costs nothing.
- **The integration branch, not your branch.** Agents never move your checkout. You decide when to land.
- **Scopes are conservative.** A false overlap only costs parallelism; a missed one costs a merge conflict and tokens.
- **Leases, not locks forever.** Session reservations expire. Expired task leases detect missing owners; uncertain process exit retains a recovery hold until identity-checked exit or audited owner confirmation.
- **Plain-language state.** Every status, wait reason, and failure is written for a person who doesn't read stack traces.
- **Zero native dependencies.** Node ≥ 22.16 (`node:sqlite`), git, and whatever agents you already have. Runtime deps: `zod` and the official MCP server SDK.

## Safety rules for cleanup

Yardmaster deletes only things it can prove are its own and empty:
- worktrees under its worktree root, linked to a known task that is finished, with no uncommitted changes and no commits missing from the integration or base branch;
- `yardmaster/t-*` branches for finished tasks whose commits are all merged;
- expired reservations, inactive sessions, old logs and temp files.

Everything else (user worktrees, unknown branches, dirty or unmerged work, locked worktrees, missing worktrees that may be on an unmounted disk) is listed under "kept on purpose" with the reason.

## Extending

- **Adapters** (`src/adapters/`): `build(ctx) → { command, args, stdin }` and `parse(line) → events`. Built in: Claude Code, Codex, OpenCode, Cursor Agent, Gemini CLI, any plain-text CLI via `agents.<name>.command`, and a mock for tests.
- **Plugins** (`~/.yardmaster/plugins`): adapters and notifiers in plain ESM. `ym plugin new <name> --describe "..." --with claude` has an agent write one and then contract-tests it.
- **MCP tools** (`src/mcp.ts`): `yard_status`, `yard_add_tasks`, `yard_wait`, `yard_task`, `yard_claim_files`, `yard_release_files`, `yard_who`, `yard_take_task`, `yard_finish_task`, `yard_send`, `yard_inbox`, `yard_control`. Short text replies to keep agents' context small.

## Process ownership and recovery

Owned launches receive a random inherited marker and a private fsynced receipt under `$YARDMASTER_HOME/process-owners`. After stopping the original process group, cleanup finds same-user descendants exposing that marker to OS inspection, including ordinary detached/new-session processes. UID, PID, start identity and marker are rechecked before signaling; uncertainty retains the receipt and worktree hold. Restart recovery uses the same receipt. Preserve this directory with the rest of the Yardmaster home. Process environment output is bounded transient memory and is never logged or persisted.

This is cooperative ownership tracking, not a hostile-code security boundary. Children clearing or hiding their environment, remote descendants and adversarial PID races are not contained. Unsupported or failed inspection cannot establish the marker-owned exit proof. Older receiptless records have only original-group evidence. A crash between OS spawn and receipt creation remains the existing spawning-window hold; lease expiry does not clear it. Use the native agent sandbox for its supported filesystem/network restrictions.

Native session identities are scoped by registration name, project and machine. Matching legacy identities remain stable; moving across projects cannot reassign their existing locks/claims. Hooks exempt only the canonical session returned by registration. MCP connections are independent unless the operator deliberately shares `YARDMASTER_SESSION` with that client's hooks.

Managed and native artifacts require configured verification commands before acceptance. A selected review that cannot complete or still objects stops for attention by default (`review.onUnresolved: "needs_human"`). Explicit `"proceed"` preserves advisory review; `review.required: true` additionally forces a review. Automatic selection and explicit `review: "never"` remain available when review is not required.

Learned routing groups outcomes by agent, tier and the configured model setting. Unknown native defaults and legacy agent-only aggregates do not count as current-model evidence. This is a configured identity, not proof of a provider alias's resolved revision or hidden client-profile configuration.
