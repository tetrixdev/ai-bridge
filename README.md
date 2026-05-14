# @tetrixdev/ai-bridge

A local CLI bridge that connects your AI command-line tools (Codex, Claude, Gemini) to web applications via WebSocket. The bridge runs on your machine, receives AI requests from a server, pipes them through your locally installed CLI tools, and streams normalized responses back -- letting web apps use your own AI subscriptions without touching your credentials.

## Quick Start

```bash
npx @tetrixdev/ai-bridge --server=wss://your-app.com/api/ai-bridge/ws --token=YOUR_CONNECTION_TOKEN
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

## Supported Providers

| Provider | CLI Binary | Session Resume | Streaming | Thinking |
|----------|-----------|----------------|-----------|----------|
| **Codex** (OpenAI) | `codex` | Yes | JSON | Yes |
| **Claude** (Anthropic) | `claude` | Yes | JSON lines | Yes |
| **Gemini** (Google) | `gemini` | Yes | Text | Partial |

The bridge auto-detects which CLIs are installed on startup.

## Test Mode

Use `--test` to verify your WebSocket connection without needing a real CLI installed:

```bash
npx @tetrixdev/ai-bridge --server=wss://your-app.com/api/ai-bridge/ws --token=TOKEN --test
```

In test mode, AI requests receive mock streaming responses (thinking block + text block + done event) that exercise the full protocol.

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the full wire format specification.

## License

MIT
