# Research: existing orchestrators, complaints, and fork options

Researched 2026-11-03. Sources are linked inline.

## The tools

| Tool | Shape | What it gets right | Where it hurts |
|---|---|---|---|
| **Gas Town** ([repo](https://github.com/gastownhall/gastown), MIT) | Go CLI + tmux. An LLM "Mayor" plans; LLM "Deacon/Witness" roles supervise "Polecat" workers. State in Beads (git-backed issue ledger). | Persistent work state across restarts, agent identity and attribution, a merge "Refinery", many runtime presets. | Supervision by LLM is the main token cost ("ultimate token burner"; Yegge calls it a "cash guzzler"). Beads as operational state is fragile ([issue #764](https://github.com/gastownhall/gastown/issues/764): state loss, wrong-database routing, non-namespaced tmux sessions killing other towns). One user ended a week with "three mayors, 141 orphaned Claude Code processes" ([blog](https://tenzinwangdhen.com/posts/gastown-good-bad-ugly)). Heavy install (Go, Dolt, tmux, ICU). "Too complex" is the most common verdict ([HN](https://news.ycombinator.com/item?id=46458936), [Maggie Appleton](https://maggieappleton.com/gastown)). |
| **Symphony** ([repo](https://github.com/openai/symphony), Apache-2.0) | A spec (SPEC.md) plus an Elixir reference implementation. Polls Linear, one Codex agent per issue, isolated workspace, proof-of-work (CI, review, video). | Spec-first and language-neutral; `WORKFLOW.md` hot-reloads; concurrency and turn caps; "manage work, not agents". | Codex + Linear only. One agent per ticket with no coordination between them: overlapping tickets collide at PR time. Full clone per issue (disk). "An orchestration demo, not a product" ([review](https://studiojin.dev/blog/openai-symphony-review/)). |
| **Overstory** ([repo](https://github.com/jayminwest/overstory), MIT) | TypeScript/Bun. Coordinator → leads → scout/builder/reviewer/merger in worktrees, tmux, SQLite "mail", hooks as guards, 4-tier merge resolution. | Pluggable runtime adapters; honest [STEELMAN.md](https://github.com/jayminwest/overstory/blob/main/STEELMAN.md) on swarm risks. | Its own list: compounding errors, cost amplification, debugging across worktrees, infrastructure sprawl (tmux, SQLite WAL, watchdog daemons, stale PID files, hooks as failure points). Hooks only bind Claude Code. |
| **OpenWeft** ([repo](https://github.com/NeuraCerebra-AI/openweft), MIT) | TypeScript CLI. Backlog → "Work Briefs" → plans with file manifests → phases scheduled by manifest overlap → worktrees → ordered merges with bounded agent conflict resolution. | The best scheduling ideas: manifest overlap, hot-file isolation, blast-radius scoring, post-merge re-analysis, failure taxonomy, PID identity with start time. | Batch-only (not usable from inside an interactive session), Codex + Claude only, no multi-machine, `budget.*` settings are accepted but **not enforced**, requires Node 24. |

Other relevant projects found:
coordination layers over MCP ([agent-coord](https://github.com/ThatHunky/agent-coord), [Axis](https://github.com/VirSanghavi/axis), [Coordinaut](https://github.com/LevDomasnih/coordinaut), [agent-comm](https://github.com/keshrath/agent-comm), [Foremerge](https://github.com/naw103/foremerge)),
messaging ([Agent Relay](https://github.com/agentworkforce/relay)),
remote execution ([Talaria](https://github.com/MFoxx/talaria) over SSH/Tailscale, [ace Fleet](https://acehq.dev/features/fleet), [Codeman](https://github.com/mrsharpoblunto/Codeman)),
and loop detectors ([loopstop](https://github.com/Ayubjon/loopstop), [OpenRouter doom-loop detection](https://openrouter.ai/docs/agent-sdk/call-model/doom-loop-detection)).

## DeepSeek Harness Creator Mode

[Mashable](https://mashable.com/tech/deepseek-creator-mode-plugins), [mode docs](https://agentspulse.github.io/tutorials/deepseek-harness-modes-explained).
Harness (MIT, Aug 2026) is built on "everything is a plugin" (Cordis). Creator Mode lets the agent write a plugin from a chat request, install it, and verify it live; custom "presets" are just plugin compositions created by asking.

What Yardmaster takes from it:
- **Plugins with the same shape as built-ins.** Agent adapters and notifiers are plugins (`~/.yardmaster/plugins/<name>/index.mjs`), validated by a schema.
- **Creator mode for the orchestrator itself.** `ym plugin new aider --describe "drive the aider CLI" --with claude` scaffolds the plugin with a guide, has *your own* agent write it, then runs the contract test (`ym plugin test`) before it is accepted. Teaching Yardmaster a new agent takes one sentence.
- **Presets.** `frugal | balanced | fast | careful` change concurrency, model sizes, budgets, approval and scope strictness in one word.
- Caution carried over: generated plugins run with your permissions, so they are loaded only from your home directory and must pass the contract test.

## Real developer complaints, and the design answer

| Complaint (source) | Yardmaster's answer |
|---|---|
| Orchestrator ignored written limits and retried its own load-caused timeouts for 2 hours: ~12% of a weekly Max allowance, nothing merged ([claude-code#101650](https://github.com/anthropics/claude-code/issues/101650)) | Limits are enforced by code, not prompts: per-machine `maxParallel`, per-agent caps, CPU/memory gate, per-task and daily USD budgets that kill the run. Identical failures (normalized error fingerprint) stop after 2 tries instead of using every attempt. |
| Parallel `isolation: "worktree"` agents commit to each other's branches; inherited `GIT_DIR` leaks ([claude-code#83311](https://github.com/anthropics/claude-code/issues/83311)) | Every child gets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, etc. stripped; each agent is spawned in its own process group with an explicit cwd; `git worktree add` is retried on lock contention. |
| "An agent saying done is a message about itself" ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1x92aeq/)) | Done is measured: commit, real diff, no conflict markers, scope check, and the repo's own verify commands. "Finished but changed nothing" is a failure. |
| Merges and gates eat the day: re-gating whenever main moves, CPU contention from parallel tests ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1xhgyrx/)) | Re-verify after merge only when the base actually moved; verification has its own concurrency limit (`verifyParallel`); new tasks branch from the integration head so they start from merged work. |
| Intent and file conflicts between parallel agents ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1wpixl9/), [Foremerge HN](https://news.ycombinator.com/item?id=49789356)) | Three layers: declared or inferred file scopes block overlapping tasks before they start; live diff polling pauses the later of two agents that touch the same file; merge conflicts go back to the agent with the newer work merged in (bounded rounds). |
| Lockfile churn across worktrees ([dev.to](https://dev.to/naw103/running-multiple-claude-code-agents-in-parallel-what-worktrees-cannot-see-4le7/comments)) | `hotFiles` (lockfiles, migrations, CI) are flagged and serialized. |
| Parallel subagents amplify tokens; compaction loops ([codex#33196](https://github.com/openai/codex/issues/33196)) | Deterministic watchdog: same call N times, A-B-A-B oscillation, repeated tool error, silence, waiting on a question, runtime cap. Zero tokens spent on supervision. |
| 141 orphaned processes; stale PID files ([Gas Town](https://tenzinwangdhen.com/posts/gastown-good-bad-ugly), Overstory) | Process groups + pid/start-time identity; on hub restart, orphaned agents are killed and their tasks resume from the saved worktree; leases return work from vanished machines. |
| People run agents on several machines that don't know about each other ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1x92aeq/)) | One hub, many `ym worker`s. Commits travel as git bundles over the hub API, so no shared remote or SSH between machines is needed. |
| Monitoring is cycling through tabs ([Abrahms](https://justin.abrah.ms/blog/2026-01-05-wrapping-my-head-around-gas-town.html)) | One dashboard with a plain-language "Needs you" list, and desktop notifications. |
| Gas Town: "if you're not Stage 7 you won't be able to use it" | `ym add "plain English"`, scope inferred from the request, model size inferred from the request, presets, `ym demo` with a fake agent. |

## Fork or build?

- **Fork OpenWeft**: the closest fit (TypeScript, MIT, good scheduler), but its core is a batch pipeline (plan everything, then run phases). Interactive sessions, multi-machine, live overlap, and budget enforcement would touch nearly every module. Adopted its ideas instead (manifest overlap → scopes, hot files, failure taxonomy, PID identity).
- **Implement Symphony's SPEC**: possible later as a *tracker adapter*: Linear/GitHub issues become Yardmaster tasks. The spec's single-agent-per-issue model sits fine on top of Yardmaster's scheduler.
- **Fork Gas Town or Overstory**: rejected. Their supervision model (LLMs watching LLMs, tmux everywhere) is the cost and fragility users complain about.

Decision: a small, new core (zero native dependencies; Node's built-in SQLite) that borrows the best ideas, and stays compatible: MCP for any agent, CLI adapters for any headless runner, plugins for the rest.
