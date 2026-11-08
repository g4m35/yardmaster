# Budgets: reservations and the observed-spend ledger

`src/budgets.ts` provides two SQLite primitives. The coordinator, runner, review, planning and API code call them; this module never launches, stops or reassigns anything.

- **Reservations** admit a phase (implement, review, plan) atomically against the task cap, the daily cap and an optional phase cap. A reservation stays held until its run's exit is confirmed, or until it is shown that nothing launched.
- **The usage ledger** turns each run's absolute usage snapshots into signed, sequenced deltas dated by the day each delta was observed.

## What a budget does and does not guarantee

| Enforcement | When | What limits spend |
|---|---|---|
| `native_cap` | The adapter passes the amount to the CLI as its own dollar cap (Claude Code today) | The CLI's own limit. Yardmaster has not verified that the provider enforces it. |
| `reactive` | The CLI reports usage (actual dollars or token estimates) | Yardmaster stops the run after a usage report shows it over its reservation. |
| `admission_only` | The CLI reports no usage (Cursor, generic text adapters) | Nothing after launch. The reservation only limits how much other work starts. |

None of these is a provider-enforced hard cap, and no text in the UI may say otherwise. The overshoot bound for one run is the spend between the last usage report under its reservation and the report that triggers the stop, plus any usage reported late. With an `admission_only` adapter, Yardmaster cannot bound or see the run's spend. The daily overshoot is the sum of those per-run overshoots, because every run's reservation already comes out of the remaining daily allowance.

JEV effort-judge calls are excluded: the protocol reports no cost, so that spend is unknown and outside every budget (`JEV_JUDGE_COST_NOTE`). Interactive-session spend (`tasks.session_cost`) is not in the ledger either.

## Admission rule

`reserve()` runs in one `BEGIN IMMEDIATE` transaction (or joins the caller's), so concurrent connections and processes serialize. It reserves

```
amount = min(phaseCap, taskRemaining, dailyRemaining)        (finite values only)
taskRemaining  = taskCap  - task's ledger spend - unspent part of the task's held reservations
dailyRemaining = dailyCap - today's observed spend - unspent part of every held reservation (any day)
```

and holds instead when `amount < minUsd` (default one cent). The unspent part of a hold is `amount - spend already recorded for its run`, so spend is never counted both as observed and as held.

Example: daily $5, two tasks capped at $3. The first reserves $3 (basis `task`). The second reserves $2 (basis `daily`) with the default minimum, or holds if the caller passes `minUsd: 3` because its policy needs the full task cap. A third holds either way. For implementation we recommend `minUsd` = the task's remaining cap so a run never starts with less than its budget and then stops early; reviews can accept a partial allowance.

Unlimited settings:

- Task, phase and daily all null: `amountUsd: null`, basis `unlimited`. Always admitted and recorded, so orphan tracking still works, but nothing finite is promised.
- Only the daily cap is finite: the whole remaining daily allowance is held, because an uncapped task may spend all of it. Uncapped tasks therefore run one at a time under a daily cap. Add a task or phase cap to run them concurrently.
- Only a task or phase cap is finite: that amount; the day is not consulted.
- A held reservation with no finite amount (admitted while uncapped, or a legacy hold for an uncapped task) leaves a finite cap nothing to promise until it exits.

Daily spend is fleet-wide and compared with the cap the caller passes (the project's `budget.dailyUsd`), as with the existing `spentToday`. Days are local calendar days.

Money is stored as integer micro-dollars, so concurrent amounts add up exactly. Inputs are bounded: dollar amounts are finite and within 0 to 1,000,000, ids are 1 to 200 characters, token counts and sequences are safe integers.

## Holds, release and orphans

A reservation only ever moves from `held` to `released`. Release takes one of two proofs:

- `{ kind: 'exited', runId }`: the attached run's row is no longer `running`, `lost` or `cleanup_failed`. The parent sets that status only after its process-group exit is confirmed.
- `{ kind: 'no_launch' }`: no run was ever attached.

Lease expiry, a new claim generation, requeueing and raising a budget are not proofs. An orphaned, disconnected or unreaped run keeps its unspent hold against both its task and the day, so a reclaim of the same task cannot reuse that allowance. A released reservation cannot be attached again; reserve anew. Reserving never changes a task's status, claim or generation, and refuses tasks that are `done`, `failed` or `canceled`.

## Usage ledger

`recordUsageDelta()` takes a validated absolute snapshot `{ runId, sequence, taskId, projectId, costUsd, tokensIn, tokensOut, provenance }`.

- `(runId, sequence)` is the primary key. A sequence at or below the run's highest recorded one is a duplicate or a reordered older snapshot: nothing is written and `applied` is false.
- The delta is `snapshot - sum of the run's earlier deltas` and may be negative, so a provider total that replaces an earlier estimate corrects it instead of adding to it.
- An `unknown` snapshot measured nothing. It advances the sequence and changes no totals, so it cannot erase measured spend.
- Each delta is dated by the day it was observed. Growth reported after midnight by a run that started the day before counts on the new day.
- For daily admission, a downward correction only offsets the same run's spend already counted that day (`day_cost_micros`). An estimate from yesterday corrected today never returns allowance today. Limitation: a correction to yesterday's estimate that arrives after the run has already spent today is netted against today's spend, so today can be under-counted by at most that correction.
- Rows are only inserted. The module issues no `DELETE` and no `UPDATE` of ledger rows.

## Parent call sequence

1. **Migration.** Append `budgetMigrationDDL` to `MIGRATIONS` in `src/db.ts` as one new entry after the schema-9 entry. `src/budgets.ts` imports only `type Db` from `db.ts`, so this adds no import cycle.
2. **Usage.** Inside `Coordinator.recordRunUsage`'s existing transaction, after the identity check and the existing `sequence <= usage_seq` return, call `recordUsageDelta(db, …)` (pass `taskId: null` for planning runs). If `applied` is false, return. Otherwise call `addUsage(taskId, d.costDeltaUsd, d.tokensInDelta, d.tokensOutDelta)` and store `d.totalCostUsd`, `d.totalTokensIn`, `d.totalTokensOut` as both `runs.cost_usd/tokens_*` and `runs.accounted_*`, with `usage_seq = sequence`. Use the returned values rather than computing deltas again, so task totals and the ledger cannot disagree. `observedSpendUsd(db)` replaces the `runs.started_at` sum in `spentToday`.
3. **Claim.** In `claimNextInPass`, after a route is chosen and before `advanceGeneration`, call `reserve(db, { phase: 'implement', projectId, taskId, taskCapUsd: task.budget_usd, dailyCapUsd: cfg.budget.dailyUsd, enforcement, minUsd })`. If it is not `ok`, skip the task and surface `reason` as its blocker. Return the reservation id with the claim. `blocker()` may use `readAllowance()` for display; only `reserve()` decides.
4. **Start.** In `startRun`'s transaction, after inserting the run row, call `attachRun(db, reservationId, runId)`. Before spawning, the runner obtains `requireHeld(db, runId)` (through an owner-checked API method) and launches with `budgetUsd = amountUsd`, or no budget argument when it is null. A missing reservation fails the launch.
5. **Run monitor.** Stop when this run's metered spend exceeds `amountUsd` (reactive). Because the amount already came out of the daily remainder, this also enforces the day without a separate daily check in the loop.
6. **Release.** After the process group's exit is confirmed: update the run status, then `release(db, id, { kind: 'exited', runId })`, preferably in one transaction. If the claim ends before a run row exists (setup failure, cancel, lost claim), `release(db, id, { kind: 'no_launch' })`. Never release on lease expiry or reclaim; the janitor's existing exit confirmation (`run.exit` with `reaped: true`, local reaping) is the trigger.
7. **Review.** After the implementation run's exit is confirmed, in one transaction: release the implementation reservation, then `reserve(db, { phase: 'review', …, phaseCapUsd: config.review.budgetUsd })`. The review gets `min(review cap, task remaining, daily remaining)`. If it holds, the review is skipped with that reason, and strict review blocks. Then the same start, attach, `requireHeld`, launch and release steps, releasing even when the verdict is unreadable.
8. **Planning.** Create a live `runs` row (`role: 'plan'`, `status: 'running'`, `task_id: 'plan:<project>'`) and `reserve(db, { phase: 'plan', taskId: null, taskCapUsd: null, phaseCapUsd, … })`, then attach, then run the one-shot with `budgetUsd = amountUsd`. Record usage through the ledger. When the one-shot's process exit is proven, whatever the outcome (including a malformed plan), set the final run status and release. This replaces `recordSpend` for planning; cancellable exit proof stays with the one-shot supervisor.
9. **Enforcement label.** `native_cap` when the adapter passes the budget to the CLI, `reactive` when it emits usage events, otherwise `admission_only`.
10. **UI and API.** `describeReservation()` and `describeAllowance()` give plain status text (caps, provenance, held, unknown-usage counts, the JEV exclusion). `listHeld()` lists running and orphaned holds. Workers must not get raw reserve or release methods. Expose them only through owner-checked run lifecycle methods.

## Upgrade backfill

The migration copies each existing run with any usage, or `usage_seq > 0`, into the ledger as one row:

- `sequence = runs.usage_seq`, so the next accepted snapshot is still `usage_seq + 1`;
- `cost_usd`, `tokens_in`, `tokens_out` as the delta (the absolute totals, including planning rows written by `recordSpend` whose `accounted_*` columns are 0);
- `day` = the local day the run started, matching the old `spentToday` rule;
- `task_id` only for implement/review rows; planning rows take the project from `task_id = '<role>:<project>'`.

Runs that are `running`, `lost` or `cleanup_failed` at upgrade get a held `legacy` reservation attached to the run: the task's remaining budget plus what that run has already spent (its own spend consumes the hold), or no finite amount when the task is uncapped. They release through the same exit proof as any other run. An uncapped live run therefore blocks finite admission until its exit is confirmed. The whole migration is DDL plus `INSERT … SELECT` inside the migration transaction, so a failure leaves no partial tables or rows.

## Tests

`test/budget-reservations.test.ts` covers the daily-5/two-task-3 example, eight worker threads with their own connections reserving at once on one file, restart persistence, orphan holds across lease expiry and new generations, exit and no-launch release, the fail-closed launch gate, funding without resurrection, duplicate/reordered/corrected usage, midnight attribution, review and planning allowances, unlimited settings, input bounds, and the migration backfill and rollback.
