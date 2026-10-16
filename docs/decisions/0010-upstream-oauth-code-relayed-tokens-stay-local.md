---
status: accepted
date: 2026-10-16
supersedes:
superseded_by:
revisit_when: the bridge usually runs on the machine the person signs in from, or the MCP authorization spec offers a device flow servers support
---
# Upstream OAuth: the web app relays the code; tokens and the PKCE verifier stay on the bridge

## Context
Upstream MCP servers may require OAuth (RFC 9728 discovery, RFC 7591 dynamic
registration, PKCE). The bridge usually runs on a machine the person is not
sitting at, so a `localhost` redirect cannot work (PR #60, PROTOCOL.md
"Upstream sign-in (OAuth)").

## Decision
- The redirect goes to the web application (`welcome.upstream_oauth.redirect_uri`),
  which the person's browser can reach; it passes the one-time code to the
  bridge (`upstream_auth_code`). Only the bridge holds the PKCE verifier, so only
  it can turn the code into tokens.
- Tokens are stored on the machine (`AI_BRIDGE_DATA_DIR/mcp-oauth`, 0700/0600),
  refreshed there, redacted from everything sent out, and never reach the server.
- The orchestration is the bridge's own (`src/mcp/oauth.ts`) using the SDK's
  step functions, not the SDK's `auth()` / `authProvider`, because the protocol
  needs to report which step failed and why a sign-in is needed.

## Consequences
- A web application relays sign-ins without ever being able to use the account.
- While an upstream needs sign-in its tools are hidden and it is not retried.
- OAuth requests must be https (loopback excepted), avoid internal addresses,
  time out after 15 s and are capped at 1 MB; a DNS-rebinding window remains.

## Options considered
- Localhost redirect on the bridge: does not work for a remote machine.
- SDK `auth()` / `authProvider`: reports every failure the same way.
