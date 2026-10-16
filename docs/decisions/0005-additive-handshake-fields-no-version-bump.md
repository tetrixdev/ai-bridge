---
status: accepted
date: 2026-09-04
supersedes:
superseded_by:
revisit_when: a change cannot be made optional in both directions, or the protocol is declared 1.0
---
# New capabilities are additive handshake fields; the protocol stays on 0.1

## Context
The protocol version is exchanged in `hello.version`, and only the major number
is enforced. PR #23 added working directories, attachments and `workspace`
isolation, all optional in both directions. Bumping the version would have
refused every bridge already installed in exchange for nothing (PROTOCOL.md,
Versioning).

## Decision
Protocol changes stay on `0.1` and are additive:
- the bridge advertises what it understands as a `hello` field, `true` or a
  revision number for a family of frames (`mcp_apps.revision`, `space_files`,
  `app_network`, `mcp_upstream_auth.revision`);
- a server must not send a capability's frames to a bridge that did not
  advertise it, and tells the person to update instead;
- server options are optional `welcome` / `ai_request` fields that an older
  bridge ignores; both ends ignore what they do not recognise;
- each such change adds a "does not bump the version" line under Versioning.

## Consequences
- Old bridges and old servers keep interoperating; capability checks live in
  the server, per field.
- A family's own shape changes by bumping its revision, not the protocol.
- `hello` grows a field per feature; PROTOCOL.md is the only list of them.

## Options considered
- Bump the minor or major version per feature: rejected for the reason above.
