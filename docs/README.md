---
type: reference
---
# Documentation map

In suggested reading order. Agents: [AGENTS.md](../AGENTS.md) first.

| Doc | Type | What it is for |
|---|---|---|
| [README.md](../README.md) | guide | For people running a bridge: quick start, options, every feature from the operator's side, troubleshooting. |
| [architecture.md](architecture.md) | explanation | One page: purpose, quality goals, context and containers, key concepts, risks. |
| [isolation.md](isolation.md) | explanation | What the bridge does and does not stop: the `isolated` / `workspace` / `native` postures and who decides. |
| [PROTOCOL.md](../PROTOCOL.md) | reference | The wire protocol between bridge and server: every frame, handshake field, error code, and the versioning rules. |
| [mcp-upstreams.md](mcp-upstreams.md) | guide | MCP servers the bridge connects to itself (`--mcp-upstreams`): the config file, secrets, visibility, OAuth sign-in. |
| [decisions/README.md](decisions/README.md) | reference | Index of decision records: what was decided, when, and when it may be reopened. |
| [tests/manual/README.md](../tests/manual/README.md) | guide | The end-to-end harness against a real server and a real CLI, outside `npm test`. |

PROTOCOL.md stays at the repository root under its current name because the
README, the docs, the code and the server repository all link to it there.
