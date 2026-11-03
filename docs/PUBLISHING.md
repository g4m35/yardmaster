# Releasing Yardmaster

Every release goes out two ways:

| Channel | Who it's for | Needs |
|---|---|---|
| **Standalone binary** (GitHub Releases + `install.sh`) | Anyone on macOS (Apple Silicon) or Linux, no Node required | Nothing: the release workflow builds and attaches it |
| **npm** (`npm install -g yardmaster`, `npx yardmaster`) | People who already have Node (most Claude Code / Codex users) | An `NPM_TOKEN` repository secret, once |

## Cut a release

1. Bump `version` in `package.json` and `src/version.ts`, and add a section to `CHANGELOG.md`.
2. Merge to `main`, then tag: `git tag v0.3.0 && git push origin v0.3.0`.
3. The **release** workflow builds the binaries on macOS and Linux, smoke-tests them, attaches them with `install.sh` to a GitHub release, and publishes to npm if the token is set.

## Turn on npm publishing (one time)

1. Create a free account at npmjs.com (no organization needed; the package is the unscoped `yardmaster`) and turn on two-factor authentication.
2. npmjs.com → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**: packages read and write, all packages (the first publish creates `yardmaster`).
3. GitHub → this repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**: name `NPM_TOKEN`, value the token.
4. Re-run the latest release workflow (Actions → release → Run workflow, with the tag) or push the next tag.

After the first publish you can switch to npm's tokenless "trusted publishing" for this repo in the package settings on npmjs.com.
