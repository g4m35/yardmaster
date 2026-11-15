# Security policy

Yardmaster runs coding agents and shell commands on your machine and holds an owner key for your hub, so security reports matter to us.

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, the Yardmaster version (`ym --version`) and your platform.

We aim to reply within a week and will keep you updated while a fix is prepared and credit you in the release notes unless you prefer otherwise.

## Supported versions

Fixes go into the latest release. Upgrade with the install script or by downloading the newest release from GitHub.

## What is in scope

- The hub's HTTP API, dashboard and event stream, including authentication and the owner key.
- Worker pairing, worker credentials and what a paired worker is allowed to do.
- How Yardmaster starts agents and commands: environment filtering, sandboxing and process cleanup.
- Worktree, receipt and cleanup paths (anything that could read or delete files outside Yardmaster's own folders).
- The GitHub Action, the install script and release artifacts.

Plugins run as trusted local code by design, and an agent with shell access can do anything your user account can; reports about those are welcome when Yardmaster makes the risk worse than documented.

## How Yardmaster protects you by default

The hub listens on loopback only, and remote use needs HTTPS or an explicitly acknowledged private network. Agents and checks do not inherit secret-shaped environment variables unless you list them. Background Claude Code agents run in its sandbox. Cleanup only removes what Yardmaster created and can confirm is safe. See [docs/INTEGRATION.md](docs/INTEGRATION.md) and [docs/FLEET.md](docs/FLEET.md) for details.
