# Spending less on CI

More agents means more pushes, and every push to a pull request runs your whole GitHub Actions suite. On private
repositories that drains the monthly allowance fast: GitHub Free includes $12 of Actions usage (2,000 Linux
minutes), Pro and Team $18 (3,000). One Claude Code session used up a 2,000-minute allowance in under three hours
([anthropics/claude-code#65944](https://github.com/anthropics/claude-code/issues/65944)).

Yardmaster attacks this from both ends: fewer pushes that start CI, and less CI per push. Nothing here needs the
Yardmaster hub, and it works for agents and people alike, because it sits in git and in your workflow, not in any
one agent.

## Where the minutes go

`ym ci audit owner/repo` reads up to 90 days of run history and shows it. In agent-heavy private repos we measured:

| Waste | Typical share | What fixes it |
|---|---|---|
| A push to `main` re-tests a file tree that already passed on its pull request | 15 to 20% | the **guard** |
| Failed runs, mostly an agent using CI to find out whether its change works | 10 to 25% | the **push gate** |
| Runs made pointless by a newer push to the same branch | 10 to 40% | push gate, push once |
| Each job is billed in whole minutes; many tiny jobs waste the remainder | 8 to 30% | fewer, longer jobs |
| macOS jobs on every pull request (about 10x the Linux price) | varies | run them on `main` only |

The audit prints the same breakdown for your repo, the workflows that cost most, and fixes ranked by value. Add
`--owner NAME` to cover every repo of an account, `--json` for scripts.

## 1. The push gate (your machine)

```sh
ym ci init
```

This installs a git `pre-push` hook in the repo (all worktrees share it, so every agent goes through it). On each
push it:

- **runs your checks first**, once per file tree. A failing push is stopped before it can start a failing CI run,
  and the agent sees the failure right away instead of minutes later. A tree that already passed (the same commit
  pushed to another branch, a rebase that changed nothing, or Yardmaster's merge train that already checked it)
  is never checked again. If you have stray files in your checkout, the exact pushed commit is checked in a
  temporary worktree that's removed afterwards.
- **warns when CI is still running** on that branch. The push restarts it, and the minutes already spent are lost.
  Set `ci.coalesce` to `block` to hold such pushes.
- **holds pushes to private repos** once the month's allowance is used up (see the budget below).

The checks are `ci.verify`, else `verify` from `yardmaster.json`, else what the repo obviously uses (`npm test`,
`cargo test`, `go test ./...`, `pytest`). An existing pre-push hook keeps running first; `ym ci uninstall` puts it
back. A repo that uses `core.hooksPath` (husky and friends) gets instructions instead of a silent change.

Escape hatches, for people: `YM_CI_SKIP=1 git push` skips the gate once; `YM_CI_FORCE=1 git push` pushes past a
budget or in-progress hold. `git push --no-verify` skips all hooks.

## 2. The guard (your workflow)

The guard is a GitHub Action that skips a workflow's heavy jobs when **this exact file tree already passed this
exact workflow**. Add three pieces to the workflow (`ym ci init` prints this):

```yaml
jobs:
  guard:                       # 1. decide (one 1-core job, about $0.002)
    runs-on: ubuntu-slim
    permissions: { actions: read, contents: read, pull-requests: read, statuses: read }
    outputs:
      skip: ${{ steps.guard.outputs.skip }}
    steps:
      - id: guard
        uses: g4m35/yardmaster@v0.4.0

  test:                        # 2. every expensive job
    needs: guard
    if: needs.guard.outputs.skip != 'true'
    # ...your existing job...

  record:                      # 3. remember which tree passed
    needs: [test]
    runs-on: ubuntu-slim
    permissions: { contents: read, statuses: write }
    steps:
      - uses: g4m35/yardmaster@v0.4.0
        with: { mode: record }
```

How it decides, and why it's safe:

- A pull request run tests the **merge** of the PR into its base, not the PR head. So the record step stores the
  tree it actually tested, as a `yardmaster/tested (ci.yml)` commit status on the PR head. After the PR merges,
  the run on `main` finds that status through the merge commit's pull request and skips only if the tree is
  identical, byte for byte. If anything else landed on `main` in between, the tree differs and the suite runs.
- A `push` run that already passed the same tree (say, the same commit pushed to two branches) also counts.
- Only statuses written by `github-actions[bot]` (your own workflow) or by someone with write access count.
  Pull requests from forks get a read-only token, so they can't write one.
- `workflow_dispatch` and `schedule` runs always run: use them to force a full run.
- If the guard can't decide (API error, missing permission), it says so and the suite runs. It never skips on
  doubt.
- Jobs skipped by `if:` count as passing for required status checks. If you require a matrix job, require a small
  summary job instead (a skipped matrix job is reported under its unexpanded name).
- Deploy jobs shouldn't depend on the guard; only gate the tests.

### Trust local results (opt in)

For solo developers and small teams who trust their own machines (the idea behind
[basecamp/gh-signoff](https://github.com/basecamp/gh-signoff) and Rails 8.1's local CI): set `"ci": { "trustLocal":
true }` in `yardmaster.json` and `trust-local: true` on the guard. After the gate's checks pass, Yardmaster posts a
`yardmaster/verified` status for the pushed commit, and the guard skips the suite if that status matches the
tree being tested and was posted by someone with write access (or a login listed in `trusted-users`). For a pull
request that only holds when the PR is up to date with its base, because otherwise the tested merge differs from
what you checked. `ym ci signoff [commit]` posts one by hand (after checking, if the tree wasn't checked yet).

Local machines aren't CI machines: services, operating system and secrets differ. Keep `trust-local` off for
anything where that matters.

## 3. The budget

```sh
ym ci budget            # this month's Actions spend against your allowance
```

With a token that can read billing (`gh auth refresh -s user` for a personal account, an admin token for an
organization) these are GitHub's own numbers. Otherwise Yardmaster estimates them from this month's job times in
your private repos at list prices. The gate reads the last result and refreshes it in the background, so a push
never waits on it.

```json
{
  "ci": {
    "budget": { "includedUsd": 18, "extraUsd": 5, "warnAt": 0.8, "blockPushes": true }
  }
}
```

`includedUsd` is your plan's allowance (default 12, GitHub Free). `extraUsd` is paid usage you accept on top.
When the allowance plus `extraUsd` is used up, pushes to private repos are held with a clear message (agents are
told to stop and ask you). Public repos are free on standard runners and are never held.

GitHub also has budgets of its own that stop usage at a dollar limit (Settings, Billing, Budgets and alerts). That
stops CI outright; Yardmaster's hold stops the pushes that would have spent it, and says why.

## 4. One pull request per batch

Yardmaster already merges finished agent tasks onto `yardmaster/integration` and checks them together. Instead of
each agent opening its own pull request (one CI run per task, plus every fix-up push):

```sh
ym ci ship              # push the integration branch and open (or update) one pull request
```

CI runs once for the whole batch. The push gate doesn't re-check it, because the merge train already did. This is
a merge queue for accounts that don't have GitHub's (it's only available to organizations on public repos or
Enterprise Cloud).

## What else is out there

| Tool | What it does | How it relates |
|---|---|---|
| [fkirc/skip-duplicate-actions](https://github.com/fkirc/skip-duplicate-actions) | Skips a run whose tree matches an earlier successful run | Compares the PR head tree, not the merge that was tested. The guard records the tested tree instead. |
| [basecamp/gh-signoff](https://github.com/basecamp/gh-signoff) | Local CI: sign off a commit from your machine | Same idea as trust-local; Yardmaster only signs trees whose checks actually passed |
| [redwoodjs/local-ci](https://github.com/redwoodjs/local-ci), [peters/localci](https://github.com/peters/localci) | Run your real workflow locally before pushing | Complementary: use one as your `ci.verify` command |
| Ubicloud, Blacksmith, Namespace, WarpBuild, RunsOn, self-hosted runners | Cheaper or free minutes | Complementary: lowers the price of every minute that's left. The audit counts these jobs separately |
| GitHub merge queue, Mergify | Batch pull requests into one CI run | `ym ci ship` gives the same batching where those aren't available |
