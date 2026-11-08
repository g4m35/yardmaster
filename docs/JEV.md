# Optional JEV effort routing

Yardmaster can ask a separately installed JEV router how much reasoning a task needs before starting Claude Code or Codex. Yardmaster still chooses the agent and model, manages isolation, and verifies the result. JEV can lower the default effort for a first attempt; it cannot raise it above the task tier's baseline or change the model, permissions, tools, budget, or agent prompt.

This integration is off by default and needs no new npm dependency. It uses the existing provider-neutral `jev-router route` JSON interface. JEV remains responsible for its TypeSafe key, prompt redaction, allowed projects, disabled state, and shadow/active mode. Yardmaster does not install, enable, or modify JEV or T3.

## Configure one machine

1. Install a JEV router that supports the version 1 JSON `route` command. Check it independently with its own status/validation tools. Yardmaster does not bundle the private router or its credentials.
2. Add `effortRouting` to **that machine's** `~/.yardmaster/config.json`. Start with shadow mode. The example binding is a placeholder: replace it with an exact model configured in `agents.<agent>.models` and effort values verified for your installed CLI/model.

```json
{
  "effortRouting": {
    "enabled": true,
    "mode": "shadow",
    "command": ["/absolute/path/to/jev-router", "route"],
    "timeoutMs": 5000,
    "bindings": [
      {
        "agent": "codex",
        "model": "YOUR_EXACT_MODEL_ID",
        "efforts": ["low", "medium", "high"],
        "cacheImpact": "unknown"
      }
    ]
  }
}
```

3. Restart the hub or worker and run a small task with checks. `ym logs <task-id>` reports `JEV effort: shadow`, `hold`, `apply`, `skipped`, or `fallback` with a bounded reason and elapsed milliseconds. A shadow suggestion leaves the actual effort unchanged. The run's `route` phase records routing overhead.
4. After verifying the exact runtime/model's cache behavior, set the binding's `cacheImpact` to `preserves-prefix`, or `may-reset` with `allowCacheReset: true` if you accept the reset. Set Yardmaster's mode to `active`. JEV must also permit active decisions for that local project; its disabled, scope, and shadow gates still take precedence.

The command is an argument array, never a shell string; use `["node", "/absolute/path/to/cli.mjs", "route"]` for a JavaScript build. Tildes and shell variables are not expanded. Use absolute paths, especially when the hub starts with a different PATH. An inherited `JEV_ROUTER_HOME` is handled by JEV itself.

Each worker uses its **own complete** `effortRouting` section. Hub settings, paths and bindings are never inherited by another machine. Putting this section only in a project's `yardmaster.json` does not enable execution: worker-local configuration is authoritative. JEV receives the local registered checkout path for its allowlist, rather than a temporary worktree or the hub's path.

## Effort ownership and minimum effort

These per-agent settings apply to every launch through an adapter, with or without JEV: coding attempts, retries, resumes, `ym plan` and reviews. They live in `agents.<agent>` of the machine's configuration.

```json
{
  "agents": {
    "claude": { "minimumEffort": "high" },
    "codex": { "minimumEffort": "high" }
  }
}
```

- `effortOwnership`: `"managed"` (default) passes Yardmaster's tier default (cheap `low`, standard `medium`, strong `high`). `"native"` passes no effort flag, so the CLI's own configuration decides, and JEV is skipped (`native_ownership`) without suppressing native hooks.
- `minimumEffort`: generated tier defaults and JEV decisions below it are raised to it. Reviews (standard tier) and untiered launches pass it too. JEV is offered only levels at or above it. When no lower level remains below the baseline, JEV is skipped (`at_floor`), and a reply below it falls back (`below_floor`).
- `attestedEffort`: your statement of the effort the CLI really uses where Yardmaster cannot set or see it, such as native ownership, a `""` tier, a custom `command`, or an agent without an effort flag (OpenCode, Cursor, Gemini, plain commands). In those cases a minimum requires an attestation at or above it. Yardmaster does not read native configuration to check it.

Explicit choices are never changed. `effort.<tier>` and an effort flag in `extraArgs` (Claude `--effort`, Codex `-c`/`--config model_reasoning_effort=`) take precedence over ownership and routing. When the flag is in `extraArgs`, Yardmaster adds none, so the command line has no duplicate. The launch stops with an `EffortPolicyError` before anything starts when an explicit value is below the minimum or cannot be ranked, two explicit values differ, a minimum is not a level the CLI documents (Claude Code 2.1.319: `low`…`max`; Codex: `none`…`ultra`), or a needed attestation is missing or too low. Values Yardmaster does not rank still pass through unchanged when no minimum is set.

Each built launch records its effective effort, source (`tier-default`, `floor`, `manual`, `extra-args`, `jev`, `native`, `native-attested`) and evidence (`launch-flag`, `user-flag`, `attested`, `unknown`), which `launchEffort()` in `src/effort.ts` returns. `launchIdentity()` gives a fingerprint of the launch shape: agent, command, model, the effort on the command line, read-only, autonomy, context mode, tools, MCP config path, sandbox, a hash of `extraArgs`, environment variable names, and an optional CLI version. It leaves out the prompt, session and task identifiers, worktree path, budget and secret values. A matching fingerprint shows the launch shape is unchanged. It does not show a provider cache hit, and with native effort a change in the CLI's own configuration does not change the fingerprint.

Yardmaster checks the value it passes, not whether a given model accepts or honors it. A model that rejects a level fails in the CLI.

## Preserved behavior and fallbacks

- Explicit effort settings, including `""`, custom executable settings, any `extraArgs` and native effort ownership bypass classification. A configured `minimumEffort` still applies to the launch. Unsupported agents, unbound models and unknown/default model identities retain normal behavior. Bindings advertise only the effort values actually supported; aliases need their own verified binding.
- Retries, resumed sessions, redirects, and review/conflict repairs bypass classification so recovery and escalation keep their existing effort. On enabled, bound Claude launches, `JEV_ROUTER_HOST_ROUTING=1` suppresses duplicate native JEV hooks, including on fallback and recovery. Unbound launches keep their existing hooks.
- Yardmaster sends only the original task title/prompt, identity and capability metadata to the local JEV process, not the expanded coding brief, dependency summaries or teammate messages. JEV's ordinary policy can hold opaque or long requests unchanged. Eligible redacted task text can be sent to TypeSafe even in shadow mode; this is not an offline classifier.
- The subprocess has a 5-second default deadline (configurable from 100 ms to 30 seconds), a 64 KiB combined output cap, no shell, and process-group cleanup on timeout/cancellation. Missing command, nonzero exit, malformed/stale responses, wrong identities, unsupported options/values and efforts above the baseline all retain the normal effort. Hub credentials and Git redirect variables are stripped from its environment. Raw router output and arbitrary error/reason text never enter activity logs.
- Cancellation and ownership are checked after routing and again immediately before spawning the coding agent. Shutdown stops a pending router; canceled or superseded attempts do not start coding. Existing task checks and safe integration still decide whether work is accepted.

## Limits

This selects effort once before the first coding attempt. It does not route each internal model turn, replace the scheduler, select another provider/model, or route planning/review subprocesses (they still get the minimum effort). The initial supported launch adapters are Claude Code and Codex; other providers in JEV's library need their own verified Yardmaster launch bindings.

Cache telemetry is reported as given: Claude Code (`cache_creation_input_tokens`) and OpenCode (`cache.write`) usage carries cache-write tokens when present, Codex reports cache reads only, and a missing figure stays unknown rather than zero. An OpenCode step without a cost is estimated from list prices instead of being recorded as $0. None of this certifies cache preservation across launches; that needs controlled provider observations.

Yardmaster does not claim measured savings from this integration. The JEV v1 reply supplies judge latency/attempts but no monetary usage, so TypeSafe classification cost is **not included** in Yardmaster's task/daily dollar meters. Account for it separately and compare total cost per verified task, quality and wall time before broadly enabling active mode. Failed router calls are not retried by this integration.

To roll back, set `effortRouting.enabled` to `false` in that machine's Yardmaster configuration. This restores ordinary launches and leaves JEV's own installation/configuration intact.
