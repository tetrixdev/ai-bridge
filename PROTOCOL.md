# AI Bridge Protocol v0.1

Specification for the WebSocket protocol between `@tetrixdev/ai-bridge` (npm, client-side) and `tetrixdev/laravel-ai-bridge` (Composer, server-side).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Modes of Operation](#modes-of-operation)
- [Connection](#connection)
- [Handshake](#handshake)
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

The bridge connects to the server's WebSocket endpoint:

```
wss://{host}/api/ai-bridge/ws?token={connection_token}
```

The `connection_token` is a short-lived JWT obtained by the user through the web application's settings page. It encodes:

```json
{
  "sub": "user_id",
  "exp": 1718400000,
  "scope": "ai-bridge"
}
```

The server validates the token on connection. If invalid or expired, the server closes the WebSocket with code `4001` and reason `"invalid_token"`.

### Reconnection

The bridge implements exponential backoff reconnection:

| Attempt | Delay    |
|---------|----------|
| 1       | 1s       |
| 2       | 2s       |
| 3       | 4s       |
| 4       | 8s       |
| 5+      | 15s (cap)|

On reconnect, the bridge sends a new `hello` message. The server re-associates the connection with the user. Active session mappings (conversation_id to cli_session_id) are preserved in the bridge's local state and survive reconnects.

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
  }
}
```

**`tools`**: Dynamic tool definitions sent from the server. These are the tools the AI can call during a conversation. The bridge injects these into the CLI's context (see [Tool Calls](#tool-calls)).

**`config.heartbeat_interval`**: Seconds between heartbeat pings. See [Heartbeat](#heartbeat).

**`config.request_timeout`**: Maximum seconds for a single AI request before timeout.

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
  "options": {
    "max_tokens": 4096,
    "temperature": 0.8
  }
}
```

**`request_id`**: Unique identifier for this request. All streaming events reference it.

**`conversation_id`**: The server's conversation identifier. The bridge maps this to a local CLI session ID for continuity (see [Conversation Continuity](#conversation-continuity)).

**`provider`**: Which CLI to use. Must match one of the available providers from the handshake. If the requested provider is unavailable, the bridge responds with an error.

**`message`**: The new user message to send. This is NOT the full conversation history — the bridge uses session resume to maintain context (see [Conversation Continuity](#conversation-continuity)).

**`system_prompt`**: The system prompt. Sent on the first request for a conversation. On subsequent requests (session resume), this field is omitted — the CLI retains it from the original session.

**`options`**: Provider-agnostic generation options. The bridge maps these to CLI-specific flags where supported.

### Bridge → Server: `ai_request_ack`

The bridge acknowledges receipt before starting the CLI process:

```json
{
  "type": "ai_request_ack",
  "request_id": "req_abc123",
  "cli_session_id": "session_def456"
}
```

For the first message of a new conversation (no existing session found), `cli_session_id` is `null`:

```json
{
  "type": "ai_request_ack",
  "request_id": "req_abc123",
  "cli_session_id": null
}
```

**`cli_session_id`**: The local CLI session ID being used (resumed), or `null` when the bridge is starting a new CLI session. Informational — the server does not need to store this.

---

## Conversation Continuity

### The Problem

Web apps maintain conversation history as a list of messages. CLI tools maintain their own session state internally. We need to bridge these two models without duplicating context or losing history.

### The Solution: Session-Based Resume

None of the supported CLIs accept a raw messages array. All use session-based resume:

| Provider | Resume Command |
|----------|---------------|
| Codex    | `codex exec resume <SESSION_ID> "prompt"` |
| Claude   | `claude -p --session-id <UUID> "prompt"` |
| Gemini   | `gemini -p "prompt" --resume <UUID>` |

### How It Works

1. **First message** in a conversation: Bridge starts a new CLI session with the system prompt and user message. The CLI creates a local session and returns a session ID.

2. **Bridge stores mapping**: `conversation_id → cli_session_id` in local state (in-memory map, persisted to `~/.ai-bridge/sessions.json`).

3. **Subsequent messages**: Server sends only the new user message (not full history). Bridge looks up the `cli_session_id` for the `conversation_id` and resumes the session.

4. **Prompt caching**: Works automatically — the CLI's session resume uses its native context caching.

5. **Session not found**: If the bridge can't find a local session (e.g., after machine restart, cleared cache), it responds with a `session_expired` error. The server can then either:
   - Send a `session_reset` with the full conversation history for replay
   - Start a fresh conversation

### Session Lifecycle

```
Server                          Bridge                          CLI
  │                               │                              │
  │──ai_request (conv_1, msg)───>│                              │
  │                               │──new session + msg─────────>│
  │                               │<─session_id + response──────│
  │                               │  store: conv_1 → session_1  │
  │<──streaming events───────────│                              │
  │                               │                              │
  │──ai_request (conv_1, msg2)──>│                              │
  │                               │  lookup: conv_1 → session_1 │
  │                               │──resume session_1 + msg2───>│
  │                               │<─response───────────────────│
  │<──streaming events───────────│                              │
```

### Server → Bridge: `session_reset`

When the bridge reports a lost session, the server can replay history:

```json
{
  "type": "session_reset",
  "request_id": "req_abc123",
  "conversation_id": "conv_xyz789",
  "provider": "claude",
  "system_prompt": "You are a D&D Dungeon Master...",
  "history": [
    {"role": "user", "content": "I enter the cave"},
    {"role": "assistant", "content": "The cave mouth yawns before you..."},
    {"role": "user", "content": "I light my torch"}
  ],
  "options": {
    "max_tokens": 4096
  }
}
```

On `session_reset`, the bridge starts a **new** CLI session and feeds the history as a structured prompt preamble (formatted as a conversation transcript), followed by the last user message. This is a lossy recovery — prompt caching benefits are lost, but the conversation continues.

### Session Persistence

The bridge persists session mappings to `~/.ai-bridge/sessions.json`:

```json
{
  "conv_xyz789": {
    "provider": "claude",
    "cli_session_id": "session_def456",
    "created_at": "2026-05-14T10:30:00Z",
    "last_used_at": "2026-05-14T11:45:00Z",
    "system_prompt": "You are a helpful assistant."
  }
}
```

**`system_prompt`**: The system prompt used when the conversation was first started. Stored so that session resets can restore the original instructions even when the server omits `system_prompt` from the `session_reset` message. May be `null` if no system prompt was provided.

Sessions are pruned after 7 days of inactivity.

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
    }
  }
}
```

`usage` is optional — not all CLIs report token counts.

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
| `session_expired` | CLI session not found locally (no resume attempted) | Server sends `session_reset` or starts fresh |
| `cannot_resume` | A resume of an existing CLI session failed | Bridge has cleared the stale session; server replays history via `session_reset`, or the next turn starts fresh automatically |
| `timeout` | Request exceeded `request_timeout` | Server notifies user, can retry |
| `bridge_disconnected` | WebSocket connection lost | Auto-reconnect with backoff |
| `tool_error` | Tool execution failed | CLI handles gracefully in response |
| `rate_limited` | CLI provider rate limit hit | Exponential backoff, notify user |
| `provider_warning` | Non-fatal provider warning (e.g. content policy notice). The request continues; the message is informational | Surface to user as informational notice |
| `invalid_request` | Malformed request from server | Log and respond with error |

### Bridge → Server: Error Response

For request-level errors (not streaming):

```json
{
  "type": "error",
  "request_id": "req_abc123",
  "code": "session_expired",
  "message": "No local session found for conversation conv_xyz789",
  "fatal": false
}
```

**`fatal`**: Hint to the server whether this error is fatal (`true`) or recoverable (`false`). A `session_expired` error is non-fatal — the server can recover by sending `session_reset`. A `provider_unavailable` error is fatal — no recovery is possible without operator action.

---

## Provider Reference

### CLI Invocation

How the bridge invokes each provider:

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
| `error` | Request-level error (non-streaming) |

### Server → Bridge

| Type | When |
|------|------|
| `welcome` | After receiving `hello` |
| `pong` | After receiving `ping` |
| `ai_request` | New AI request for a conversation |
| `session_reset` | Replay conversation after lost session |
| `tool_resolve` | Returning tool execution result |
| `tool_error` | Tool execution failed |

---

## Security Considerations

### User Responsibility

The bridge runs **locally on the user's machine** using **their own CLI tools** authenticated with **their own subscriptions**. The server (Dungeon Maister or any other app using this protocol) never:

- Touches the user's OAuth tokens
- Accesses the user's CLI credentials
- Stores any authentication material for the AI providers

### Connection Token

- Short-lived JWT (default: 24 hours)
- Scoped to `ai-bridge` (cannot be used for other API calls)
- User can revoke and regenerate at any time via the web UI
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
