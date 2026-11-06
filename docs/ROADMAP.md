# Yardmaster roadmap

Based on a six-sector audit of v0.6.0 (architecture, performance, agent cost, security, product, tests and releases), November 2026. Items are ranked by how much they improve speed and cost, the two leading factors for this project. Security details stay out of this public copy until they're fixed.

## Where things stand

| Sector | State | Strongest point | Biggest gap |
|---|---|---|---|
| Architecture | Solid | One validated API, one git wrapper, no `any` | Database upgrade race; one 410-line function in `runner.ts`; swallowed errors |
| Performance | Fast small, slows at scale | About 0.5 s of overhead per task | Slows as task history grows; worktrees on big repos; import-graph cache memory |
| Agent cost | Good base, wrong default | Lean launch (61k to 14k tokens per turn), resumed retries | Sonnet for everything; no subscription-limit awareness; Codex metering |
| Security | Hardening planned | Token auth, input validation, no shell injection | Local containment of background agents |
| Product | Powerful, hard first run | Zero-token hooks, live overlap pause | No review or land from inside the agent; 8 to 10 setup steps |
| Tests and releases | Good coverage | 81% of lines, 26 s suite | Cleanup and merge rollback untested; release checks |

## Measured

| What | Number |
|---|---|
| CI minutes on a real repo's first push to main after the guard | 63 to 3 |
| One small task, Sonnet 5.5 vs Haiku 5.5 (list prices, inferred) | about $0.06 vs $0.004 |
| Picking the next task with 0 vs 20,000 finished tasks | 2.8 ms vs 381 ms |
| Creating a worktree in a 100k-file repo (reusing one) | 6 to 10 s (0.24 s) |
| Edit hook, standalone binary vs npm build | 92 ms vs 52 ms |
| Git processes per task | about 44 |

## Fix now (done in 0.7.0)

1. **Hardening batch** (details after release): one hub per home folder, a private home folder, no hub credentials in agent environments, task checks that add to the project's checks instead of replacing them.
2. **Database upgrades that can't crash** when several processes start at once, and a clear error for a database from a newer release.
3. **Config typos reported** with a "did you mean" suggestion, plus a generated reference of every setting.
4. **A stronger model before giving up** when a task fails the same way twice.
5. **Test and release guards**: hung test files are killed, release tags must match the version and sit on main, and npm publishes only after the GitHub release.
6. **Small correctness fixes**: RPC timeouts, ownership checks on task updates, honest "partial work saved" messages, and caps and budget tracking for the planner.

## Faster and cheaper

Done in 0.7.0: cheap-first routing, stopping the rescans of finished tasks, Codex metering and prices, binary hooks, one import graph per repo, leaving lockfiles out of reviews, lazy-loaded MCP and CI, no web tools in background runs. Still open: subscription limits, budgets for non-Claude agents, fewer git calls, worktree reuse on big repos, cache hit rate in the report.

| Change | Gain | Effort |
|---|---|---|
| Cheap-first routing for small tasks that have tests | about 90% on those tasks | M |
| Subscription limits: wait for the reset, use another agent meanwhile, stop on overage | no wasted retries | M |
| Stop rescanning finished tasks when scheduling | 381 ms to about 3 ms at 20k tasks | S |
| Codex: cheap-tier model, correct token counting, current prices | correct budgets and routing | S |
| Budgets enforced for Codex, Cursor, Gemini and cross-model reviews | caps that stop spend | M |
| Binary hooks through the lean hook entry | 40 ms less per edit | S |
| Fewer git calls per task | about 1.5 s per task at 100k files | M |
| One import graph per repo | about 380 MB less hub memory | S |
| Reuse worktrees on repos over about 20k files | 6 to 10 s per task | M |
| Lockfiles left out of reviews | no 15k-token lockfile reviews | S |
| Cache hit rate in `ym report` | makes caching measurable | S |
| Bundled npm build, MCP and CI loaded only when used | 30 to 40 ms per command | S |
| No web search or fetch for background agents by default | smaller prompts | S |

## Next features

1. **Review and land from inside your agent**: diff, full result and land as MCP tools; a diff view and Land button in the dashboard.
2. **Setup that doesn't break**: a stable `ym` path in agent configs, `ym doctor` checks every registration, and a guided `ym setup`.
3. **Sandboxed background agents** by default (done in 0.7.0).
4. **"Done means tested," even without tests**: `ym init` asks for a check, and untested work is marked.
5. **A CLI that explains itself**: per-command help, unknown flags rejected, next-step hints, short task ids, `ym land --squash`.
6. **More agents through the Agent Client Protocol**, and live runs of Cursor and Gemini before calling them supported.

## Remove or slim down

- Dead code: `installClaudeHook`, `imports._test`, `TERMINAL_RUN_REASONS`, unused imports; the `--with-hook` and `ym up` aliases.
- `postject`, once binaries use Node's built-in single-executable builder.
- `ym disk --dedupe` behind an experimental flag; `ym ci` loaded only when used.
- Fewer messaging MCP tools, once usage shows which ones agents need.
- A shorter README: one sentence, three bullets, a demo, then links.
- Database tables and logs that never shrink.

## Repo, tests and releases

- Tests for cleanup's keep-this-worktree checks, hub-restart recovery and merge-train rollback.
- Dependabot for actions and npm; actions updated off Node 20.
- CI matrix: macOS on Node 24, Linux on Node 22, 24 and 26.
- Build provenance attestations, one `SHA256SUMS` file, compressed downloads (123 MB to 25 MB).
- A safer installer, CONTRIBUTING, SECURITY.md and issue templates.

## Later

- Multi-machine: per-worker tokens, an explicit flag to listen on all interfaces, id validation on workers.
- Split `runner.ts` and `coordinator.ts` once the fixes above have landed.
- Homebrew tap, update notice, opt-in local models for trivial tasks.

## Who else does this

| Tool | Overlap |
|---|---|
| Bernstein (Apache-2.0) | Closest: worktrees, cross-model review, cheap-model router, MCP, 53 adapters, web dashboard with diffs |
| Agent Orchestrator | Open source; a lead agent plans and spawns workers in worktrees |
| Claude Code, Codex, Cursor 3 | Parallel agents within one vendor |
| Copilot Agent HQ | Several vendors' agents, GitHub's cloud only |
| Conductor, claude-squad, Orca | Local multi-agent apps without a planner, merge train or cost control |

Yardmaster is ahead on zero-token hooks, pausing agents that touch the same file, measured lean launches, CI cost control, multiple machines over plain git and a single binary. It's behind on diff review, the number of agents supported, npm and Windows.

## Updating this page

Edit this file and open a pull request. After it merges, `npm run site:deploy` publishes it to Vercel (see docs/PUBLISHING.md).
