# Releasing Yardmaster

Every release goes out two ways:

| Channel | Who it's for | Needs |
|---|---|---|
| **Standalone binary** (GitHub Releases + `install.sh`) | Anyone on macOS (Apple Silicon) or Linux, no Node required | Nothing: the release workflow builds and attaches it |
| **npm** (`npm install -g yardmaster`, `npx yardmaster`) | People who already have Node (most Claude Code / Codex users) | An `NPM_TOKEN` repository secret, once |

## Cut a release

1. Bump `version` in `package.json` and `src/version.ts`, and add a section to `CHANGELOG.md`.
2. Merge to `main` through a pull request (main only accepts pull requests whose `done` check passed), then tag: `git tag v0.3.0 && git push origin v0.3.0`.
3. The **release** workflow builds the binaries on macOS and Linux, smoke-tests them, attaches them with `install.sh` to a GitHub release, and publishes to npm if the token is set.

The workflow checks the tag first and stops before building anything if the tag doesn't look like `v1.2.3`, doesn't match `package.json` and `src/version.ts`, or points at a commit that isn't on `main`. Tags are protected, so a wrong tag can't be deleted and would burn its version number. A pre-release tag such as `v1.2.3-rc.1` makes a GitHub pre-release that never becomes "latest" (so `install.sh` keeps serving the stable one) and publishes to npm under the `next` tag. npm publishes only after the GitHub release succeeds. If a run fails after creating a draft release, re-running it finishes that draft; a published release is never changed.

## Turn on npm publishing (one time)

1. Create a free account at npmjs.com (no organization needed; the package is the unscoped `yardmaster`) and turn on two-factor authentication.
2. npmjs.com → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**: packages read and write, all packages (the first publish creates `yardmaster`).
3. GitHub → this repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**: name `NPM_TOKEN`, value the token.
4. Push the next tag. (Re-running an old release won't work: releases are immutable once published.)

After the first publish you can switch to npm's tokenless "trusted publishing" for this repo in the package settings on npmjs.com.

## Project site (Vercel)

The site is the roadmap, built from `docs/ROADMAP.md` into `site/dist` with no dependencies.

- Preview locally: `npm run site:build`, then open `site/dist/index.html`.
- Publish: `npm run site:deploy`. It builds, then deploys `site/dist` to the Vercel project `yardmaster` (created on the first run) as a production deployment. It needs the Vercel CLI logged in (`vercel whoami`) and an account whose billing is active.
- To update the site, edit `docs/ROADMAP.md`, merge it, and run `npm run site:deploy` again.
