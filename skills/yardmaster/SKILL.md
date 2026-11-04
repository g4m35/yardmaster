---
name: yardmaster
description: Run work in parallel across several coding agents without collisions, using Yardmaster. Use when a request splits into independent parts, when the user asks to "parallelize", "fan out", "run in the background", "use other agents", or when you need to know what other agents are changing in this repo before editing shared files.
---

# Working with Yardmaster

Yardmaster runs background agents (Claude Code, Codex, Cursor, OpenCode, Gemini) in their own git worktrees,
checks their work with the repo's tests, has a second model review risky changes, and merges results onto
`yardmaster/integration`. It never touches the user's branch.

## When to fan out
Split work when the parts touch different files and can be checked independently (a feature plus its docs,
several endpoints, a refactor per package). Keep it in this session when the parts change the same few files
or each step depends on seeing the last one.

## How to fan out well
1. Call `yard_add_tasks` once with all tasks. For each task give:
   - `title`: short, and `prompt`: self-contained (the background agent does not see this conversation),
   - `files`: the files or globs it will change. This is what prevents collisions; be specific,
   - `after`: keys of tasks it truly needs first (use `key` to reference tasks in the same call),
   - `tier`: `cheap` for docs and small edits, `strong` for tricky or risky logic, otherwise leave it out.
2. Call `yard_wait` with the returned ids instead of polling `yard_status`.
3. Report back with what merged and anything listed as needing the user.

## While editing yourself
- Files you edit are reserved for you automatically when hooks are installed. Without hooks, call
  `yard_claim_files` before editing shared files and `yard_release_files` when done.
- If an edit is blocked because another agent holds the file, work on something else or ask the user.
- `yard_who` tells you who is changing a path. `yard_send` leaves a short note for another task or session.

## Make the next agent better
When you learn something about this repo that would have saved time (a required build step, a convention, a
trap), record it with `yard_learn` and the files it applies to. Future agents get it in their briefing.

## Steering
`yard_control` with `redirect` and a `note` restarts a background agent with new guidance and keeps its work.
`retry`, `cancel`, `stop`, and `approve` do what they say.

## Pushing and CI
Every push to a pull request runs the repo's whole CI suite, and on private repos that costs the user money.
- Don't push to find out whether something works. Run the checks locally, fix, then push once when the change is done.
- If the repo has the Yardmaster push gate, `git push` runs the checks first and stops a failing push; fix what it
  reports rather than retrying. It skips trees that already passed, so re-pushing the same files is free.
- If a push is held because CI is still running or the month's CI allowance is used up, stop and tell the user.
  Don't bypass it (`YM_CI_SKIP`, `YM_CI_FORCE`, `--no-verify`) unless they ask you to.
- For work Yardmaster merged, `ym ci ship` pushes the whole batch as one pull request instead of one per task.
