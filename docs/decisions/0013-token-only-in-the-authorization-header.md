---
status: accepted
date: 2026-10-24
supersedes:
superseded_by:
revisit_when: a server half needs a client that cannot set headers on a WebSocket upgrade (a browser), which would then take the token in Sec-WebSocket-Protocol or a first message, never the URL
---
# The connection token travels only in the Authorization header

## Context
Since 0.14.0 the bridge sent its connection token twice when opening the
socket: as `Authorization: Bearer` and as `?token=` on the URL, the second
"for servers that have not adopted the header". A URL is written to every
access log between the bridge and the server. On 21 October 2026 a production
reverse proxy (nginx, default `combined`-style format) was found holding an
Engram bridge token in plain text, which had to be rotated, and the dev
server's proxy log held two more. Engram's `/bridge` never read the query
parameter at all; laravel-ai-bridge reads the header first and logs a
deprecation when only the query parameter is there. Nothing needed the copy in
the URL.

## Decision
From 0.35.0 `Bridge.connect()` puts the token in the `Authorization` header
only and connects to `--server` exactly as given. `tests/bridge/connect-auth.test.ts`
holds both halves: the header is sent, and the URL the server sees carries no
token. A `--server` that itself carries `token=` is refused at startup (the CLI
and the `Bridge` constructor), not stripped: it would otherwise be logged and
sent as given.

## Consequences
- A server that reads only `?token=` refuses a 0.35.0 bridge. Neither server
  half does; a third-party one would have to read the header, which every
  bridge since 0.14.0 sends.
- Bridges older than 0.35.0 keep putting the token in the URL until they
  update. Servers and proxies have to keep it out of their logs on their own
  side for as long as those exist.
- The token can still appear in a process listing when passed as `--token`;
  `AI_BRIDGE_TOKEN` or the installed service's config file avoids that. This
  decision does not change it.
