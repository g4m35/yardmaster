# Contributing

Thanks for helping. Bug reports, small fixes and documentation improvements are all welcome.

## Before you start

For anything larger than a small fix, open an issue first so we can agree on the approach. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Needs git and Node 24, or Node 22.18 or later (they run TypeScript directly). Yardmaster itself supports Node 22.16 and later.

```sh
git clone https://github.com/g4m35/yardmaster.git
cd yardmaster
npm ci
npm run typecheck
npm test
```

`node src/cli.ts <command>` runs the CLI from source. `ym demo` (or `node src/cli.ts demo`) starts a sandbox with a fake agent, so you can try changes without spending tokens.

Tests use deterministic mock agents, temporary git repositories and a temporary `YARDMASTER_HOME`. They never need real agent accounts or tokens. To run one file: `node --test test/<name>.test.ts`.

## Pull requests

- Keep each pull request to one change, and add a test that fails without it.
- Match the existing style: small functions, Zod validation at boundaries, no `any`, and comments only where they explain why.
- Add a line to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- CI must pass on Linux and macOS with Node 22 and 24.
- Write user-facing text plainly: short sentences, no hype.

By contributing, you agree that your contribution is licensed under the project's [MIT license](LICENSE).
