# Review guide

## Rounds

- Round one reviews the whole PR diff against its base.
- Every later round reviews only what changed since the last reviewed commit (`git diff <last-reviewed-sha>..HEAD`), plus any earlier finding that commit claims to fix.
- Do not repeat a finding from an earlier round, whether it was fixed, accepted, or rejected with evidence. Raise it again only when the new diff reopens it, and say what reopened it.

## Risk tiers by path

| Tier | Paths | Expect |
|---|---|---|
| High | `.github/`, `action.yml`, `action/`, `src/ci/`, `install.sh`, `scripts/build-binary.mjs`, `src/process-ownership.ts`, `src/proc.ts`, `src/janitor.ts`, `src/worker-policy.ts`, `src/policies.ts` | The published action and release, CI skip decisions, process control and cleanup. Read every line and check the tests. |
| Medium | `src/` (other), `skills/`, `bench/`, `scripts/` (other), `package.json`, `package-lock.json` | Product behavior and dependencies. Check behavior and test coverage. |
| Low | `docs/`, `design-verification/`, `README.md`, `CHANGELOG.md` | Accuracy and consistency with the code. |
