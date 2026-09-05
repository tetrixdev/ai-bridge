# AI Bridge Protocol v0.1

Specification for the WebSocket protocol between `@tetrixdev/ai-bridge` (npm, client-side) and `tetrixdev/laravel-ai-bridge` (Composer, server-side).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Modes of Operation](#modes-of-operation)
- [Connection](#connection)
- [Handshake](#handshake)
- [Local Calls](#local-calls)
- [AI Requests](#ai-requests)
- [Conversation Continuity](#conversation-continuity)
- [Streaming Events](#streaming-events)
- [Tool Calls](#tool-calls)
- [Heartbeat](#heartbeat)
- [Error Handling](#error-handling)
- [Provider Reference](#provider-reference)

---

## Overview

The AI Bridge protocol enables web applications to send AI requests to a user's locally installed CLI tools (Codex, Claude, Gemini) via a persistent WebSocket connection. The bridge runs on the user's machine, receives requests from the server, pipes them through the user's CLI, and streams normalized responses back.

This protocol is **provider-agnostic on the server side** — the Laravel package doesn't care whether the AI response comes from a CLI bridge, a BYOK API key, or a managed endpoint. It normalizes everything into a single streaming format.

## Architecture

```
Browser <──HTTP/SSE──> Laravel App <──WebSocket──> AI Bridge (local)
                        (server)                      │
                                                      ├── codex exec
                                                      ├── claude -p
                                                      └── gemini -p
```

**Direction of connection**: The bridge connects **outward** to the server (not the other way around). This avoids NAT/firewall issues. Once the WebSocket is established, the server can initiate AI requests through it.

**Three participants:**
1. **Browser** — the end user's web interface (talks to server via HTTP/SSE)
2. **Server** — the Laravel app with `laravel-ai-bridge` installed (manages conversations, tools, streaming)
3. **Bridge** — `@tetrixdev/ai-bridge` running locally on the user's machine (talks to CLI tools)

## Modes of Operation

### CLI Bridge
User installs the bridge locally via `npx @tetrixdev/ai-bridge`. The bridge connects to the server via WebSocket using a connection token. AI requests are fulfilled by the user's local CLI tools, using their existing subscriptions.

### BYOK (Bring Your Own Key)
User provides an API key and endpoint URL for any Chat Completions-compatible provider. No local install needed — the server calls the API directly. For MVP, only a single "Custom Chat Completions" option is supported (user sets URL + key). No preset provider configurations.

### Managed
Same as BYOK, but the application provides its own API key. Users pay the app a subscription fee. No separate architecture needed — it's just a different config source for the same BYOK code path.

---

## Connection

### WebSocket Establishment

The bridge connects to the WebSocket address the server hands it. The Laravel
package's dedicated WebSocket server listens on its own port and serves the
connection at the origin root, so the address is an origin rather than a path:

```
wss://{host}:{port}?token={connection_token}
```

The exact value comes from the server (`ai-bridge.server.public_url` when set,
otherwise `ws://{host}:{port}`) and is whatever the operator passes to
`--server`. The token also travels as an `Authorization: Bearer` header; the
query parameter is kept for servers that have not adopted the header.

The `connection_token` is a short-lived JWT obtained by the user through the web application's settings page. It encodes:

```json
{
  "sub": "user_id",
  "exp": 1718400000,
  "scope": "ai-bridge"
}
```

The server validates the token on connection. If invalid or expired, the server closes the WebSocket with code `4001` and reason `"invalid_token"`, and sends a `connection_error` message just before closing. Code `4001` is fatal — the bridge must not reconnect.

CLI bridge tokens also carry a `cid` claim (the bridge connection's database id). On connection the server confirms that connection still exists and its key has not been rotated; a token for a deleted or regenerated bridge is rejected with code `4001` even though its signature is still valid.

### Token lifetime

CLI bridge tokens are long-lived (default 30 days) — a bridge is a semi-permanent connection. Rather than re-mint a token on every request, the server tops it up once it is past half its life. A fresh token is delivered either:

- in the `welcome` message (`refreshed_token` field) — at the handshake, covering bridges that reconnect; or
- in a `token_refresh` message — pushed by a slow background timer, covering a bridge that stays connected without ever reconnecting.

The bridge adopts the new token for subsequent reconnects, so a bridge used at least once per token lifetime never expires.

### Reconnection

The bridge implements exponential backoff reconnection:

| Attempt | Delay    |
|---------|----------|
| 1       | 1s       |
| 2       | 2s       |
| 3       | 4s       |
| 4       | 8s       |
| 5+      | 15s (cap)|

On reconnect, the bridge sends a new `hello` message. The server re-associates the connection with the user. The bridge holds no session state of its own — the server owns the `conversation_id → cli_session_id` mapping (see [Conversation Continuity](#conversation-continuity)), so a bridge restart loses nothing.

---

## Handshake

After WebSocket connection is established, the bridge sends a `hello` message and the server responds with a `welcome`.

### Bridge → Server: `hello`

```json
{
  "type": "hello",
  "version": "0.1",
  "bridge_version": "1.0.0",
  "providers": [
    {
      "name": "codex",
      "available": true,
      "version": "1.2.3",
      "supports_streaming": true,
      "supports_tools": true,
      "supports_thinking": true,
      "supports_session_resume": true
    },
    {
      "name": "claude",
      "available": true,
      "version": "2.0.1",
      "supports_streaming": true,
      "supports_tools": true,
      "supports_thinking": true,
      "supports_session_resume": true
    },
    {
      "name": "gemini",
      "available": false,
      "version": null,
      "supports_streaming": false,
      "supports_tools": true,
      "supports_thinking": false,
      "supports_session_resume": true
    }
  ]
}
```

Each provider entry may include a `models` array listing available models (populated from local CLI cache or known aliases):

```json
{
  "name": "claude",
  "available": true,
  "models": [
    {"id": "sonnet", "name": "Sonnet", "is_default": true},
    {"id": "opus", "name": "Opus", "is_default": false}
  ]
}
```

**Provider detection**: On startup, the bridge probes for each CLI:
- `codex --version` → Codex availability
- `claude --version` → Claude availability
- `gemini --version` → Gemini availability

If a CLI is not installed, `available` is `false` and the server won't route requests to it.

**`supports_tools`** indicates whether the provider can invoke server-defined bridge tools. All three currently supported providers (Codex, Claude, Gemini) report `true`. Even CLIs without native tool calling can use bridge tools: the bridge injects them as Bash wrapper scripts on the CLI's `PATH` that route calls back through the WebSocket. For Codex this additionally requires running `codex exec` with a workspace-write sandbox and network access so the wrapper scripts' loopback callback succeeds — the bridge handles this automatically. Per-provider capability values are reported dynamically in the `hello` handshake; this spec documents the format, not fixed values. See [Tool Calls](#tool-calls).

**`supports_session_resume`** indicates whether the provider supports resuming conversations by session ID. All three currently supported providers support this.

#### Additive field: `workspaces`

A bridge started with `--allow-dir` also advertises the directories it will accept in `ai_request.working_dir`:

```json
{
  "type": "hello",
  "version": "0.1",
  "bridge_version": "0.2.0",
  "providers": [ "..." ],
  "workspaces": [
    { "path": "/Users/jasper/zp-studio/zeroplex-studio/ZeroPlex_Studio__D09042", "label": "Studio D09042" }
  ]
}
```

| Field | Meaning |
|---|---|
| `path` | Absolute, symlink-resolved root. Any directory at or below it may be named. |
| `label` | Human-readable name for a picker. Defaults to the directory's basename; the operator sets it with `--allow-dir <path>=<label>`. |

This is what makes the feature usable: the server shows a picker of the checkouts the developer allowed, and nobody types an absolute path into a chat box.

The field is **omitted entirely** when the operator allowed nothing, so "this bridge has no workspaces" and "this bridge predates workspaces" look the same to the server — correctly, because in both cases naming a directory is refused. An older server ignores the field.

### Bridge → Server: `providers_update`

Sent mid-connection when the bridge's set of available provider CLIs changes after the `hello` — for example, the user installs or removes a CLI while the bridge stays connected.

```json
{
  "type": "providers_update",
  "providers": [
    { "name": "claude", "version": "1.2.3", "available": true, "supports_streaming": true, "supports_tools": true, "supports_thinking": true, "supports_session_resume": true }
  ]
}
```

**`providers`**: The currently available providers, in the same shape as the `hello` `providers` array, but containing only providers whose CLI is present (`available: true`).

The server refreshes the connection's advertised providers from this message, so the host application's provider list reflects what the bridge can currently run. No response is sent.

The bridge re-probes its CLIs after every handshake and after a provider spawn failure (a request routed to a since-removed CLI), and emits this message only when the available set actually changed.

### Bridge → Server: `posture`

Sent once per handshake, immediately after the bridge adopts a CLI isolation posture — so after `welcome`, necessarily: at `hello` time it has not been told what to adopt.

```json
{
  "type": "posture",
  "cli_isolation": "isolated",
  "requested": "native",
  "reason": "requires_allow_native",
  "message": "Server asked for `native` isolation, which hands this machine's full CLI environment … Pass --allow-native if the server is one you would give a shell to."
}
```

| Field | Meaning |
|---|---|
| `cli_isolation` | The posture actually in force. |
| `requested` | What the server asked for, or `null` if it asked for nothing. |
| `reason` | Present **only** when the two differ: `not_requested`, `unrecognised`, `requires_allow_dir`, `requires_allow_native`. |
| `message` | A sentence naming the operator action that would change it. |

The server asks for a posture; the bridge may decline it, because `workspace` and `native` are gated on flags the bridge's operator passes. That refusal is correct and a server cannot override it — the gate exists precisely so a server cannot. What this frame adds is that the server can **show** it.

Without it the refusal is visible only in a log on the operator's own machine, and the failure that produces is nasty in a specific way: an operator who forgot `--allow-native` gets a connection that looks perfectly healthy in every screen, while the assistant silently has no tools at all, and nothing anywhere explains why.

Sent whether or not the posture matches the request, so a server always knows what is in force. **Absence of the frame means an older bridge, not agreement.** Additive and optional: a server that ignores it loses nothing.

### Server → Bridge: `welcome`

```json
{
  "type": "welcome",
  "session_id": "ws_abc123",
  "tools": [
    {
      "name": "roll_dice",
      "description": "Roll dice using standard D&D notation",
      "parameters": {
        "type": "object",
        "properties": {
          "notation": {
            "type": "string",
            "description": "Dice notation, e.g. '2d6+3', '1d20'"
          }
        },
        "required": ["notation"]
      }
    },
    {
      "name": "lookup_rule",
      "description": "Look up a D&D 5e rule by keyword",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The rule or mechanic to look up"
          }
        },
        "required": ["query"]
      }
    }
  ],
  "config": {
    "heartbeat_interval": 30,
    "request_timeout": 300
  },
  "refreshed_token": "<new JWT>"
}
```

#### `cli_isolation`

How much of the operator's local environment the spawned CLI may see, and what it may do. Sent on `welcome`; **absent means `isolated`**, so an older server gets the safe default rather than the legacy behaviour.

| Value | The CLI may... | The operator's environment... |
|---|---|---|
| `isolated` (default) | reach server-declared tools through the bridge's MCP server. No edits. Per-CLI — see the flag table below: Claude's built-ins are denied outright, Codex keeps its own `shell` bounded by a read-only, no-network sandbox, and Gemini's built-ins stall on an approval nothing can answer. The bridge states this posture explicitly on Claude and Codex, so the operator's own CLI configuration cannot widen it; Gemini offers no such lever. | stays out: other MCP servers ignored, neutral fallback system prompt. |
| `workspace` | **also use its own file and shell tools**, inside `working_dir`. | stays out, exactly as in `isolated`. |
| `native` | do anything the CLI can do. | is fully in play: user `CLAUDE.md`, skills, hooks, configured MCP servers, plugins, the CLI's own default prompt. |

`workspace` exists because neither of the other two fits a chat that is supposed to do the work: `isolated` blocks the edit and shell tools that *are* the capability, and `native` switches off far more than that. It is the middle setting — work in the named directory, keep the operator's own environment out — and it maps to these flags:

| CLI | `isolated` | `workspace` |
|---|---|---|
| Claude | `--strict-mcp-config`, `--allowedTools mcp__bridge__*`, `--permission-mode manual`. The permission mode is what makes the tool restriction real: `--allowedTools` only asks, and the denial comes from Claude's own permission system, which reads the operator's `~/.claude/settings.json`. Without it, a `defaultMode: "auto"` there turns `isolated` into "everything allowed". | Keeps `--strict-mcp-config`; drops the `--allowedTools` restriction; adds `--permission-mode bypassPermissions`. In headless `-p` mode `acceptEdits` would still stall on the first shell command — and running the tests *is* a shell command — so `bypassPermissions` is what actually runs a real task. The permission mode contains nothing; saying otherwise would be misleading. |
| Codex | MCP only, plus `-c sandbox_mode=read-only` stated explicitly rather than left to the operator's `~/.codex/config.toml` default | `-c sandbox_mode=workspace-write` — explicitly **not** `danger-full-access`, which is what `native` uses — plus `-c approval_policy=never`, because `codex exec` is headless and anything that asks for approval waits for an answer that can never arrive. `--cd` is passed as well when the installed codex supports it. |
| Gemini | no `--yolo`, so built-ins stall on approval | `--yolo`. It is the only lever Gemini offers: there is no middle setting, so `workspace` on Gemini is materially broader than on Codex. |

`--skip-git-repo-check` on Codex exists because the pinned scratch cwd is not a repository. Inside a real checkout it is a no-op; it is left in place because it is still correct for the scratch case.

See [`docs/isolation.md`](docs/isolation.md) in the bridge repository for how each posture is enforced, what `isolated` does not stop, and how to verify it on a given machine.

**Both permissive postures are refused unless the operator opted in.** `workspace` requires `--allow-dir`; `native` requires `--allow-native`. A bridge started without them runs `isolated` instead and logs why.

This is not a formality. `workspace` is what enables the shell, and a shell in the empty scratch directory is still a shell — so if the allow-list bounded only the working directory, a server could switch the capability on by sending this field. And gating `workspace` alone would have been theatre, because `native` is strictly broader: a server refused the shell one way would ask for it the other way and get the operator's own MCP servers, hooks and plugins as well. Same rule as `--local-tools`, in all three cases.

An unrecognised value — a typo, a newer server — is also treated as `isolated` rather than passed to the adapters, which test it with `!== 'isolated'` and would otherwise land in the permissive branch on one CLI and the restrictive branch on another.

The system prompt behaves in `workspace` exactly as in `isolated`: the server's prompt when there is one, the neutral fallback when there is not. Only `native` lets the CLI's own default through.

`bridge__attach_file` is offered in `workspace` and `native` only. In `isolated` the CLI reaches server-declared tools and nothing else, which is what the row above says and what it should keep meaning.

**Gemini and `working_dir`.** Gemini is the one CLI with no per-invocation MCP config flag — it reads `.gemini/settings.json` from cwd. When cwd is a developer's checkout the bridge therefore writes into it, and handles that explicitly: it **refuses the turn rather than overwriting** a settings file the repository already has, removes the one it wrote when the turn ends (`done`, `error` or `cancel`), and removes the `.gemini` directory too if it created it and nothing else is in it. Because there is only one such path per directory and the file carries a per-spawn bearer token, **two concurrent Gemini turns in one directory are refused** rather than allowed to race — the loser would otherwise read the winner's credential and have its tool calls routed to the other turn's request.

#### Local tools (optional)

A tool may carry fields that move execution from the server to the bridge:

```json
{
  "name": "fetch_mail",
  "description": "Fetch mail since a date",
  "parameters": { "type": "object", "properties": {} },
  "execute": "local",
  "space_id": "1f2c...",
  "needs": [{ "role": "mailbox", "kind": "azure-app" }],
  "fill": [{ "role": "mailbox", "secret_id": "9ab3..." }],
  "package": "@scope/fetch-mail@1.2.3",
  "network": false,
  "run": { "command": "node", "args": ["index.js"] }
}
```

`execute` absent means `"server"`, so a server that never sends the field is
unaffected. `"local"` means the bridge runs the command on the operator's
machine and **never emits a `tool_call` frame** for it, which is the point once
the arguments include a decrypted secret: the plaintext must not reach the
network.

**A server cannot enable this.** The bridge honours `"local"` only when its
operator started it with `--local-tools`. Otherwise the tool is refused and the
refusal logged. This is deliberate: a local tool lets a server run commands on
someone else's machine, as them, and that has to be chosen rather than sent.

**`space_id`** is required for any local tool that touches a credential. Every
secret the bridge resolves is scoped to it, and a tool that names no space
resolves nothing: there is no unscoped lookup to fall back to. A tool defined
in a shared space cannot reach a credential that lives in a private space, by
name or by resolved id, however uniquely that credential is named.

**`needs`** declares what the tool wants by ROLE. **`fill`** says which
credential fills each role, as resolved secret IDs. The bridge injects each as
`ENGRAM_SECRET_<ROLE UPPERCASED>` (`-` becomes `_`), so a tool reads the role it
declared and never a credential name, and one `fetch_mail` serves three Azure
app registrations. Two roles that would become the same variable fail the call
rather than one silently overwriting the other.

**`secrets`** is the older name-based form, still honoured, and now resolved
strictly within `space_id`. A name a tool declared that its own space does not
hold **fails the call**; the tool is not run without it. A tool that runs
without a credential it declared does not fail cleanly, it connects as nobody or
writes an empty value, and the model reads whatever comes back as the tool
having worked.

**`package`** names an npm package, pinned exactly (`@scope/name@1.2.3`).
Installed with `--ignore-scripts`, into a directory of its own per space. A
range, a dist-tag, a `file:` spec or a git URL is refused.

**`network`** says what the tool needs from the network. `false` means none, and
on Linux the bridge enforces it with `unshare -rn`. A host list is **not**
enforced (per-host filtering is not implemented) and is reported as such.

`run.command` is executed with an argv array and no shell; the model's arguments
arrive as `ENGRAM_ARG_*` environment variables rather than on a command line, so
a value containing shell metacharacters is a string a program received, not
something the system interpreted. Two argument names that would become the same
variable (`a-b` and `a.b`) fail the call rather than one overwriting the other.

**`tools`**: Dynamic tool definitions sent from the server. These are the tools the AI can call during a conversation. The bridge injects these into the CLI's context (see [Tool Calls](#tool-calls)).

**`config.heartbeat_interval`**: Seconds between heartbeat pings. See [Heartbeat](#heartbeat).

**`config.request_timeout`**: Maximum seconds for a single AI request before timeout.

**`refreshed_token`** *(optional)*: Present when the server topped up an aging connection token at the handshake. The bridge replaces its current token with this value for future reconnects. See [Token lifetime](#token-lifetime).

### Server → Bridge: `token_refresh`

Sent at any time after the handshake to hand the bridge a fresh connection token — used for a long-lived bridge that stays connected without reconnecting, so it never picks up a `refreshed_token` via `welcome`.

```json
{
  "type": "token_refresh",
  "token": "<new JWT>"
}
```

The bridge replaces its current token with this value and uses it for subsequent reconnects. It does **not** reconnect in response to this message.

---

## Local Calls

> **Bridge-side only.** These frames are implemented in `@tetrixdev/ai-bridge`;
> `tetrixdev/laravel-ai-bridge` does not send or understand them, and a bridge
> that emits a `local_result` at it has the message logged as an unknown type
> and dropped. They are documented here because both packages share this file
> and a reader should know the protocol is this size — not because the Laravel
> server implements this half.

A `local_call` is the server asking the bridge to run one tool on the operator's
machine, directly. Unlike a `welcome`-registered local tool it is not something
a model decided to call: it is a panel, a job or a button invoking a tool a
person configured.

It goes through the **same gate**. A bridge started without `--local-tools`
refuses every `local_call` outright and answers with `ok: false`. There is one
way in, not one per message type.

### Server → Bridge: `local_call`

```json
{
  "type": "local_call",
  "id": "<uuid>",
  "space_id": "<uuid>",
  "tool": {
    "name": "fetch_mail",
    "command": "node",
    "args": ["/abs/path/index.js"],
    "package": "@scope/name@1.2.3",
    "network": false
  },
  "fill": [{ "role": "mailbox", "secret_id": "<uuid>" }],
  "input": { "since": "2026-08-01" }
}
```

- **`space_id`** scopes every credential this call can reach. Each `secret_id`
  in `fill` must name a secret that lives in this space. One that lives in
  another space is refused exactly as one that does not exist: a call cannot
  reach across spaces, by name or by id.
- **`fill`** carries resolved secret IDs, never names. The bridge does not turn
  a name into an id.
- **`input`** is passed to the tool as **one JSON document on stdin**. It is not
  flattened into environment variables.
- **`tool.package`**, when present, is installed before the run (pinned exactly,
  `--ignore-scripts`, one directory per space) and the tool runs with the
  package directory as its working directory. `ENGRAM_PACKAGE_DIR` points at it.
- **`tool.network`**: `false` means the tool runs with no network. A host list is
  not enforced. See the sandbox section below.

Each role in `fill` reaches the tool as `ENGRAM_SECRET_<ROLE UPPERCASED>`, with
`-` replaced by `_`. The tool reads the role it declared and never a credential
name.

### Bridge → Server: `local_result`

```json
{ "type": "local_result", "id": "<uuid>", "ok": true, "result": { } }
```

```json
{ "type": "local_result", "id": "<uuid>", "ok": false, "error": "text" }
```

The bridge always answers, for every `local_call` carrying an id, including one
it refuses before running anything. A server waiting forever on an id it will
never hear about again is the one outcome with no diagnosis.

**`result` is the tool's stdout, parsed.** A tool's stdout must be exactly one
JSON document. Credential values are scrubbed out of it **before** it is parsed,
so a credential cannot survive inside a JSON string. Stdout that is not one JSON
document (a log line, a stack trace, two documents) produces `ok: false` and the
text is **not** passed through: raw text arriving where a result belongs reads
to a model exactly like a tool that worked. Anything a tool prints for a human
belongs on stderr.

**`error`** is a sentence, already scrubbed of every credential the call
resolved. A non-zero exit, a timeout, a refused space, a rate limit and a parse
failure all arrive this way.

### Additive field: `sandbox`

A `local_result` may carry a `sandbox` object. A server that ignores it loses
nothing.

```json
{
  "type": "local_result", "id": "<uuid>", "ok": true, "result": { },
  "sandbox": {
    "filesystem": "node-permissions",
    "network": "open",
    "notes": ["per-host network filtering is not implemented, so the declared hosts (graph.microsoft.com) are NOT enforced and the tool has the whole network"]
  }
}
```

It reports what the bridge actually enforced, which is not always what the tool
asked for:

- **`filesystem`**: `node-permissions` when Node's permission model applied
  (only when the command is `node`), otherwise `none`.
- **`network`**: `namespace` when the tool ran with no network at all,
  otherwise `open`.
- **`notes`**: plain sentences naming everything that was **not** covered.

`unshare` is Linux only and `--permission` is Node only, so a non-Node command
on a non-Linux machine gets **no sandbox at all**. That case is reported here
rather than implied away.

### Rate limits

Per space: at most **2** local calls in flight, and starts spaced at least
**250ms** apart. A third concurrent call for the same space is refused with
`ok: false` rather than queued, because a queue is the same fork bomb with a
delay. A caller that sees this is usually re-rendering or retrying in a loop.

---

## AI Requests

### Server → Bridge: `ai_request`

When the server needs an AI response (triggered by a user message in the browser), it sends:

```json
{
  "type": "ai_request",
  "request_id": "req_abc123",
  "conversation_id": "conv_xyz789",
  "provider": "claude",
  "message": "The goblin chieftain steps forward, raising a gnarled staff...",
  "system_prompt": "You are a D&D Dungeon Master...",
  "cli_session_id": null,
  "history": [
    {"role": "user", "content": "I enter the cave"},
    {"role": "assistant", "content": "The cave mouth yawns before you..."}
  ],
  "options": {
    "max_tokens": 4096,
    "temperature": 0.8
  }
}
```

**`request_id`**: Unique identifier for this request. All streaming events reference it.

**`conversation_id`**: The server's conversation identifier.

**`provider`**: Which CLI to use. Must match one of the available providers from the handshake. If the requested provider is unavailable, the bridge responds with an error.

**`message`**: The new user message to send.

**`system_prompt`**: The system prompt. May be `null`.

**`cli_session_id`**: The CLI session to resume, or `null` to start a fresh session. **The server owns this mapping** (persisted per conversation) and is the single source of truth — the bridge keeps no session map of its own. See [Conversation Continuity](#conversation-continuity).

**`history`**: Prior conversation turns (`{role, content}`). Included only when `cli_session_id` is `null`, so a fresh CLI session can be seeded with context. Omitted when resuming — the resumed session already holds its history.

**`options`**: Provider-agnostic generation options. The bridge maps these to CLI-specific flags where supported.

#### Additive field: `working_dir`

Where the CLI should be spawned. Optional; **absent means today's behaviour exactly** — a freshly made empty directory under `~/.cache/ai-bridge/`.

```json
{
  "type": "ai_request",
  "request_id": "req_abc123",
  "working_dir": "/Users/jasper/zp-studio/zeroplex-studio/ZeroPlex_Studio__D09042"
}
```

It is honoured **only** when the operator started the bridge with `--allow-dir` and the path resolves inside one of those roots. Otherwise the turn is refused. The rules, all of them refusals rather than corrections:

| Condition | Result |
|---|---|
| Absent, on a fresh session | The empty scratch directory, as before. |
| Absent, on a resume | The directory that session already runs in — re-checked against the allow-list as it stands now, so a revoked directory is refused rather than reused. Servers **should** resend `working_dir` on every turn anyway — see the note below. |
| Bridge started without `--allow-dir` | `working_dir_not_allowed` |
| Not absolute, or contains a null byte | `working_dir_not_allowed` |
| Resolves outside every allowed root (after `realpath`, so a symlink inside a root that points out of it is caught) | `working_dir_not_allowed` |
| Inside an allowed root but does not exist, or is not a directory | `working_dir_not_found`. **The bridge never creates it.** |
| Present, and differs from the directory the resumed `cli_session_id` was started in | `working_dir_changed` |

There is deliberately **no silent fallback to the scratch directory**. A turn that quietly ran in an empty directory looks exactly like a turn that worked, and every answer in it is wrong.

A path outside the allow-list is reported identically whether or not it exists, so the bridge cannot be used as a filesystem probe.

**A working directory belongs to a CLI session for that session's life.** Resuming a session started elsewhere is incoherent — its history is all about another checkout — so it is refused with `working_dir_changed` and the server starts a fresh session deliberately.

A resume that names nothing keeps the directory the session already has. The bridge remembers that mapping across restarts (it persists to `~/.cache/ai-bridge/sessions.json`, shared by every bridge that user runs on the machine), but it is still a local record, bounded and advisory. Two cases follow from that:

- **A session it has no record of** — evicted by age, or started on another machine — resumes in the scratch directory, which for a workspace conversation is the wrong answer.
- **A remembered directory that is no longer permitted** — the operator narrowed `--allow-dir` — is refused with `working_dir_not_allowed`, and the turn does not run. The record never outlives the revocation.


So a server that supports workspaces **should send `working_dir` on every turn**, not only the first. It costs nothing, and it is the only thing that makes the outcome independent of what the bridge happens to remember.

**Consequence, and it is intended:** once `working_dir` is a real checkout, that repository's own `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` load, because the CLIs read them from cwd. That is the point of working in a checkout, not a leak. User-level files (`~/.claude/CLAUDE.md`) are a separate matter and load regardless — see `cli_isolation`.

#### Additive field: `attachments`

Files the assistant should be able to read this turn. References, never bytes:

```json
"attachments": [
  {
    "id": "att_9f3c",
    "name": "invoice.pdf",
    "mime_type": "application/pdf",
    "size": 482113,
    "sha256": "9f3c...",
    "url": "https://studio.example.com/ai-bridge/attachments/att_9f3c"
  }
]
```

Inlining the bytes is not an option worth trying. The server's WebSocket message cap is 1 MB, the bridge's client accepts 10 MB frames and the HTTP relay body cap is 16 MB — so a single screenshot, once base64 has added a third, already exceeds the tightest of them, and it would exceed it as a *dropped WebSocket message* rather than as an error anybody could act on.

So the bridge fetches each one instead:

1. **The URL must be on the origin this bridge is connected to** (derived from `--server`, or the explicit `--api` override), and it must be HTTPS — the sole exception being a loopback host, where there is no wire to eavesdrop on. Redirects are **not** followed, since an allowed origin answering `302` to anywhere it likes would make the check decorative. Anything else is refused with `attachment_refused`. Without this, a compromised or hostile server turns every connected bridge into a fetcher for arbitrary hosts, with the operator's own connection token attached.
2. It is streamed to a per-request directory under `~/.cache/ai-bridge/attachments/` — named from the request id plus a short digest of it, since two ids that sanitise alike must not share a directory and delete each other's files. **Never into the working directory**: a checkout must not be dirtied by the transport. If the file belongs in the repo, the developer asks the assistant to copy it there.
3. `name` is reduced to a single safe path component (separators of both kinds stripped, leading dots removed, length capped, collisions numbered). The server's filename is never trusted to be a path.
4. Per-file and per-request caps apply (`--attachment-max-mb`, `--attachment-total-mb`; 25 MB and 100 MB by default), enforced against the *declared* size before fetching and against the *actual* bytes while streaming. Over the cap is `attachment_too_large`.
5. `size` and `sha256` are verified afterwards. A mismatch fails the whole request with `attachment_failed` — a half-downloaded PDF is, to the model, indistinguishable from a genuinely corrupt one, so it would confidently report the wrong problem.
6. A short preamble naming the absolute paths, types and sizes is prepended to `message`, so the model knows the files exist and where they are. In `isolated`, where Claude's tool surface is otherwise restricted to `mcp__bridge__*`, a turn carrying attachments also gets a read rule **scoped to that turn's attachment directory** (`Read(/<dir>/**)`). Without it the preamble would name paths the model is not permitted to open, and the turn would end with it saying it cannot see a file the user had just attached. A bare `Read` would instead grant the whole filesystem — a server controls both the attachments and the message, so that would be arbitrary file read switched on by sending a field.
7. The request's attachment directory is deleted when the turn terminates — on `done`, `error` and `cancelled` alike. `--keep-attachments` retains it for debugging.

### Bridge → Server: `ai_request_ack`

The bridge acknowledges receipt before starting the CLI process, echoing the session it was asked to use:

```json
{
  "type": "ai_request_ack",
  "request_id": "req_abc123",
  "cli_session_id": null
}
```

**`cli_session_id`**: The `cli_session_id` from the `ai_request` (the session being resumed, or `null` for a fresh start). Informational. The *resulting* session id — the one created or continued — is reported later on the `done` event.

---

## Conversation Continuity

### The Problem

Web apps maintain conversation history as a list of messages. CLI tools maintain their own session state internally. We bridge these two models without duplicating context or losing history.

### The Solution: server-owned session resume

Each CLI maintains its own resumable session:

| Provider | Resume Command |
|----------|---------------|
| Codex    | `codex exec resume <SESSION_ID> "prompt"` |
| Claude   | `claude -p --resume <UUID> "prompt"` |
| Gemini   | `gemini -p "prompt" --resume <UUID>` |

The **server** owns the `conversation_id → cli_session_id` mapping (persisted in its database). The bridge is stateless about sessions: it does exactly what each `ai_request` tells it.

### How It Works

1. **First message** (`cli_session_id: null`): the bridge starts a fresh CLI session with the system prompt and user message; `history` (if any) is folded in as context. The CLI creates a session.

2. **Bridge reports the session id**: the resulting `cli_session_id` is returned to the server on the `done` event. The server persists it on the conversation.

3. **Subsequent messages**: the server sends the new user message with the stored `cli_session_id` (and no `history` — the session holds it). The bridge resumes that CLI session.

4. **Prompt caching**: works automatically — session resume uses each CLI's native context caching.

5. **Lost session** — see below.

### Session Lifecycle

```
Server                          Bridge                          CLI
  │                               │                              │
  │─ai_request(conv_1,msg,sess:null,history)─>│                  │
  │                               │──new session + msg─────────>│
  │                               │<─session_1 + response───────│
  │<─streaming events + done(cli_session_id: session_1)─────────│
  │  persist: conv_1 → session_1  │                              │
  │                               │                              │
  │─ai_request(conv_1,msg2,sess:session_1)──>│                   │
  │                               │──resume session_1 + msg2───>│
  │<─streaming events + done(cli_session_id: session_1)─────────│
```

### Lost session recovery (`session_lost`)

If the server sends a `cli_session_id` the bridge's CLI cannot resume (the session expired, the cache was cleared, or it was created on another machine), the bridge emits a stream `error` event with code **`session_lost`** and does **not** send `done`.

`session_lost` is recoverable, not fatal. The server:

1. Wipes the dead `cli_session_id` from the conversation.
2. Silently re-issues the **same** `request_id` as a fresh request (`cli_session_id: null`, full `history` included).
3. The browser keeps streaming on the same request — it never sees the lost session.

The re-issued turn produces its own `done` carrying a new `cli_session_id`, which the server persists. Recovery is attempted once per turn; a second failure surfaces as a normal error.

---

## Streaming Events

All AI responses are streamed as a series of events from bridge to server. The bridge normalizes different CLI output formats into this single protocol.

### Event Envelope

Every streaming event follows this structure:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "<event_type>",
  "data": {}
}
```

### Block Model

Responses consist of **blocks** — logical units of content that have explicit open and close events. This allows the server to track what's currently being generated and render it appropriately.

Block types:
- `thinking` — internal reasoning (if supported by provider)
- `text` — visible response text
- `tool_call` — a tool invocation

### Event Types

#### `block_start`

Opens a new block. The `block_index` is sequential within the response (0, 1, 2, ...).

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_start",
  "data": {
    "block_index": 0,
    "block_type": "thinking"
  }
}
```

For `tool_call` blocks, includes the tool name:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_start",
  "data": {
    "block_index": 1,
    "block_type": "tool_call",
    "tool_name": "roll_dice",
    "tool_call_id": "tc_001"
  }
}
```

#### `block_delta`

Incremental content within an open block.

For `thinking` and `text` blocks:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_delta",
  "data": {
    "block_index": 0,
    "content": "Let me consider the"
  }
}
```

For `tool_call` blocks (streaming the arguments JSON):

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_delta",
  "data": {
    "block_index": 1,
    "content": "{\"notation\": \"1d20\"}"
  }
}
```

#### `block_stop`

Closes a block. No further deltas for this `block_index` will be sent.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_stop",
  "data": {
    "block_index": 0
  }
}
```

#### `tool_result`

After the server executes a tool and returns the result (see [Tool Calls](#tool-calls)), the bridge acknowledges with this event before continuing generation:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "tool_result",
  "data": {
    "tool_call_id": "tc_001",
    "result": "You rolled a 17!"
  }
}
```

#### `attachment`

A file the assistant produced and chose to hand back. Emitted when the model calls the bridge-owned `bridge__attach_file` tool and the upload succeeded.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "attachment",
  "data": {
    "id": "att_new123",
    "name": "report.md",
    "mime_type": "text/markdown",
    "size": 4096,
    "description": "The migration report you asked for"
  }
}
```

`id` is the identifier the server assigned when the bridge uploaded the file to `POST /ai-bridge/attachments`, so the UI can render it from the server's own attachment store. A server that does not understand the event ignores it.

The tool is offered in `workspace` and `native` only. In `isolated` the CLI reaches server-declared tools and nothing else.

The model has to nominate the file, and that is not a limitation to work around: a transport cannot guess which of the hundred files a turn just touched is the answer. The path it names must resolve — **after `realpath`, because in `workspace` mode the model has a shell and can create a symlink** — inside the working directory or that turn's attachment directory, and it is subject to the same per-file cap and the same host binding as the inbound direction.

#### `done`

Signals the end of the AI response. No more events for this `request_id`.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "done",
  "data": {
    "usage": {
      "input_tokens": 1250,
      "output_tokens": 380
    },
    "cli_session_id": "session_def456"
  }
}
```

`usage` is optional — not all CLIs report token counts.

`cli_session_id` is the CLI session this turn ran under — the id created on a fresh start, or the id resumed. The server persists it on the conversation so the next turn can resume. Absent/`null` when no session id was produced.

#### `error`

An error occurred during generation.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "error",
  "data": {
    "code": "provider_error",
    "message": "Claude CLI exited with code 1: Rate limit exceeded"
  }
}
```

Notable `code` values:

- **`session_lost`** — the request asked to resume a `cli_session_id` the CLI could not find. Recoverable: the server wipes the stored session and silently re-issues the turn fresh (see [Lost session recovery](#lost-session-recovery-session_lost)). No `done` follows a `session_lost`.
- **`provider_error`** — a generic CLI/provider failure. Terminal; surfaced to the user.

### Example: Full Response Flow

A typical response with thinking, text, and a tool call:

```
→ block_start   {block_index: 0, block_type: "thinking"}
→ block_delta   {block_index: 0, content: "The player wants to attack..."}
→ block_delta   {block_index: 0, content: " I should ask for an attack roll."}
→ block_stop    {block_index: 0}
→ block_start   {block_index: 1, block_type: "text"}
→ block_delta   {block_index: 1, content: "You swing your sword at the goblin! "}
→ block_delta   {block_index: 1, content: "Let me roll for your attack..."}
→ block_stop    {block_index: 1}
→ block_start   {block_index: 2, block_type: "tool_call", tool_name: "roll_dice", tool_call_id: "tc_001"}
→ block_delta   {block_index: 2, content: "{\"notation\": \"1d20+5\"}"}
→ block_stop    {block_index: 2}
                                        ← tool_resolve (tc_001, result: "18")
→ tool_result   {tool_call_id: "tc_001", result: "18"}
→ block_start   {block_index: 3, block_type: "text"}
→ block_delta   {block_index: 3, content: "Your blade strikes true! With an 18, you hit the goblin..."}
→ block_stop    {block_index: 3}
→ done          {usage: {input_tokens: 850, output_tokens: 120}}
```

---

## Tool Calls

Tools allow the AI to invoke server-side functions (dice rolls, rule lookups, database queries, etc.) during a response. Tool definitions are dynamic — sent from server to bridge during the handshake.

### How Tools Work Per Mode

#### CLI Bridge Mode

CLI tools have varying levels of native tool support:
- **Codex**: Supports tools natively via MCP servers (`codex exec` with `--mcp-server`)
- **Claude**: Supports tools via `--allowedTools` and MCP, or via Bash tool
- **Gemini**: Tools via Bash approach

**Universal approach (Bash fallback)**: The bridge generates a temporary Bash script for each tool that, when called by the CLI, sends the tool call back through the WebSocket and waits for the result.

```bash
#!/bin/bash
# Auto-generated by ai-bridge for tool: roll_dice
# Sends tool call through WebSocket and blocks until result
ARGS="$1"
RESULT=$(ai-bridge-tool-call "roll_dice" "$ARGS")
echo "$RESULT"
```

The `ai-bridge-tool-call` helper is a small utility bundled with the bridge that:
1. Sends the tool call to the server via the existing WebSocket
2. Blocks until the server responds with the result
3. Prints the result to stdout for the CLI to consume

**Codex MCP approach**: For Codex specifically, the bridge can start an in-process MCP server that exposes the server's tools as MCP tools. This is more elegant but Codex-specific.

#### BYOK / Managed Mode

No bridge involved. The server calls the Chat Completions API directly. Tools are passed as the `tools` parameter in the API request. When the API returns a `tool_calls` response, the server executes the tools locally and sends the results back in the next API call. Standard Chat Completions tool calling flow.

### Tool Resolution Flow (CLI Bridge)

```
Server                          Bridge                          CLI
  │                               │                              │
  │                               │                              │
  │                               │   CLI calls bash tool ←──────│
  │                               │                              │
  │<──tool_call (roll_dice, {})──│   (bridge intercepts)        │
  │                               │                              │
  │   execute roll_dice locally   │                              │
  │                               │                              │
  │──tool_resolve (result: 18)──>│                              │
  │                               │   return "18" to CLI ───────>│
  │                               │                              │
```

### Server → Bridge: `tool_resolve`

After the server executes a tool, it sends the result back:

```json
{
  "type": "tool_resolve",
  "request_id": "req_abc123",
  "tool_call_id": "tc_001",
  "result": "You rolled a 17 (1d20+5: natural 12 + 5)"
}
```

### Server → Bridge: `tool_error`

If a tool execution fails:

```json
{
  "type": "tool_error",
  "request_id": "req_abc123",
  "tool_call_id": "tc_001",
  "error": "Unknown dice notation: 2z6"
}
```

The bridge passes this error back to the CLI, which typically incorporates it into its response ("I'm sorry, I made a mistake with the dice notation...").

---

## Heartbeat

Keeps the WebSocket alive and detects dead connections.

### Bridge → Server: `ping`

```json
{
  "type": "ping",
  "timestamp": 1718400000
}
```

### Server → Bridge: `pong`

```json
{
  "type": "pong",
  "timestamp": 1718400000
}
```

The bridge sends a `ping` every `config.heartbeat_interval` seconds (from `welcome` message, default 30s). If no `pong` is received within 10 seconds, the bridge considers the connection dead and initiates reconnection.

The server also tracks heartbeats. If no `ping` is received for 2x the heartbeat interval, the server marks the bridge as disconnected and notifies the browser (so the UI can show "Bridge disconnected").

---

## Error Handling

### Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| `invalid_token` | Connection token invalid or expired | User generates a new token in web UI |
| `provider_unavailable` | Requested CLI not installed on bridge | Server falls back or notifies user |
| `provider_error` | CLI exited with non-zero code | Retry or notify user |
| `session_lost` | A resume of the requested `cli_session_id` failed (session expired/cleared/created elsewhere) | Recoverable: server wipes the stored session and silently re-issues the turn fresh with history. No `done` follows |
| `timeout` | Request exceeded `request_timeout` | Server notifies user, can retry |
| `bridge_disconnected` | WebSocket connection lost | Auto-reconnect with backoff |
| `tool_error` | Tool execution failed | CLI handles gracefully in response |
| `rate_limited` | CLI provider rate limit hit | Exponential backoff, notify user |
| `provider_warning` | Non-fatal provider warning (e.g. content policy notice). The request continues; the message is informational | Surface to user as informational notice |
| `invalid_request` | Malformed request from server | Log and respond with error |
| `working_dir_not_allowed` | The `working_dir` is not inside a root the operator permitted with `--allow-dir` (or none were permitted). Also emitted on a turn that named NOTHING, when the directory its CLI session is remembered in has since been revoked | Operator restarts the bridge with `--allow-dir`, or the server offers only the `workspaces` from `hello`. Terminal: `done` follows |
| `working_dir_not_found` | The named `working_dir` is inside an allowed root but does not exist, or is not a directory. The bridge never creates it | Check the path. Terminal: `done` follows |
| `working_dir_changed` | A resume named a different directory from the one its CLI session was started in | Server starts a fresh session deliberately. Terminal: `done` follows |
| `attachment_refused` | An attachment URL is not on the connected server's origin, or is not HTTPS | Server fixes the URL (or the operator sets `--api`). Terminal: `done` follows |
| `attachment_too_large` | An attachment exceeds the per-file or per-request cap | Server sends a smaller file, or the operator raises `--attachment-max-mb` / `--attachment-total-mb`. Terminal: `done` follows |
| `attachment_failed` | An attachment could not be downloaded, or failed its size/checksum verification | Retry. Terminal: `done` follows |
| `gemini_working_dir_unavailable` | Gemini cannot use this working directory: the repository already has a `.gemini/settings.json`, or another Gemini turn is running in it | Move the file aside, use Claude or Codex, or wait for the other turn. Terminal: `done` follows |

All of the above are **refusals**: they carry their own code and are followed by `done`, which ends the turn. They are deliberately not reported as `session_lost` — that code tells the server to wipe the session and silently re-issue the turn, which for a refusal would retry it forever and never surface the reason.

### Bridge → Server: Error Response

For request-level errors (not streaming):

```json
{
  "type": "error",
  "request_id": "req_abc123",
  "code": "provider_unavailable",
  "message": "Provider \"codex\" is not available on this bridge.",
  "fatal": true
}
```

**`fatal`**: Hint to the server whether this error is fatal (`true`) or recoverable (`false`). A `provider_unavailable` error is fatal — no recovery is possible without operator action.

---

## Provider Reference

### CLI Invocation

How the bridge invokes each provider:

**Working directory**: every provider CLI is spawned in a dedicated empty directory, not the bridge process's own working directory. This prevents the CLIs from auto-loading project context files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) from whatever directory the bridge happened to be started in. User-level context files (e.g. `~/.claude/CLAUDE.md`) are unaffected — they load regardless of working directory.

#### Codex

```bash
# New session
codex exec --json --skip-git-repo-check --ephemeral -m <model> -- "user message"

# Resume session
codex exec resume <SESSION_ID> --json -m <model> "user message"

# With MCP tools
codex exec --json --mcp-server "ai-bridge-tools" "system prompt" <<< "user message"
```

Output: JSON streaming (NDJSON) to stdout. Bridge parses and normalizes to protocol events.

#### Claude

```bash
# New session
claude -p --output-format stream-json --verbose "user message"

# Resume session
claude -p --session-id <UUID> --output-format stream-json --verbose "user message"

# With tools (bash approach)
claude -p --output-format stream-json --verbose --allowedTools "bash" "user message"
```

Output: JSON lines to stdout. Bridge parses and normalizes.

System prompt: Passed via `--system-prompt` flag on first message. Retained in session on resume.

#### Gemini

```bash
# New session
gemini --prompt "user message" --output-format stream-json --skip-trust

# Resume session
gemini --prompt "user message" --resume <UUID> --output-format stream-json --skip-trust
```

Output: NDJSON streaming to stdout. Bridge parses and normalizes.

### Feature Matrix

| Feature | Codex | Claude | Gemini |
|---------|-------|--------|--------|
| Streaming | Yes (JSON) | Yes (JSON lines) | Yes (text) |
| Thinking/reasoning | Yes | Yes (extended thinking) | Partial |
| Native tool calls | Yes (MCP) | Yes (allowedTools) | No |
| Bash tool fallback | Yes | Yes | Yes |
| Session resume | Yes | Yes | Yes |
| System prompt | Yes | Yes | Yes |
| Token usage reporting | Yes | Yes | No |
| Max output control | Yes | Yes | Partial |

### Output Normalization

Each provider outputs differently. The bridge normalizes:

**Codex** outputs structured JSON events:
```json
{"type": "thinking", "content": "..."}
{"type": "text", "content": "..."}
{"type": "tool_call", "name": "roll_dice", "arguments": {...}}
```

**Claude** outputs JSON lines:
```json
{"type": "content_block_start", "content_block": {"type": "thinking", ...}}
{"type": "content_block_delta", "delta": {"text": "..."}}
{"type": "content_block_stop"}
```

**Gemini** outputs structured NDJSON events that the bridge parses and normalizes:
```json
{"type":"init","session_id":"...","model":"...","timestamp":"..."}
{"type":"message","role":"assistant","content":"...","delta":true,"timestamp":"..."}
{"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{},"timestamp":"..."}
{"type":"tool_result","tool_id":"...","status":"success","output":"...","timestamp":"..."}
{"type":"error","severity":"warning|error","message":"...","timestamp":"..."}
{"type":"result","status":"success|error","stats":{"input_tokens":...,"output_tokens":...},"timestamp":"..."}
```

The bridge maps all of these to the unified `block_start` / `block_delta` / `block_stop` event model defined in [Streaming Events](#streaming-events).

---

## Message Type Summary

### Bridge → Server

| Type | When |
|------|------|
| `hello` | After WebSocket connects |
| `ping` | Every heartbeat interval |
| `ai_request_ack` | After receiving an `ai_request` |
| `stream` (block_start) | Opening a content block |
| `stream` (block_delta) | Incremental content within a block |
| `stream` (block_stop) | Closing a content block |
| `stream` (tool_result) | Acknowledging tool result received |
| `stream` (done) | Response complete |
| `stream` (error) | Error during streaming |
| `tool_call` | CLI invoked a server-side tool (via callback) |
| `local_result` | Answering a `local_call`, run or refused |
| `error` | Request-level error (non-streaming) |

### Server → Bridge

| Type | When |
|------|------|
| `welcome` | After receiving `hello` |
| `pong` | After receiving `ping` |
| `ai_request` | New AI request for a conversation |
| `tool_resolve` | Returning tool execution result |
| `tool_error` | Tool execution failed |
| `local_call` | Asking the bridge to run one tool on this machine |

---

## Security Considerations

### User Responsibility

The bridge runs **locally on the user's machine** using **their own CLI tools** authenticated with **their own subscriptions**. The server (Dungeon Maister or any other app using this protocol) never:

- Touches the user's OAuth tokens
- Accesses the user's CLI credentials
- Stores any authentication material for the AI providers

### Connection Token

- Long-lived JWT (default: 30 days) topped up by the server before it expires — see [Token lifetime](#token-lifetime)
- Scoped to `ai-bridge` (cannot be used for other API calls)
- User can revoke and regenerate at any time via the web UI; regenerating actively disconnects the previous bridge
- One active bridge connection per user (new connection supersedes old)

### Data in Transit

- WebSocket MUST use `wss://` (TLS) in production
- Tool results may contain sensitive game/app data — encrypted in transit via TLS
- Bridge should never log full request/response payloads by default (opt-in debug mode)

### CLI Tool Policies

Users are responsible for complying with their AI provider's terms of service. The bridge README, first-run prompt, web app settings page, and application ToS should include appropriate disclaimers.

**Current policy summary (May 2026):**
- **Codex**: Most permissive. Apache 2.0 SDK, official MCP support, subscription OAuth works in external tools
- **Claude**: Users CAN run third-party tools (draws from Agent SDK credit pool). Developers must NOT offer claude.ai login integration
- **Gemini**: OAuth piggybacking banned, but API key + headless mode (`gemini -p`) explicitly allowed

---

## Versioning

The protocol version is exchanged during handshake (`hello.version`). The server and bridge must agree on the major version. Minor version differences are backward-compatible.

- `0.x` — Pre-release, breaking changes allowed between minor versions
- `1.x` — Stable, semantic versioning applies

**Workspaces, attachments and `workspace` isolation do not bump the version.** They stay on `0.1`, deliberately. Every one of them is optional in both directions — `hello.workspaces`, `ai_request.working_dir`, `ai_request.attachments`, the `attachment` stream event and the `workspace` value of `cli_isolation` are all additive, and both ends already ignore fields they do not recognise. Only the major number is enforced, so a bump would refuse every bridge already installed in exchange for nothing.

---

## BYOK / Managed: Server-Side Only

For BYOK and Managed modes, the bridge is not involved. The server handles everything:

1. User configures endpoint URL + API key in web UI (BYOK) or app provides its own (Managed)
2. Server sends Chat Completions API request directly:
   ```
   POST {endpoint_url}/v1/chat/completions
   Authorization: Bearer {api_key}
   ```
3. Server streams the response to the browser via SSE
4. Tool calls are handled server-side using standard Chat Completions `tools` parameter

The Laravel package (`laravel-ai-bridge`) provides a unified interface:

```php
// Same interface regardless of mode
$bridge->stream($conversation, $message, function (StreamEvent $event) {
    // Normalized events — same format whether from CLI bridge,
    // BYOK API, or managed endpoint
    match ($event->type) {
        'block_start' => handleBlockStart($event),
        'block_delta' => handleBlockDelta($event),
        'block_stop'  => handleBlockStop($event),
        'tool_call'   => handleToolCall($event),
        'done'        => handleDone($event),
    };
});
```

This is the core value proposition of the Laravel package: **one streaming interface, three AI modes**.
