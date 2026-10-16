---
status: accepted
date: 2026-10-09
supersedes:
superseded_by:
revisit_when: the MCP Apps (ext-apps) spec changes the meaning or default of _meta.ui.visibility
---
# A view may call only tools whose _meta.ui.visibility includes app

## Context
MCP Apps (ext-apps, spec 2026-01-26) lets a web application host a view for a
tool call. For upstream servers only the bridge sees the tool definitions, so
the bridge relays the view's own requests (`mcp_request` / `mcp_result`, PR #52).
The spec's `_meta.ui.visibility` says who a tool is for.

## Decision
The bridge enforces `_meta.ui.visibility` (default `["model", "app"]`) on
upstream tools:
- without `"model"`: not offered to the CLI, and refused if called by name;
- without `"app"`: refused when a view asks to call it;
- a view may read only `ui://` resources of its own server.
The model receives text content only; the full `CallToolResult` goes to the host
in `tool_result.ui.result`, never into the turn.

## Consequences
- App-only tools (for example a view's own actions) cannot be driven by the
  model, and model-only tools cannot be driven by a view.
- For the server's own tools the bridge only passes `_meta` through unchanged;
  it enforces visibility on upstream tools alone, since a server's views call
  the server's tools without going through the bridge.

## Options considered
- Not recorded; this follows the spec's field rather than inventing a policy.
