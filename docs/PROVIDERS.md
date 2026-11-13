# Service providers

Yardmaster can use services you already have, while retaining an account-free
path through your own local commands. Coding-agent adapters and notification
plugins continue to work as before. Service plugins add capabilities without
requiring a vendor SDK in the core.

This release adds explicit CLI execution and a Node API. It does not
automatically replace task verification, schedule remote jobs, connect accounts
or bundle every vendor below. Existing task checks, review and integration
gates retain their current behavior.

## Choose by job

These are extension categories, not a list of installed connectors. Capability
IDs are project conventions; a plugin can offer several, and several plugins
can offer the same job.

| Service | Example capability | Account-free option | Optional integration |
| --- | --- | --- | --- |
| Research | `research.search` | Local source/document search | Search/documentation service |
| Build | `build` | Existing build command | Hosted runner or EAS |
| CI | `verify` | Existing test command | GitHub Actions, CircleCI or another runner |
| Browser | `browser.test` | Authorized local browser runner | Browserbase or another hosted browser |
| Device | `device.test` | User-owned simulator/device runner | Hosted simulator or device lab |
| Deploy | `deploy.preview` | Deployment script/self-hosted target | Vercel, Cloudflare or another host |
| Data | `data.check` | Local database/fixture checks | Managed database or storage |
| Observability | `observability.read` | Local logs/profile artifacts | Error tracking, metrics or tracing |
| Notification | `notification.send` | Local output/file | Existing notifier, webhook or messaging |

A missing browser/device provider is unavailable, not a simulated test pass.
Adapters must follow the user's session rules. In T3, use its bound device
commands; generic command execution is not permission to launch another
browser or take a different session's device.

## Start without accounts

Add commands you already use to `yardmaster.json`. Commands are executable and
argument arrays, not shell strings. They run from the project directory.
Discovery installs and downloads nothing.

```json
{
  "services": {
    "local": {
      "build": {
        "service": "build",
        "command": ["npm", "run", "build"],
        "protocol": "command",
        "locality": "local",
        "cost": "free",
        "timeoutMs": 600000
      },
      "verify": {
        "service": "ci",
        "command": ["npm", "test"],
        "protocol": "command",
        "locality": "local",
        "cost": "free"
      }
    }
  }
}
```

```sh
ym providers list
ym providers plan verify
ym providers run verify
```

Exit zero means the configured command passed; nonzero means failure.
Timeout, cancellation and incomplete cleanup mean `unknown`. A command result
does not prove physical-device acceptance or checks it never ran. Exit-code
commands receive no JSON input or provider options. Choose commands appropriate
for your machine policy: a constrained Mac can use a remote-only route instead
of running full suites locally.

## Connect an existing service

1. Create or install a trusted provider plugin. `ym plugin new my-ci --kind provider`
   creates a manifest and an unfinished helper that reports `unknown`. Implement
   it or use an independently tested provider; a scaffold is not a cloud connector.
2. Configure its existing CLI login or named environment variables. Keep secret
   values out of project files. Discovery checks presence, not authentication,
   entitlement, available credits or quota.
3. Enable it and set preferences/options in `yardmaster.json`:

```json
{
  "services": {
    "providers": {
      "my-ci": {
        "enabled": true,
        "options": { "project": "example", "runner": "small" }
      }
    },
    "routes": {
      "verify": {
        "prefer": ["my-ci", "local"],
        "locality": "any",
        "allowedCosts": ["free", "included"]
      },
      "device.test": {
        "prefer": ["my-device-lab"],
        "locality": "remote",
        "allowedCosts": ["included"]
      }
    }
  }
}
```

4. Inspect `ym providers plan verify --json`, then explicitly execute with
   `ym providers run verify --input request.json --json`. `--dry-run` prints the
   route without reading input or running a provider. `ym doctor` summarizes
   configured/installed providers and eligible routes.

Options are provider-owned JSON. Examples include workspace, region, project,
runner size, retention and native build profile. Providers validate their own
options; a supplied plan name is not evidence of actual account entitlement.

The first eligible candidate wins. Missing executables or required environment
variables can fall back before dispatch. Only explicitly listed candidates
participate; installation/enabling never adds a provider to a route. A remote-only
requirement cannot fall back to local execution. Without a route, only an
explicit `services.local` command is considered. `local` is reserved for project
commands, which must declare local/free execution.

`allowedCosts` defaults to `free`. Explicitly allow `included` to use an existing
subscription; metered/unknown usage needs its own configured policy. Cost classes
are provider declarations, not billing guarantees or hard caps. Included quotas
may run out. Unreported actual cost remains null. This CLI does not add service
charges to the coding-task budget ledger yet.

## Provider contract

An `index.mjs` manifest declares metadata. Its helper can integrate an installed
CLI, HTTP API, remote host or MCP bridge. Use absolute helper paths, since
commands execute in the project directory:

```js
import { fileURLToPath } from 'node:url';

export default {
  kind: 'provider',
  apiVersion: 1,
  name: 'my-ci',
  label: 'My existing CI',
  capabilities: {
    verify: {
      service: 'ci',
      command: [process.execPath, fileURLToPath(new URL('./provider.mjs', import.meta.url))],
      protocol: 'json',
      locality: 'remote',
      cost: 'included',
      requiredEnv: ['MY_CI_TOKEN'],
      timeoutMs: 600000
    }
  }
};
```

The helper receives one JSON request on stdin:

```json
{
  "apiVersion": 1,
  "requestId": "unique-operation-id",
  "capability": "verify",
  "input": { "commit": "source-revision" },
  "options": { "project": "example", "runner": "small" }
}
```

Write exactly one JSON object to stdout after reaching a known terminal state:

```json
{
  "status": "passed",
  "summary": "Requested checks passed on the specified revision.",
  "data": { "commit": "source-revision", "runId": "provider-run-id" },
  "artifacts": ["https://example.test/runs/provider-run-id"],
  "costUsd": null
}
```

Status is `passed`, `failed` or `unknown`. Accepted/queued remote work is not a
passed check. Missing cost is unknown. Artifact references are opaque; the core
does not fetch, publish or certify them. Provider acceptance tests must bind
results to the requested commit/build/environment and reject stale results.
Requests/results are limited to 1 MiB; store large artifacts separately.

The helper receives a small base environment and declared `requiredEnv` only.
Yardmaster owner tokens and inherited Git redirection variables are excluded.
Declared credential strings are redacted from returned fields, including nested
data. Stderr is not printed by the core. This limits accidental disclosure; it
is not a sandbox. Plugins/helpers are trusted code with access to user files.
Discovery imports installed ESM manifests: do not install untrusted code merely
to inspect it. Keep secrets out of argv, options and outputs.

Owned local processes use existing timeout/cancellation and descendant cleanup.
A remote job can outlive its helper; adapters must manage their remote job/session
cleanup and report uncertain state honestly. Use requestId for service-supported
idempotency. After a dispatch failure, Yardmaster never retries or switches
providers automatically. Inspect service state before repeating an action.

`ym plugin test` validates manifests without invoking service commands. It is
not live-service certification. Duplicate provider IDs disable all copies
rather than choosing one by directory order. Protocol changes require a new
supported apiVersion.

## Optimization without lock-in

Explicit preferences reuse existing tools and reserve local compute for suitable
work. A connector can reuse compatible native builds, authorized sessions or
completed jobs after verifying identity and scope. Required checks/device
requirements must remain fixed when switching providers. A cache miss is not
permission to accept a stale artifact.

Next stages are scheduler resource leases, task-ledger service receipts,
dashboard controls and independently verified first-party connectors. Each
needs real-provider failure/cancellation acceptance before automatic routing.
The current router makes no measured cost/speed savings claim and creates no
subscription, remote session or infrastructure during discovery.
