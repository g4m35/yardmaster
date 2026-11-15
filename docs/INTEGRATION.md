# How agents talk to Yardmaster (and why it isn't only MCP)

Researched 2026-11-03.

## The question

Is MCP the best way for agents to use an orchestrator? It is the right *portable* interface: one server works in
Claude Code, Codex, Cursor, OpenCode, Gemini CLI, and anything else that speaks it. But "portable" and "optimal"
are different things, and the costs are well documented:

- **Tool definitions cost context.** Agents now defer them (Claude Code and Copilot CLI load only names until a
  tool is used, via tool search), which mostly fixes this for modern clients. Older clients still load every
  schema up front: a few dozen tools can take 10-20K tokens ([Claude Code docs](https://code.claude.com/docs/en/agent-sdk/tool-search), [Copilot CLI docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/tool-search)).
- **Every call is a round trip.** One tool call means one model step over the whole conversation. For well-known
  CLIs, benchmarks find shell commands cheaper and more reliable than the equivalent MCP server ([mcpdelta](https://www.mcpdelta.com/guides/mcp-vs-cli)).
  Anthropic's own "code execution with MCP" work cut a workflow from 150K to 2K tokens by calling tools from code
  instead of one step per call ([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)).
- **Hooks are free.** Claude Code and Codex both run hooks outside the model, can add context with
  `additionalContext` on SessionStart, UserPromptSubmit, and PostToolUse, and can block a tool call before it runs
  ([Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://developers.openai.com/codex/hooks)).
  Codex reads the same JSON shape from `~/.codex/hooks.json`.
- **Skills load on demand.** Only the name and description sit in context until the task needs the rest, and they
  pair well with MCP ([Anthropic](https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp), [Codex skills](https://developers.openai.com/codex/skills)).

## The answer: four layers, cheapest first

| Layer | What it does | Cost to the agent |
|---|---|---|
| **Hooks** (`ym connect`; `--no-hooks` to skip) | Session-start briefing (board + the repo's most useful lessons, re-sent after compaction). Before each prompt: only what changed on the board, and nothing if nothing did. After each edit: the file is reserved for this session automatically. Before each edit: blocked only if another agent holds the file. | Zero tool calls. A few hundred tokens at session start; usually nothing per prompt. |
| **Skill** (`skills/yardmaster/SKILL.md`, installed by `ym connect`) | Teaches when to fan out, how to write good task briefs with file scopes, and when to record lessons. | ~60 tokens until the agent needs it. |
| **MCP** (`ym mcp`) | Explicit actions: queue tasks with scopes and order, wait (long-poll, not polling), reserve files, steer and learn. 13 coarse tools with short text replies. For clients that load every definition, `YARDMASTER_MCP_PROFILE=minimal` exposes one `yard` tool instead. | One round trip per action; outputs are a few lines. |
| **CLI** (`ym ... --json`) | For agents that script (code mode, Bash): `ym add`, `ym status --json`, `ym show <id> --json`. | One shell call. |

Design rules that keep the MCP layer cheap:
- **Coarse tools.** `yard_add_tasks` takes a whole plan at once instead of one call per task; `yard_wait` blocks
  until tasks settle instead of the agent polling.
- **Text, not JSON dumps.** Replies are a few plain lines; full detail is one `yard_task` call away.
- **Read-only annotations** on status/who/task/inbox/wait so clients can auto-approve them.
- **Identity without setup.** Background agents identify as their task (via `YARDMASTER_TASK_ID`), interactive
  sessions by folder and parent process, so nobody has to pass an id.

## Why not ACP or A2A?

The [Agent Client Protocol](https://agentclientprotocol.com) connects editors to agents (an editor drives an
agent). A2A connects agents across organizations. Yardmaster's problem is a third one: several agents, each in the
tool its user chose, sharing one repository. MCP + hooks reach all of them today. An ACP adapter (driving agents
that speak ACP as background workers) is a natural plugin.

## Native session identity

A working directory is not proof that two clients are the same session. Every hook uses its server-returned canonical project/machine-scoped ID; each MCP connection has an independent identity by default. If one interactive client should share reservations between its hooks and MCP tools, launch it with a unique `YARDMASTER_SESSION` inherited by both. If the client filters MCP environment variables, explicitly forward that value in its MCP configuration. Do not reuse it across independently editing clients. Release a conflicting MCP reservation before a hook edit when those identities are intentionally separate. Existing matching legacy registration IDs keep their locks and task claims.

## Subprocess environment configuration

Managed coding agents, plans and reviews inherit the normal environment after secret filtering. Setup and verification shell commands use the same filter, without agent authentication exceptions. Proxy addresses, locale, PATH and CA certificate settings remain available unless their name or value matches a secret rule. Provider subprocesses retain their separate restricted environment.

The filter removes token/secret/key names, password/credential names, `AWS_*`, `AZURE_*`, and URLs containing `user:password@` credentials (including `DATABASE_URL`). It always removes `YARDMASTER_TOKEN`, `YARDMASTER_HUB` and inherited Git worktree overrides. Variable values are never logged by this filter.

Authentication exceptions belong to the selected adapter: Claude gets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`; Codex gets `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `CODEX_*`; Cursor gets `CURSOR_API_KEY`; Gemini gets `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS`; OpenCode gets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `OPENCODE_*`. Other provider credentials, custom adapters and authenticated proxy URLs need an explicit exception.

Set named exceptions in global configuration or the project's `yardmaster.json`. `env.pass` applies to agents (including plans/reviews); `env.checks.pass` applies to setup and verification commands. Entries are exact, case-sensitive variable names, without values or wildcard expansion. Lists default to empty. A hub administrator token cannot be passed through either list.

```json
{
  "env": {
    "pass": ["PROJECT_API_TOKEN"],
    "checks": { "pass": ["DATABASE_URL", "NPM_TOKEN"] }
  }
}
```

Only pass credentials the selected processes actually need. Environment filtering reduces accidental inheritance; agents and commands still run as your user and can access files allowed by their sandbox.
