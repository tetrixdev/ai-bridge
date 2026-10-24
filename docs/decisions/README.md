---
type: reference
---
# Decision records

One file per decision, numbered permanently. Accepted is binding; superseded is
history. Format: Engram documentation standard v1, section 3.

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-release-tag-is-the-version.md) | The release tag is the single source of truth for the published version | accepted | 2026-05-17 |
| [0002](0002-server-owns-cli-sessions.md) | The server owns CLI session ids; the bridge is stateless about them | accepted | 2026-05-18 |
| [0003](0003-server-tools-through-bridge-mcp-server.md) | Server tools reach the CLI only through a bridge-side MCP server | accepted | 2026-05-24 |
| [0004](0004-local-tools-opt-in-secrets-open-on-bridge.md) | Local tool execution is opt-in per machine, and sealed values open only on the bridge | accepted | 2026-08-29 |
| [0005](0005-additive-handshake-fields-no-version-bump.md) | New capabilities are additive handshake fields; the protocol stays on 0.1 | accepted | 2026-09-04 |
| [0006](0006-permissive-postures-need-operator-opt-in.md) | Permissive isolation postures need the bridge operator's opt-in | accepted | 2026-09-04 |
| [0007](0007-follow-desired-bridge-version.md) | A bridge follows the server's desired_bridge_version through a pinned systemd unit | accepted | 2026-10-03 |
| [0008](0008-upstream-tools-only-in-workspace.md) | Upstream MCP tools are offered only in workspace isolation | accepted | 2026-10-09 |
| [0009](0009-views-call-only-app-visible-tools.md) | A view may call only tools whose _meta.ui.visibility includes app | accepted | 2026-10-09 |
| [0010](0010-upstream-oauth-code-relayed-tokens-stay-local.md) | Upstream OAuth: the web app relays the code; tokens and the PKCE verifier stay on the bridge | accepted | 2026-10-16 |
| [0011](0011-app-backends-run-only-approved-code.md) | An app backend runs only the files of the version the person approved | accepted | 2026-10-19 |
| [0012](0012-a-request-may-narrow-its-turn-never-widen.md) | A request may narrow its own turn to isolated, never widen it | accepted | 2026-10-20 |
| [0013](0013-token-only-in-the-authorization-header.md) | The connection token travels only in the Authorization header | accepted | 2026-10-24 |
