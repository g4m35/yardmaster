# Service providers

Yardmaster can use services you already have, while retaining an account-free
path through your own local commands. Coding-agent adapters and notification
plugins continue to work as before. Service plugins add capabilities without
requiring a vendor SDK in the core.

Use `ym providers` for explicit jobs, or opt capabilities into `services.verify`
for task acceptance. `ym verify` runs the same committed-artifact checks without
starting the hub. Provider checks supplement configured shell checks and preserve
the review and approval gates. The built-in Browserbase connector is disabled
until configured. The other vendor names below describe integration choices,
not shipped connectors.

## Choose by job

These are extension categories, not a list of installed connectors. Capability
IDs are project conventions; a plugin can offer several, and several plugins
can offer the same job.

| Service | Example capability | Account-free option | Optional integration |
| --- | --- | --- | --- |
| Research | `research.search` | Local source/document search | Search/documentation service |
| Build | `build` | Existing build command | Hosted runner or EAS |
| CI | `verify` | Existing test command | GitHub Actions, CircleCI or another runner |
| Browser | `browser.verify` | Authorized existing browser-test command | Built-in Browserbase; other hosted browsers through plugins |
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

Commands receive a small base environment. List required variables such as
JAVA_HOME or DATABASE_URL in requiredEnv; unrelated environment variables are
not inherited. Values listed there are treated as sensitive in returned content.

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

4. Inspect `ym providers plan verify --input request.json --json`, then explicitly execute with
   `ym providers run verify --input request.json --json`. `--dry-run` prints the
   route without reading input or running a provider; use plan with --input to
   check input-aware fallback eligibility. `ym doctor` summarizes
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
      command: ['node', fileURLToPath(new URL('./provider.mjs', import.meta.url))],
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

Write exactly one JSON object to stdout after reaching a known terminal state,
then exit zero, including when the JSON reports a failed check. Nonzero exit
means the helper itself did not complete its protocol and produces unknown:

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
JSON requests/results are limited to 1 MiB; store large artifacts separately.
Exit-code commands retain only the final 64 KiB of stdout without terminating
verbose builds/tests. Their result data reports whether output was truncated.
Helpers need an actual JavaScript runtime; process.execPath in a standalone YM
binary points to Yardmaster itself. Shell-only Windows .cmd/.bat wrappers are
not automatically executed; use an executable runtime and its script path.

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

Provider plans and completed checks appear in the existing dashboard activity
feed and task details. Availability is scoped to the machine that reported it;
the hub's prerequisites do not establish a remote worker's availability.
Resource leases, vendor connectors beyond Browserbase and dashboard configuration
controls remain separate extensions.
The current router makes no measured cost/speed savings claim and creates no
subscription, remote session or infrastructure during discovery.

## Make providers acceptance checks

Add a verification list to the same `services` configuration used by the CLI:

```json
{
  "verify": ["npm test"],
  "services": {
    "local": {
      "browser.verify": {
        "service": "browser",
        "command": ["node", "scripts/existing-browser-tests.mjs"],
        "protocol": "command", "locality": "local", "cost": "free"
      }
    },
    "verify": [{ "capability": "browser.verify" }]
  }
}
```

This account-free configuration uses an already installed, authorized runner.
It does not download a browser or authorize another local profile/session.
Run `ym verify --dry-run` to inspect the plan; `ym verify --json` runs the checks.
The checkout must be committed and clean. Writes to tracked/staged files or a
changed HEAD invalidate the result and preserve the changed checkout.

Managed agents and native artifact submissions use this gate. Provider checks
also run on combined integration commits, including merge trains. Plan for a
session per verification phase; these are not a shared browser or a cached pass.
Full provider acceptance is never recorded as a shell-only check-cache entry.
Unknown results (authentication problems, malformed output, cancellation,
unconfirmed release or missing evidence) stop for inspection. They do not send
the task into an automatic provider retry or replay a failed merge train
individually. A reported test failure can enter the existing repair workflow.

Before managed-task or integration dispatch, the hub durably records a service
intent. A pending or unknown intent blocks another dispatch even after a crash,
process cleanup, generation change or reassignment to another worker. Local
process exit does not establish remote job termination. Inspect holds with
`ym providers pending`, inspect the remote session/job and its worker receipt,
then record your inspection with
`ym providers resolve REQUEST_ID --note "confirmed remote job stopped ..."`.
Resolution records an owner attestation and leaves affected tasks waiting for
an explicit retry; it does not terminate a job or retry it. Paired workers can
record only their own run's service intents/results and cannot resolve holds.

Each dispatch first saves a private pending receipt under
`YARDMASTER_HOME/service-runs/<request-id>/result.json`, then atomically records
the sanitized result, execution state and verified commit. Receipts survive hub
restarts and worktree cleanup. A pending receipt after a crash requires service
inspection; it is not proof that a remote job stopped. The result includes its
receipt path. Artifacts remain on the executing machine and are never silently
uploaded, published or opened by the hub. No automatic receipt-retention policy
deletes this evidence.

## Use Browserbase with your existing tests

Enable the built-in connector and configure your existing test command:

```json
{
  "services": {
    "providers": {
      "browserbase": {
        "enabled": true,
        "options": {
          "command": ["node", "scripts/browser-check.mjs"],
          "timeoutSeconds": 180,
          "requiredEnv": ["PREVIEW_URL"]
        }
      }
    },
    "routes": {
      "browser.verify": {
        "prefer": ["browserbase", "local"],
        "allowedCosts": ["unknown", "free"]
      }
    },
    "local": {
      "browser.verify": {
        "service": "browser", "command": ["node", "scripts/existing-browser-tests.mjs"],
        "protocol": "command", "locality": "local", "cost": "free"
      }
    },
    "verify": [{ "capability": "browser.verify" }]
  }
}
```

Set `BROWSERBASE_API_KEY` in the executing machine's environment. `projectId`
and `region` are optional provider options. `requiredEnv` lists extra variables
your test command needs; normal owner-token and Git-variable restrictions apply.
Discovery checks those variable names and both executables, without running the
test command or validating dependencies, account access or allowance.

Browserbase has cost class `unknown`: Yardmaster cannot verify remaining
included minutes, overage settings or final charges. Explicitly allowing this
class authorizes provider selection under your own billing policy; it is not a
dollar cap. Sessions last at most the configured 60–240 seconds, never use
keep-alive, and are explicitly released in cleanup. An unconfirmed release
returns `unknown`. Creation is attempted once, with no SDK retry or local replay.
A timeout/crash during creation can leave an unidentified session until its
hard timeout. A process kill or network outage cannot guarantee remote cleanup.

The connector passes these values to the configured command:

| Variable | Purpose |
| --- | --- |
| `BROWSERBASE_CDP_URL` | Credential-bearing connection for the created session |
| `BROWSERBASE_SESSION_ID` | Created session ID |
| `YARDMASTER_VERIFY_SHA` | Committed artifact being checked; empty for a manual run without a commit |
| `YARDMASTER_VERIFY_INPUT_FILE` | Private JSON input file; supports the full request-size limit |
| `YARDMASTER_VERIFY_INPUT` | Compatibility value for input up to 32 KiB; absent for larger input |
| `YARDMASTER_ARTIFACT_DIR` | Private directory for screenshots, traces and assertions |

Use Playwright's `chromium.connectOverCDP` or your existing Puppeteer CDP client.
For example, a project that already has Playwright can adapt this harness:

```js
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP(process.env.BROWSERBASE_CDP_URL);
try {
  const page = await browser.contexts()[0].newPage();
  await page.goto(process.env.PREVIEW_URL);
  // The preview must expose its deployed commit; use your app's real identity endpoint/marker.
  assert.equal(await page.locator('meta[name="build-sha"]').getAttribute('content'), process.env.YARDMASTER_VERIFY_SHA);
  assert.equal(await page.getByRole('heading', { name: 'Your expected heading' }).isVisible(), true);
  await page.screenshot({ path: join(process.env.YARDMASTER_ARTIFACT_DIR, 'browser.png') });
} finally { await browser.close(); }
```

Exit zero only after your actual assertions pass. The command is trusted test
code: it must connect to the supplied session, check the intended application,
and establish that the preview matches the requested SHA. Passing a URL or SHA
to a test does not independently prove deployed content identity. Protect
preview access through your existing authorized mechanism; never send the hub
token to the browser. Treat the CDP URL as a credential, even if it contains an
account API key. The connector redacts known credentials from its bounded log,
does not save connection URLs and disables Browserbase recording/logging. It
cannot sanitize arbitrary screenshot/trace files written by your tests.
The private input file is removed after execution; a crash can leave it in the
private receipt directory for inspection. Prefer the file interface so Linux's
per-environment-variable size limit cannot prevent your test from starting.

See the official [session creation](https://docs.browserbase.com/reference/api/create-a-session),
[release](https://docs.browserbase.com/reference/api/update-a-session) and
[Playwright](https://docs.browserbase.com/introduction/playwright) documentation.

## JavaScript API

Published entry points are `yardmaster/providers`, `yardmaster/provider-contract`
and `yardmaster/verification`. They export the same routing, schemas and
verification functions used by the CLI. These are JavaScript entry points;
this release does not ship generated TypeScript declarations.

Unchanged plugin entry files reuse their content-addressed ESM module during
availability refreshes. Changed entry source loads a new version. As with other
Node ESM plugins, changes to imported manifest dependencies can require a hub
restart; command helper scripts are executed afresh by their runtime.
