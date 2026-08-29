# @tetrixdev/ai-bridge

A local CLI bridge that connects your AI command-line tools (Codex, Claude, Gemini) to web applications via WebSocket. The bridge runs on your machine, receives AI requests from a server, pipes them through your locally installed CLI tools, and streams normalized responses back -- letting web apps use your own AI subscriptions without touching your credentials.

## Quick Start

The **connection token** is generated from the web application that uses the AI Bridge server package (for example, `php artisan ai-bridge:token` for Laravel apps). The **server URL** is the WebSocket server address provided by that application (typically `wss://your-app.com/api/ai-bridge/ws`).

```bash
npx @tetrixdev/ai-bridge --server wss://your-app.com/api/ai-bridge/ws --token YOUR_CONNECTION_TOKEN
```

Or using environment variables:

```bash
export AI_BRIDGE_SERVER=wss://your-app.com/api/ai-bridge/ws
export AI_BRIDGE_TOKEN=YOUR_CONNECTION_TOKEN
npx @tetrixdev/ai-bridge
```

## Options

| Flag | Environment Variable | Description |
|------|---------------------|-------------|
| `--server <url>` | `AI_BRIDGE_SERVER` | WebSocket server URL (`wss://...`) |
| `--token <token>` | `AI_BRIDGE_TOKEN` | Connection token from the web app |
| `--test` | | Test mode -- responds with mock data instead of calling real CLIs |
| `--debug` | | Enable verbose debug logging |
| `--log-file <path>` | `AI_BRIDGE_LOG_FILE` | Also append logs to this file. Rotates once past 5 MB, keeping one previous copy (`<path>.1`) |
| `--local-tools` | | Allow the server to run tools **on this machine, as you**. Off unless you pass it |
| `--engram <url>` | `ENGRAM_URL` | Engram base URL, for resolving secrets into local tools |
| `--engram-token <token>` | `ENGRAM_TOKEN` | Bearer credential for Engram. Defaults to `--token` |
| `--device-label <label>` | | How this machine appears when you approve it |
| `--device-mode <mode>` | | `transcript` or `isolated`. Self-reported |
| `--identity-file <path>` | `ENGRAM_IDENTITY` | Where the device keypair lives (default `~/.engram/device.json`) |

## Local tools

By default every tool call round-trips to the server, and the server runs it.
That is what the bridge has always done, and nothing below changes it unless you
ask for it.

`--local-tools` lets a server mark a tool `execute: "local"`, which the bridge
then runs **here**, with secrets it decrypts locally. This is a real step up in
trust: the server stops being something that runs code on its own machine and
becomes something that runs code on yours, as you. It is the same trust you
extend to any npm package you install, but it should be chosen rather than
inherited, so:

- without `--local-tools`, a tool marked `local` is **refused**, whatever the
  server sends, and the refusal is logged rather than silent
- a server cannot turn it on by sending a field
- an absent `execute` field means `server`, so existing servers are unchanged

### Why the secret never reaches the server

A local tool call never becomes a `tool_call` frame. The bridge holds a keypair
whose private half never leaves the machine, Engram hands back a space key
wrapped to that public half, and the secret is opened here. The server stores
ciphertext and cannot read it.

```
ai-bridge --server wss://app.example.com/bridge --token ... \
          --local-tools --engram https://engram.example.com
```

On first run this generates a keypair, enrols it, and prints a fingerprint:

```
  This device is waiting to be approved.
  Open Engram, go to Vault, and check these five groups match:

      S35F M2C7 F2SY FDH7 NQHP
```

**Compare them and do not skip it.** That check is what catches a server that
substituted a key of its own during enrolment. Without it the encryption still
runs, every screen still looks right, and the server can read everything.

### What redaction does and does not do

Secrets reach a tool as environment variables, and the bridge removes those
exact values from stdout and stderr before the model sees them. That turns an
accidental `echo $DB_PASSWORD` from a leak into `[redacted: DB_PASSWORD]`, and
catches the likelier accident, which is a tool printing a connection string in
an error message.

It is hygiene, not containment. `| base64` defeats it in one word, as does
writing the value to a file. A tool you approved can always use a secret it was
given; what redaction buys is that the value stays out of a transcript that gets
logged, cached and stored elsewhere.

## Supported Providers

| Provider | CLI Binary | Session Resume | Streaming | Thinking | Server Tools |
|----------|-----------|----------------|-----------|----------|--------------|
| **Codex** (OpenAI) | `codex` | Yes | NDJSON | Yes | Yes |
| **Claude** (Anthropic) | `claude` | Yes | NDJSON | Yes | Yes |
| **Gemini** (Google) | `gemini` | Yes | NDJSON | Partial | Yes |

The bridge auto-detects which CLIs are installed on startup.

**Server-defined tools** registered by the web application are exposed to every provider as Bash wrapper scripts placed on the CLI's `PATH`; the CLI invokes them as ordinary shell commands and the bridge routes the call back through the WebSocket. For Codex, the bridge runs `codex exec` with a workspace-write sandbox and network access enabled so the wrapper scripts can reach the bridge — this is handled automatically when tools are present.

## Test Mode

Use `--test` to verify your WebSocket connection and protocol behaviour without needing a real CLI installed. Note that `--server` and `--token` are still required in test mode — the WebSocket connection to the server is what test mode exercises.

```bash
npx @tetrixdev/ai-bridge --server wss://your-app.com/api/ai-bridge/ws --token TOKEN --test
```

In test mode, AI requests receive mock streaming responses (thinking block + text block + done event) that exercise the full protocol.

## Troubleshooting

**Get detailed diagnostics with `--debug`**
For detailed diagnostic output, add `--debug` to the command. This logs each WebSocket message, provider command, and session operation, which is the fastest way to pin down a confusing error before filing a support request.

**"Authentication token is required" / "Server URL is required"**
The token is generated by your web application (e.g. `php artisan ai-bridge:token` for Laravel apps). The server URL is the WebSocket endpoint exposed by that application (typically `wss://your-app.com/api/ai-bridge/ws`). See your application's documentation for the exact values.

**"Connection rejected: invalid or expired token"**
Your token has expired or was revoked. Generate a new one from your web application's admin interface and restart the bridge.

**"No AI CLI tools detected"**
Install one or more supported CLIs:
- Codex: https://github.com/openai/codex
- Claude: https://claude.ai/download
- Gemini: https://github.com/google-gemini/gemini-cli

**"Authentication required — run \`<provider\> auth login\`"**
Your AI CLI's authentication session has expired. Run the indicated login command (e.g. `claude auth login`) and then restart the bridge.

**Where are sessions stored?**
Session mappings are persisted to `~/.ai-bridge/sessions.json` so conversations can be resumed across bridge restarts. You can delete this file to clear all sessions.

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the full wire format specification.

## License

MIT
