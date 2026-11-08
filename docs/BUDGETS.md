# Budgets

Yardmaster reserves allowance before starting implementation, review or `ym plan`. Concurrent workers share SQLite admission transactions, so two workers cannot promise themselves the same remaining dollars. These are **admission limits and reactive stops**, not provider-enforced hard caps.

Set budgets in `yardmaster.json` (or the global configuration):

```json
{
  "budget": { "perTaskUsd": 3, "dailyUsd": 5 },
  "review": { "budgetUsd": 1 }
}
```

`ym add "your task" --budget 2` overrides the cap for that task. A task's implementation attempts and reviews share its total cap. Planning has its own phase allowance, using `budget.perTaskUsd`, and shares the fleet's daily allowance. Daily spend is fleet-wide against the admitting project's configured daily cap; days follow the host's local calendar. Planning may be charged even when nothing is queued.

## What starts, and what waits

Admission reserves the smallest applicable amount:

```
amount = min(phase cap, task remaining, daily remaining)
task remaining = task cap - observed task spend - task's unspent held allowance
daily remaining = daily cap - today's observed spend - all unspent held allowance
```

Amounts use integer micro-dollars. A phase waits if less than one cent remains. Implementation can receive a partial allowance: with a $5 day and two $3 tasks, concurrent claims receive $3 and $2. A third waits. The actual reserved amount is passed to the CLI and used by the reactive monitor, including resumed runs; Yardmaster does not add earlier session spend to the CLI cap.

Reservations stay held while preparing, running, verifying, or waiting for review. Review startup releases the implementation hold using its confirmed-exit proof and reserves the remaining task/day allowance in the same transaction. Its allowance is additionally limited by `review.budgetUsd`. Required review blocks completion when admission fails or the reviewer is canceled, fails, or returns an unreadable verdict. Optional review reports the failure and may continue. Every reported reviewer cost still counts.

A claim's generation advances only after admission succeeds. Raising a cap permits a new admission; it does not reopen a released reservation, revive a canceled task, or authorize an old worker to launch. A budget blocker appears in the normal queued-task waiting reason.

Unlimited settings use `null`. With no task, phase or daily cap, a reservation still tracks the run but promises no finite amount. With only a finite daily cap, an uncapped implementation holds the whole remaining day; add task caps to admit concurrent tasks. An uncapped phase already running blocks new finite admissions until its exit is confirmed.

## Enforcement and unknown spend

| Mode | Behavior | Limitation |
|---|---|---|
| `native_cap` | Claude Code receives the reserved amount as its own CLI spending cap; Yardmaster also stops on reported overspend. | Yardmaster has not verified provider enforcement. |
| `reactive` | Built-in metered adapters are stopped after a usage report exceeds the reservation. | Spend between reports, during termination, and reported late may overshoot. |
| `admission_only` | Custom/text adapters and Cursor have no declared usage guarantee; allowance is reserved before launch. If they emit recognizable usage, it is still recorded. | Unreported spend is unknown and cannot be bounded after launch. |

An unknown reading is never evidence that a phase was free. A run with no measured usage remains labeled unknown. Once that run exits, its unspent reservation is returned without inventing a dollar charge. JEV effort-judge calls report no cost and remain outside the ledger and every budget. Interactive-session spend (`tasks.session_cost`) is also outside this automated-run ledger. Provider invoices may therefore exceed Yardmaster's observed totals.

The overshoot bound for a metered run is the spend between its last report under the reservation and the report triggering the stop, plus termination spend and late reports. The day's bound is the sum of these per-run overshoots. Unmetered runs have no visible spend or finite overshoot bound.

## Release and recovery

Only confirmed process-group exit releases an attached reservation. The managed runner and planner register process identity, wait for the supervisor's reaped result, record final usage, then acknowledge exit. Invalid plans, nonzero exits, cancellations and malformed reviews keep their reported spend and release only after that proof. An accounting failure keeps the hold rather than silently making unobserved allowance available again.

A setup failure before a run attaches can release an unattached reservation as `no_launch`. Cancellation also releases unattached holds because no terminal task may attach or launch one. Lease expiry, requeueing, reclaim, task status, and a larger budget are not exit proofs. Holds from prior days still subtract from today's allowance. Orphaned or disconnected runs may therefore stop further admissions even after their task is requeued.

`cleanup_failed` specifically retains its hold. A worker recovery acknowledgment can clear that status only with a matching recorded PID/start-time identity and its original machine/generation, or with an exact non-spawning `noLaunchPhase` proof when no PID was recorded. Process recovery must independently establish the group's exit before that acknowledgment releases allowance. Recovery code that only changes a run's status does not release a hold. If recovery has no recorded identity, the hold remains for investigation.

## Accounting and upgrade behavior

Each absolute usage snapshot has a strictly increasing sequence per run. The ledger inserts a signed delta from the previous measured totals. Duplicate and reordered snapshots do nothing; a provider total can correct an estimate downward. Unknown snapshots advance the sequence without erasing measured spend or tokens. Task totals and run totals use the ledger's returned deltas/totals in one transaction. Late observations remain tied to the original run identity, so they charge real spend without changing a newer claim's lifecycle.

Daily admission uses the day a delta was observed, rather than the run's starting date. Spend reported after midnight counts on the new day. A downward correction can only offset that run's spend already counted on the same day. A correction of yesterday's estimate cannot create today's allowance. There is one bound: if that run has already reported spend today, a correction to yesterday's estimate may net against today's spend, undercounting today by at most that correction.

Schema 10 upgrades automatically after schema 9. It preserves released schema-5 task/run data through the existing migrations, backfills usage at each run's current sequence, and creates legacy holds for `running`, `lost`, and `cleanup_failed` runs. The backfill's day is the run's original local start day, matching the pre-upgrade accounting rule; future snapshots use observation day. Existing live uncapped runs block finite admissions until exit is confirmed. Migration is atomic and repeat opening does not duplicate history or holds.

## Lifecycle integration

`src/budgets.ts` implements `reserve`, `attachRun`, `requireHeld`, `release`, `recordUsageDelta`, and the read-only allowance/hold descriptions. It imports the shared transaction helper, avoiding a schema initialization cycle.

`Coordinator.claimNext` admits before allocating a generation; `startRun` binds the resulting reservation transactionally. `run.update` with `{ launch: true, patch: {} }` requires the current run owner and a held reservation and returns its actual allowance. Normal run updates cannot write usage totals. Legacy unsequenced `task.usage` fails with an upgrade instruction; workers must use absolute `run.usage` snapshots.

`run.start` for review can carry `implementationExited`, a confirmed-exit acknowledgment naming this claim's implementation run. Release, review admission, insertion and attachment share one transaction. `run.exit` accepts immutable historical run identity plus `reaped: true`; it cannot change a newer claim. `cleanup_failed` requires matching `process: {pid, startedAt}` or the recorded non-spawning `noLaunchPhase` proof. Recovery acknowledgment is replay-safe; only the original generation held specifically for remote recovery may be requeued, after its other live runs are gone. There are no raw worker reserve/release RPCs.

`ym plan` uses `planGoalManaged`, which calls owner-only `plan.start`, `plan.spawning`, `plan.spawn`, `plan.usage` and `plan.finish`. Spawn intent is durable before child creation (`setup:spawning`, `agent:spawning`, `verify:spawning`, `review:spawning`, `plan:spawning`), followed by normal phase plus PID/start-time registration. PID-less spawning windows remain held. The owner can explicitly attest a PID-less spawning hold stopped with `ym recover --confirm-stopped <task> --note "how process exit was verified"`; this writes an audit event and does not retry or revive work.

Scoped workers are denied all `plan.*` methods by the existing RPC allowlist. The low-level `planGoal` parsing helper remains available for callers that supply their own lifecycle; product CLI planning always uses the managed path. Legacy owner-only `spend.record` remains an accounting import for compatibility and is no longer used by planning.

`test/budget-reservations.test.ts` covers the primitive contracts. `test/budget-integration.test.ts` exercises real concurrent Coordinator/API admission across worker threads/connections, launch/exit fences, release refusal, legacy schema upgrades, review remainder/cancellation/malformed output, live planning failure accounting, and worker denial of administrative planning APIs. All executable fixtures are local fakes; no inference service is contacted.

An unregistered integration-process hold can be attested with `ym recover --confirm-stopped p-... --note "how every process was verified stopped"`. The owner-only operation records the statement and only clears a PID-less spawning window. It does not authorize resetting later commits or changed files in the merge worktree. Registered process identities require supervisor recovery.
