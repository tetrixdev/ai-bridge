---
status: accepted
date: 2026-10-09
supersedes:
superseded_by:
revisit_when: upstream servers need to be usable by turns a server runs in isolated posture
---
# Upstream MCP tools are offered only in workspace isolation

## Context
`--mcp-upstreams` (PR #52, 0.27.0) lets the bridge connect to MCP servers the
operator chose and offer their tools to the CLI beside the server's own. These
tools run on the bridge with the machine's own configuration and secrets, and
never produce a `tool_call` frame the server could see or refuse.

## Decision
Upstream tools are offered to the CLI as `<server>__<tool>` only when the turn
runs in `workspace` isolation; an `isolated` CLI never sees them. Only the
operator configures upstreams; a server cannot add, change or name one.

## Consequences
- Upstream tools are grouped with `bridge__attach_file` as "the machine's own"
  (PROTOCOL.md, "Upstream tools"), so they need the same operator opt-in as the
  shell (decision 0006).
- A server that wants upstream tools in a turn must request `workspace`, which
  also hands the CLI its file and shell tools in the allowed directory.

## Options considered
- The rationale is stated only by analogy in PROTOCOL.md and
  docs/mcp-upstreams.md; alternatives (for example a separate opt-in for
  upstreams in isolated turns) are not recorded.
