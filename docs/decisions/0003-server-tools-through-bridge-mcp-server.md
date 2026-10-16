---
status: accepted
date: 2026-05-24
supersedes:
superseded_by:
revisit_when: a supported CLI cannot consume MCP tools, or the CLIs gain a native way to call remote tools without a local endpoint
---
# Server tools reach the CLI only through a bridge-side MCP server

## Context
Server-declared tools were exposed as Bash wrapper scripts on the CLI's `PATH`
plus a manifest in the prompt. For the model to call them it had to be allowed
to run shell, so the bridge passed `bypassPermissions`, `danger-full-access` or
`--yolo`. During testing a vague Gemini turn ran an autonomous shell against a
developer's repository for minutes, editing files and running test suites
(issue #19, PR #21).

## Decision
The bridge runs an HTTP MCP server bound to `127.0.0.1` (`src/mcp/server.ts`)
and points each spawned CLI at it with a per-spawn bearer token
(`src/mcp/cli-config.ts`; the token travels in env or a 0600 file, never in
argv). The model reaches server tools through MCP only, and restricted turns no
longer get the CLI's bypass flags. The wrapper and manifest code was deleted.

## Consequences
- Calling a tool no longer implies shell access; that became a separate,
  operator-gated posture (decision 0006).
- Concurrent CLIs are told apart by their token, not by a shared "active request".
- The same server later carries bridge tools (`bridge__attach_file`) and
  upstream tools (decision 0008).
- New dependency: `@modelcontextprotocol/sdk`.

## Options considered
- Keep the wrappers and restrict shell another way: rejected in PR #21 because
  the wrappers need shell, so the coupling itself had to go.
