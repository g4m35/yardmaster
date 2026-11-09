# Dashboard

The dashboard serves one trusted owner from their personal hub. Two iterations are recorded here, newest first. The second replaced the layout of the first after the first real trial; the data and interaction contracts of the first still hold unless this section says otherwise.

## Iteration 2: departure board (0.9.2)

### Evidence

The first real task run through a private hub (one repository, one task at a time, approval before integration) showed what the owner actually met:

- The first screen was two cards for agents that were only installed, with registry vocabulary (managed, observed, unconnected, fresh) above everything else. The one running task sat below them.
- The task's name was 200 characters of its request, and its activity line was a shell command prefixed by the worktree path, so the visible part of both was noise.
- A row had no elapsed time, no phase inside its stage (setup, coding, checks, review) and no cost against its budget.
- "Approve and merge" was missing from the "Needs you" banner. The banner's items carry their reason as `why`, and the approve action looked for `attention`.
- The attempt was rejected for changing derived files outside its declared list. Nothing on the page could allow them; it took a raw API call.

### Direction

Hypothesis: an owner supervising a handful of tasks should be able to answer "what is happening, does anything wait on me, what did it cost" from one sentence and one row per task, without reading connection diagnostics. Putting the stage on each row, rather than giving each stage a column, keeps that true at any width and with one task or twenty.

1. **Departure board (selected).** A plain status sentence, then "Needs you", then one list of tasks. Each row carries its status and phase, a short name, who is working, a five-stop stage track, time and cost against budget. The five stages keep their counts in a compact line above the list. Connection records fold into "Agents and connections", which opens itself once when a record is stale or the registry cannot refresh. Activity, machines and cleanup sit in a side rail. Wrong if the core job becomes comparing many machines, or if stage throughput matters more than individual tasks.
2. **Refined five-column board (rejected).** Keep a column per stage and polish the cards. With one or a few tasks, four of five columns are empty, the cards are narrow, and below 1000px it already collapsed into a list. It answers "how many are in each stage", which the count line now does in one row.

The owner's earlier override stands: one framework-free HTML file, no external assets, native `button`, `dialog`, `details`, `select` and form controls; the component-library quota stays waived for this utility surface. Both colour schemes are authored (`prefers-color-scheme`), and every text and background pair is checked against WCAG AA in the rendered page.

### What changed

- **Status sentence.** "1 task in progress. Nothing needs you." A task waiting for approval is counted once, as needing the owner.
- **Rows.** Ordered nearest-to-merging first, then waiting, then finished. The phase comes from the latest run (`prepare`, `setup`, `route`, `agent`, `collect`, `verify`, `review_wait`, `review`); unknown phases show nothing.
- **Short names.** `taskTitle()` (first sentence, at most 96 characters) names new tasks from `ym add` and the dashboard; the page applies the same rule to titles stored by older versions. The full request stays in the task and in its detail.
- **Readable activity.** New activity lines drop the "cd into the worktree" prefix and the worktree path before they are clipped. The page also tidies lines written by older versions.
- **Task detail.** Status and phase, the five stages, then agent, time, cost against budget, attempt and files. Below: files changed so far, the full request, guidance, the activity log, history and technical details (branch, artifact SHA, working copy, and a `git diff` command for the exact change). Opened sections, the log's scroll position and unsent text survive the snapshot refreshes that rebuild the detail.
- **Allowed files.** When work is stopped for changing files outside its list, the detail names those files, adds them to the list in one click, and saves through `task.setScope`. The owner then chooses "Try again". A running attempt keeps the list it started with, so while one is in flight files can be added to the list but not removed.
- **Approval.** "Approve and merge" appears in the "Needs you" banner as well as in the detail.
- **Activity feed.** The latest eight events, with older ones opened in place by a button instead of a scroll box inside the page.

### Contracts added

`board.status` rows gain `budget`, `attempt`, `maxAttempts`, `phase`, `createdAt`, `startedAt`, `readyAt` and `needsApproval`. All are optional to the page, which still renders against a hub that omits them. `task.setScope({id, scope, by})` is owner-only (paired workers are refused like any unlisted method), normalizes and de-duplicates patterns, refuses finished and canceled tasks, refuses to take files away from an attempt in flight (its list is what keeps overlapping tasks from starting), clears the request identity like any request edit, and records an event.

Kept from iteration 1: every owner action (add, retry, approve, cancel, redirect, pause, resume, cleanup), the registry's literal states and unknown signals, stop gated on `capabilities.requestStop` and rechecked at click time, serialized refreshes with one trailing refresh per burst, stale-snapshot handling, focus containment and restoration in dialogs, and no pairing controls.

### Verification

`node --test test/dashboard.test.ts` runs the page's real script against a small DOM fixture: 20 tests, including row content and order, the status sentence, approval from the banner, folded connections, detail sections surviving refresh, and the allowed-files flow. Unit tests cover `taskTitle`, `activityText`, the new board fields and `task.setScope`.

Rendered evidence is in `design-verification/dashboard/`: `desktop.png`, `mobile-390.png`, `console.json`, `geometry.json` and `rendered-checks.json`, plus dialog, dark-scheme and 390px captures. It was captured in a hosted Chromium against a disposable fixture hub with invented data through an ephemeral tunnel; no personal hub, key or repository was exposed. The checks cover no horizontal overflow at 1440px and exactly 390px in every state, keyboard open, focus containment and return, contrast in both schemes, reduced motion and console output. Two limits: the capture browser cannot emulate operating-system settings, so the dark and reduced-motion captures force those media rules on rather than toggling the setting; and no screen reader was run.

### Still open

- Review runs do not record their effort, so the detail cannot show whether a review ran at the configured floor.
- A redirect is also stored as a repository lesson, which is more durable than a one-off instruction usually deserves.
- The detail lists changed files and gives a diff command; it does not render the diff.

## Iteration 1: registry and task detail (0.9.0)

The dashboard serves one trusted owner from their personal hub. Its reader wants to find a blocker, understand which connected agent owns work, inspect that exact task, and request a supported stop. Machines advertise installed clients; that alone is not evidence of a running agent. The audit screenshots in `outputs/audit-2026-11-07/` show a useful task board with incomplete process visibility and unverified dialog keyboard behavior.

## Direction and acceptance

Two bounded directions were considered before implementation:

1. **Task-first control view (selected).** Keep attention and the five existing task stages. Add a compact, readable registry above the task board; disclose detailed process facts in the same native detail dialog. This fits an owner checking a few machines, preserves task actions, and avoids making unknown telemetry dominate the first screen. Needs registry identity/capabilities and exact task ids. Risk: large inventories become long; current/history filtering and compact rows contain that. Wrong if the core job becomes managing hundreds of simultaneous machines.
2. **Machine-first fleet table (rejected).** Group processes under machines with model, effort, PID, phase and cache columns. Better for a fleet operator comparing machines, but sparse native signals would produce a wide table of unknowns. Mobile would require another layout and the owner's next task action would be buried. Needs reliable machine grouping and much richer telemetry. Wrong for this small personal hub and current evidence.

Hypothesis: retaining attention-first task actions while placing truthful current-agent summaries immediately above work will let the owner identify an agent's state and reach its exact task without interpreting installation inventory or fabricated progress. A two-step path (Inspect agent → Open task) exposes process context without cluttering the board.

Acceptance contract: preserve add/retry/approve/cancel/redirect/pause/resume/cleanup/feed/project flows; fetch `registry.list` from the authenticated same-origin RPC; show managed/observed/stale/unconnected and freshness literally; expose unknown model/effort/phase/PID/cache in detail; gate stop on `capabilities.requestStop`; never claim stop acknowledgment from a successful request. Coalesce SSE refreshes, serialize refresh requests, ignore old-project responses, and preserve form drafts/selection/focus. Detail is a labelled native modal dialog with Escape, focus containment and restoration. Desktop and exact 390px viewports must remain legible without horizontal overflow, with visible focus and reduced motion. Errors must preserve the last snapshot and show its age, plus a retry/setup path. No external assets, telemetry, inference, or owner-hub connection.

The frozen machine contract is `design-verification/dashboard/acceptance-contract.json`. The contract and rendered artifacts are evidence, not release approval; the final verification and delivery gates still apply.

## Components and scope

The owner's explicit override preserves the framework-free single HTML file and waives Creative OS's component-library quota. Native `button`, labelled `select`, `details`, `dialog`, `fieldset` and form controls provide semantics and keyboard mechanics; source-owned layout/CSS supplies composition. Adding two libraries solely for a quota would increase runtime/dependency cost without solving an unmet interaction need. No framework, CDN, external asset, or new dependency is introduced. Existing small lamp/meter motion has reduced-motion fallbacks; no new animation is needed. Portfolio fingerprint/contact sheet is not applicable to this repair of one existing utility surface.

## Data and interaction contracts

`board.status({projectId: null|string})` remains the source for task actions, supervision, machines, spend and setup. `registry.list({})` covers all projects; a selected project passes `{projectId}` (not null, because the registry schema accepts an optional string). Each refresh reads those two endpoints concurrently; refreshes themselves serialize, with one trailing 250ms refresh for an SSE burst. The existing 10-second fallback snapshot and 2-second open-task log refresh remain. Log requests do not overlap; late logs and late detail/project responses are discarded. DOM fixture tests exercise these behaviors without a live hub.

Current connections exclude completed run history, retain stale sessions/runs and unconnected machine advertisements, and never infer that installation means connection. “Include recent runs” includes the registry's bounded run history. The snapshot receipt age, heartbeat age/freshness, truncation limits and unknown-signal coverage are explicit. An API failure retains the previous snapshot, labels its age, and suppresses stop buttons until the registry recovers. Stream reconnect status remains separate from successful snapshot reads. Unknown model/phase/effort/PID/cache values are visible in Inspect. Process identity and exact task ids stay linked; a task's artifact SHA is shown when supplied.

The task detail uses a native labelled `<dialog>` to provide browser modal semantics, background inertness, focus containment and Escape. The close handler restores the trigger by node or stable focus key after a refresh, with a top-level fallback. Guidance drafts live only in page memory per task, including caret selection; refresh snapshots preserve the most recent edits made while a request is pending. Add-work fields are not rebuilt by snapshot refresh. A successful redirect clears that task's submitted draft. Form controls are labelled; size choices remain a native fieldset/radio group.

`capabilities.requestStop` is rechecked via a fresh registry read when clicked. The control calls the existing task-scoped `task.control({id,action:'stop',by:'dashboard'})`; it does not kill a selected PID or promise native stop. Registry entries lacking capability do not get stop controls. Cancellation retains its existing two-click guard; retry, approve, redirect, pause, resume, cleanup, add work and event inspection remain. Pause-and-stop and request-stop acknowledgments explicitly say a stop was requested; later state is required to establish completion.

Pairing UI is deliberately deferred to keep this iteration bounded. `fleet.invite({projectId})`, `fleet.devices({})` and `fleet.revoke({id,invitation?})` are known owner RPCs, but this dashboard does not invoke them or claim paired-device configuration. It never automatically creates an invitation or stores a pairing code in the DOM. A future pairing control must create only on explicit click, require a selected project, display the returned secret once in a short-lived modal, clear it on close/expiry/visibility loss, and show metadata-only inventory/revocation. Remote private transport still requires separate configuration.

Remaining backend contracts: request-stop capability and mutation are separate requests; there is a read/mutation race because task.control has no expected run/generation field. The backend must remain authoritative about current ownership and stop semantics. Per-record acknowledgment/exit, native stop, attested effective phase/effort, native model identity, activity timestamps and cache counters cannot be manufactured in the UI. Registry read freshness is a heartbeat projection, not OS liveness. Rich accepted check/review evidence needs a typed backend contract before the UI can promise it. Fleet inventory metadata is not connection or transport health.

## Verification handoff

Deterministic checks execute actual dashboard JavaScript with a limited DOM/RPC fixture (`node --test test/dashboard.test.ts`). They verify controls, source data, refresh ordering and draft/focus preservation; they do not prove CSS layout or native keyboard behavior.

Rendered evidence is saved in two directories:

1. `design-verification/dashboard/` contains the frozen contract, desktop/390px/dialog/error PNGs and console/geometry assertions for managed/observed/stale/unconnected states, Enter/Tab/Escape focus, SSE guidance/caret preservation, reduced motion and stale-registry handling. Explicit boundary wrapping fixes an observed native-dialog focus escape.
2. `design-verification/real-hub/` binds the tested server to `22f76b8` and its source-tree object, and the dashboard bytes by sha256. Two actual `ym mcp` child processes use stdio SDK clients and real Hub HTTP. Browserbase verifies empty onboarding and zero counts, two-project isolation, 1440/390px rendering, dialog keyboard/focus, accessible labels and the explicit coding/checks/review pause policy. Sessions render as observed, with unknown model/process details.
3. The real HTTP 401 case removes the saved owner key and private controls. A separate auth-only stage passes; the combined-flow reload timeout is retained as a harness diagnostic and never counted as a passing check. No physical screen reader, installed editor window, native coding model or provider cache hit was tested by this browser fixture.

All browser work used disposable homes/repos, fake names and a narrowly scoped ephemeral tunnel, with no personal hub or installed settings changes. Both MCP clients, fixture hubs, tunnels and Browserbase sessions were closed. Release approval still requires the independent review, full verification and delivery gates.

Inspect facts include bounded persisted utility-child records (command basename, registration state and PID), without inferring OS liveness. Passive sessions keep unknown child information. Empty station counts explicitly display zero, rather than map callback indexes.
