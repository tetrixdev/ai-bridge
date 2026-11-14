---
status: accepted
date: 2026-11-14
supersedes:
superseded_by:
revisit_when: Claude Code's WebSearch starts reaching anything on the bridge's machine, a server needs WebFetch or another built-in tool, Codex or Gemini get an equivalent lever, or an operator asks for web search to be opt-in rather than opt-out
---
# A request may add Claude's built-in WebSearch, and only it, to an `isolated` turn

## Context
An `isolated` Claude turn allows only `mcp__bridge__*` (plus a read grant on its
own attachment directory), and `--permission-mode manual` in `-p` mode denies
everything else (0006). That denies Claude Code's built-in `WebSearch` too, as a
side effect: nobody decided against web search. Dungeon Maister's Workshop (the
human Dungeon Master's assistant) runs isolated, and on 2026-11-14 Jasper chose to
let it search the web when the DM allows it per campaign. The non-negotiable
"the server cannot widen what the operator allowed" and 0012's "narrow, never
widen" had to be read against that.

## Decision
From 0.40.0 an `ai_request` may carry `options.web_search: true`. On an
`isolated` Claude turn (the connection's posture, or one narrowed to it by
`cli_isolation`) the bridge then adds exactly `WebSearch` to `--allowedTools`;
nothing else changes. Only the JSON value `true` asks. In `workspace` and
`native` every built-in tool is already allowed, so the field changes nothing.
Codex and Gemini ignore it. The bridge announces it as `hello.web_search: true`.

It is on unless the operator says no: `--no-web-search` (or
`AI_BRIDGE_WEB_SEARCH=0`, or `install --no-web-search`) removes
`hello.web_search`, and a turn that asks anyway runs without the tool, with a
warning in the log.

Why the server may ask for this one: the operator's gates (`--allow-dir`,
`--allow-native`, `--local-tools`, `--mcp-upstreams`) guard this machine, its
files, shell, MCP servers and secrets. A web search runs at Anthropic, with
words the model writes from the turn, which the server already holds in full;
it reaches nothing here. What it does use is the operator's Claude account,
which is why the operator can refuse it.

## Consequences
- Verified on Claude Code 2.1.325 with `--allowedTools "mcp__bridge__*,WebSearch"
  --permission-mode manual`: the turn searched; `WebFetch` and `Bash` were denied
  (`permission_denials` in the result). `tests/bridge/web-search.test.ts` and
  `tests/providers/isolation-posture.test.ts` assert the argv.
- Search results are untrusted text inside the turn: a page may carry
  instructions. The server's prompt must tell the model never to follow them;
  the bridge cannot.
- An older bridge ignores the field, so a server that relies on search checks
  `hello.web_search` and says when it is missing.

## Rejected
- **`WebFetch` too**: it fetches any URL the model writes, so instructions on a
  searched page could send the turn's data to any host as a query string. Search
  results are enough for the facts a server asked for. Revisit only with a
  per-host allow-list.
- **An operator opt-in flag (`--allow-web-search`)**: every operator of a server
  that wants search would have to restart their bridge with a flag for
  something that touches nothing on their machine; opt-out keeps the operator's
  say without that.
- **A new posture**: it would mean "isolated plus one tool", and a posture per
  tool combination does not scale; 0012 rejected a second name for one launch
  for the same reason.
