# MCP servers this bridge connects to (`--mcp-upstreams`)

The bridge can be an MCP **client** of servers you choose, and offer their tools
to the CLI beside the web application's own. Because the bridge holds each tool
definition, it can tell the web application which call has an
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) view, and relay
the view's requests back to its server (PROTOCOL.md, "MCP Apps").

Only the person running the bridge configures these. A web application cannot
add, change or name one.

```sh
ai-bridge --server wss://... --mcp-upstreams ~/.config/ai-bridge-mcp.json
# or: AI_BRIDGE_MCP_UPSTREAMS=~/.config/ai-bridge-mcp.json
```

A bad file stops the bridge at start with the server and field named; a server
that will not start or connect is logged and retried, never fatal.

## The file

The `mcpServers` shape Claude Code and Claude Desktop use (a bare map of
servers is accepted too):

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@example/weather-mcp", "--stdio"],
      "env": {
        "WEATHER_UNITS": "metric",
        "WEATHER_API_KEY": { "env": "WEATHER_API_KEY" }
      }
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": { "vault": { "space_id": "4f1c…", "secret_id": "9a2e…" }, "prefix": "Bearer " }
      },
      "timeout_ms": 120000
    }
  }
}
```

| Key | For | Meaning |
|-----|-----|---------|
| name (the key) | both | 1–32 letters, digits, `-`, `_`; no `__`. Tools reach the CLI as `<name>__<tool>`. |
| `command`, `args` | stdio | The program to start and its arguments. |
| `cwd` | stdio | Working directory for it. |
| `env` | stdio | Extra environment. The process gets **only** these plus a safe default set (`HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LOGNAME`), never the bridge's own environment, which holds its token. |
| `url` | HTTP | A Streamable HTTP endpoint, `http://` or `https://`. No credentials in the URL. |
| `headers` | HTTP | Sent on every request. |
| `timeout_ms` | both | Per request (a tool call, a resource read). Default `60000`. |
| `connect_timeout_ms` | both | Starting and initializing. Default `30000`. |

## Secrets

An `env` or `headers` value is either a literal string, for values that are
**not** secret, or a reference saying where the value comes from:

- `{"env": "NAME"}`: the bridge's own environment variable `NAME` (for a
  service, the env file its unit loads). Unset or empty is an error.
- `{"vault": {"space_id": "…", "secret_id": "…"}}`: a sealed value from the
  Engram vault, opened on this machine exactly as for local tools: the bridge
  must run with `--engram`, the device must be approved and handed that space's
  key, and the value is only found through the space that sealed it. Cached and
  refreshed like local tools' values (60 s TTL).
- Either may add `"prefix": "Bearer "`, put in front of the value.

A literal value is **refused at start** for a name that looks like a credential:
headers `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `API-Key`
or any header containing `token`, `secret` or `api-key`; environment names
containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY`
or `CREDENTIAL`. So a secret is never plain in the config file.

Resolved values are never logged, and are redacted (`[redacted: <server>.<name>]`)
from everything that leaves the bridge: what the model reads, results and
errors sent to the web application, and the server's stderr in the debug log.
Redaction is hygiene, not containment: a server that deliberately encodes a
value defeats it (see README, "What redaction does and does not do").

## Visibility

`_meta.ui.visibility` on a tool definition (default `["model", "app"]`):

- without `"model"`: not offered to the CLI, and refused if called by name;
- without `"app"`: refused when a view asks to call it.

A view may only read `ui://` resources of its own server.

## Connection and reconnect behaviour

- All servers connect in parallel when the bridge starts. Their tools join the
  CLI's list as each one comes up; a turn that started earlier sees them from
  its next turn.
- A server that fails to start, connect or resolve a secret is logged with the
  reason and retried in the background: 1 s, then doubling, at most every 60 s.
- When a connection drops (the process exits, the HTTP session is lost, a
  request fails without the server answering), calls in flight fail, its tools
  **stay listed**, and the next use reconnects at once rather than waiting for
  the backoff. An error the server itself answered keeps the connection.
- A slow request times out after `timeout_ms` (`timeout`); the connection is kept.
- `notifications/tools/list_changed` refreshes that server's tools.
- Stopping the bridge stops every stdio server it started.

Upstream tools are offered only when the web application runs the CLI in
`workspace` isolation; an `isolated` CLI never sees them (see docs/isolation.md).
