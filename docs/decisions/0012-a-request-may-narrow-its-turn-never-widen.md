---
status: accepted
date: 2026-10-20
supersedes:
superseded_by:
revisit_when: Codex or Gemini can be held to MCP tools only (then they stop being refused), a server needs a turn narrowed to something other than isolated, or Claude's permission system changes how --permission-mode manual denies in -p mode
---
# A request may narrow its own turn to `isolated`, never widen it

## Context
The posture a connection runs under is chosen once, on `welcome`, and gated by
the operator's flags (0006). Engram asks for `workspace`, so every chat turn
has the shell and the file tools. Jasper decided on 2026-10-20 that a scheduled
task may be "Engram tools only": a run nobody watches that reaches Engram's
own tools and nothing on the machine. That is a property of one turn, not of
the connection, and Engram wants it enforced where the CLI is started rather
than asked for in a prompt.

## Decision
From 0.33.0 (`hello.turn_isolation: 1`) an `ai_request` may carry
`cli_isolation: "isolated"`. The bridge then launches that turn exactly as an
`isolated` one (Claude: `--strict-mcp-config`, `--allowedTools mcp__bridge__*`,
`--permission-mode manual`), issues its MCP token as server-tools-only (the
bridge's own tools and upstream servers are neither listed nor callable), and
reports nothing else differently. `turnPosture()` in `src/bridge.ts` decides.

It can only narrow. Any other value is refused (`isolation_not_narrowing`).
It is refused rather than run wider on a provider whose adapter does not
declare `enforcesServerToolsOnly` (`isolation_unsupported`; only Claude does:
Codex's read-only sandbox still has a shell, Gemini has no lever) and beside a
`working_dir` (`isolation_conflict`).

## Consequences
- Measured on Claude 2.1.283 with these flags: a turn asked to write a file
  through Bash was denied and nothing was written. `tests/bridge/turn-isolation.test.ts`
  asserts the argv of a narrowed turn on a `workspace` connection.
- A server must not send the field to a bridge without `turn_isolation`: an
  older bridge ignores it and would run the turn with the connection's posture.
  Engram skips such a turn with a reason instead.
- User-level configuration (instruction files, hooks) still loads, as in every
  `isolated` turn (docs/isolation.md); it grants no tool.

## Rejected
- **A new posture name** (`server_tools`): it would mean exactly `isolated`,
  and two names for one launch drift apart.
- **Letting a request pick any posture the operator allowed**: a turn could
  then widen a connection the server itself chose to keep narrow, and every
  request would need the 0006 gate again.
