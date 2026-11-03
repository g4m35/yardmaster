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
| **Hooks** (`ym connect --with-hooks`) | Session-start briefing (board + the repo's most useful lessons, re-sent after compaction). Before each prompt: only what changed on the board, and nothing if nothing did. After each edit: the file is reserved for this session automatically. Before each edit: blocked only if another agent holds the file. | Zero tool calls. A few hundred tokens at session start; usually nothing per prompt. |
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
