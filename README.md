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
| `--local-data-dir <path>` | `AI_BRIDGE_DATA_DIR` | Where npm packages for local tools are installed, one directory per space (default `~/.ai-bridge`) |
| `--allow-dir <path>[=<label>]` | `AI_BRIDGE_ALLOWED_DIRS` | Permit the server to run turns in this directory. Repeatable; the environment variable is path-separator delimited (`:` on POSIX, `;` on Windows). **Off unless you pass it** — without it a named working directory is refused, and so is `workspace` isolation. Read [Working in a repository](#working-in-a-repository) first |
| `--api <url>` | `AI_BRIDGE_API` | Base URL of the server's HTTP API for attachments, when it is not the same host as `--server`. Defaults to the `https://` origin of `--server` |
| _(no flag)_ | `AI_BRIDGE_DISABLE_PARTIAL_STREAMING` | Set to `1` to make Claude answers arrive one block at a time instead of streaming in chunks. An escape hatch for a CLI whose partial output misbehaves; the bridge already falls back on its own when the CLI does not support partial messages at all |
| `--attachment-max-mb <n>` | | Largest single attachment to download (default `25`) |
| `--attachment-total-mb <n>` | | Largest total of attachments per request (default `100`) |
| `--allow-native` | | Permit the server to select `native` isolation — the CLI's full local environment, including your own MCP servers, hooks, plugins and a shell. **Off unless you pass it.** Only for a bridge you run against your own machine |
| `--keep-attachments` | | Keep downloaded attachments after a turn instead of deleting them. Debugging aid |

## Working in a repository

By default every CLI is spawned in a dedicated empty directory, so a chat can talk about code but cannot touch any. Pass `--allow-dir` and the server may ask the assistant to work inside a real checkout instead — read a repository, edit it, run the tests, commit.

```bash
npx @tetrixdev/ai-bridge \
  --server wss://studio.example.com/api/ai-bridge/ws \
  --token "$AI_BRIDGE_TOKEN" \
  --allow-dir ~/zp-studio=Studio
```

### The posture is server-sent; the capability is yours

> Full detail — how `isolated` is enforced, what it does not stop, and how to
> check it on your own machine — is in [docs/isolation.md](docs/isolation.md).

The server chooses how much the CLI may do, by sending `cli_isolation` on the
handshake. [PROTOCOL.md](PROTOCOL.md) gives the per-CLI flags; the shape is:

| Posture | The CLI may... | Your own environment... |
|---|---|---|
| `isolated` (the default, and what an older server gets) | reach server-declared tools only. No shell, no edits — **subject to the caveat below**. | stays out, except your permission settings. |
| `workspace` | **also use its own file and shell tools**, in the directory the server named. | stays out — your MCP servers, hooks and plugins are still excluded. |
| `native` | do anything the CLI can do. | is fully in play. |

> **What `isolated` does and does not enforce.** The bridge states the posture
> explicitly rather than trusting whatever the CLI happens to be configured to
> do: Claude is run with `--permission-mode manual` and Codex with
> `sandbox_mode=read-only`, so a `permissions.defaultMode: "auto"` in your
> `~/.claude/settings.json` — or a permissive `~/.codex/config.toml` — no
> longer widens what a server can do on your machine. Verified against Claude
> 2.1.260 both ways: with the flag an isolated turn is denied an arbitrary file
> read and an arbitrary shell command; without it, that same setting allowed
> both.
>
> **Gemini is the exception.** It offers no equivalent lever — `--yolo` is on or
> off, and its built-in tools otherwise stall on an approval that headless mode
> cannot answer — so an `isolated` Gemini turn is bounded by Gemini's own
> defaults and by whatever is in `~/.gemini/settings.json`. If your server is
> reachable by people you do not trust, do not offer Gemini.
>
> **What still leaks in `isolated`, on every provider:** user-level instruction
> files, skills, hooks and plugins load, because suppressing them needs `--bare`
> (Claude) or HOME redirection, and `--bare` breaks subscription auth. Those are
> the operator's own configuration rather than something a server chooses, but
> they do shape the turn.

The bridge tells the server which posture it settled on, so an app can show "running `isolated`, because this bridge was started without `--allow-native`" rather than leaving you to find it in this machine's log.

**Both of the permissive postures require an operator opt-in.** `workspace`
needs `--allow-dir`; `native` needs `--allow-native`. A bridge started without
them refuses that posture and runs `isolated` instead, saying so in the log.

This matters more than it looks. `workspace` is what enables the shell, and a
shell in an empty scratch directory is still a shell — so if the allow-list
bounded only the *directory*, a server could switch the capability on by
sending a field. And gating `workspace` alone would have been theatre, because
`native` is strictly broader: a server refused the shell one way would simply
ask for it the other way and get the operator's own MCP servers, hooks and
plugins along with it. Same rule as `--local-tools`, in all three cases: the
operator opts in, never the server.

The bridge advertises what you allowed in its handshake, so the app can show a picker of your checkouts rather than asking you to type a path. A request naming anything outside those roots is refused, and so is one naming a directory that does not exist — the bridge never creates it, because a typo that silently starts an empty session looks exactly like a session that worked.

A working directory belongs to a CLI session for that session's life: a later turn on the same conversation that names a different directory is refused rather than resumed into a session whose history is about somewhere else.

Once cwd is a real checkout, that repository's own `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` load. That is intended — it is the point of working in a checkout.

### Read this before using it

> Once a server may name a working directory and the CLI has shell, the bridge runs code chosen by the server, on this machine, as you. The allow-list bounds where the assistant **starts**, not what it can **reach**: `cd ..` and `~/.ssh` are one command away, and no flag in this table changes that.
>
> The controls that actually carry the weight are: the allow-list is opt-in and empty by default, so a bridge started without `--allow-dir` cannot be pointed anywhere; the connection token is per person and revocable; and you should only connect a bridge to a server you would give a shell to.

`workspace` is a narrower blast radius than `native`, and a real one. It is **not** a sandbox, and nothing here should be read as claiming otherwise. Codex is bounded more tightly than the others (`sandbox_mode=workspace-write` rather than `danger-full-access`); Gemini is bounded least, because `--yolo` is the only lever it offers and there is no middle setting.

### Gemini leaves a file in your checkout, briefly

Gemini has no per-invocation MCP config flag — it reads `.gemini/settings.json` from its working directory. Pointed at a checkout, the bridge therefore writes one there. It handles that explicitly: it **refuses the turn rather than overwriting** a `.gemini/settings.json` your repository already has, deletes the one it wrote when the turn ends — on success, error, cancel, and on the bridge process exiting, so a SIGTERM mid-turn does not leave a stale file that blocks that checkout for good — and removes the `.gemini` directory too if it created it and left it empty. A `SIGKILL` is the one case nothing can clean up; delete the file by hand if you ever see one. Two Gemini turns cannot run in one directory at the same time — the second is refused, because the file holds a per-spawn credential and the loser would read the winner's.

Claude and Codex take their MCP configuration per invocation and never write anything into your checkout.

Two Gemini turns *without* a working directory still share the bridge's scratch
directory and so still race on that one file — a pre-existing wrinkle this
release does not fix, because the fix is a per-turn scratch directory for every
provider. Claude and Codex are unaffected.

## Attachments

A file attached in the chat does not travel over the WebSocket — the server's frame cap is 1 MB, so a screenshot would not fit, and would not fit as a *dropped message* rather than an error. The server sends a reference instead and the bridge fetches it:

- only from the origin it is connected to (or `--api`), only over HTTPS, and never following a redirect;
- into a per-request directory under `~/.cache/ai-bridge/attachments/`, **never into your checkout**;
- verified against the declared size and SHA-256, failing the turn loudly on a mismatch rather than handing the model a truncated file it will describe as corrupt;
- deleted when the turn ends — on success, error, cancel, and on the bridge process exiting.

The assistant can send a file back the same way, by calling a bridge-owned tool with a path inside the working directory or that turn's attachment directory. That tool is offered in `workspace` and `native` only. In `isolated`, Claude reaches server-declared tools plus — on a turn that has attachments — permission to read that turn's attachment directory, and nothing else. Codex and Gemini have no equivalent per-path grant: Codex sits at its own read-only sandbox and Gemini at its own defaults, both of which are broader than that. See the posture table in [PROTOCOL.md](PROTOCOL.md). It has to nominate the file itself: nothing else can tell which of the files a turn touched is the answer.

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
- a `local_call` frame, which is a server asking the bridge to run a tool
  directly rather than a model calling one, goes through the same gate and is
  refused outright by the same flag. There is one way in, not one per message
  type
- a server cannot turn it on by sending a field
- an absent `execute` field means `server`, so existing servers are unchanged

### Every credential belongs to one space

A local tool is defined in a space, and it can reach that space's credentials
and nothing else. That is enforced at the lookup, not by convention: the bridge
keeps decrypted secrets space by space, and every resolution names the space it
is allowed to look in. A tool from a shared space asking for a credential that
lives in your private space is refused, whether it asks by name or by resolved
id, and whether or not the name happens to be unique.

This is worth stating plainly because the earlier design got it wrong in a way
that looked fine: everything the device could decrypt went into one flat map,
names were exposed bare, and a bare name resolved against all of it. The only
thing standing between a shared tool and a private credential was a name
collision, and colliding names were dropped, so the reachable credentials were
exactly the uniquely named ones.

### Roles, not credential names

A tool does not name credentials. It declares roles:

```json
{
  "name": "fetch_mail",
  "needs": [{ "role": "mailbox", "kind": "azure-app" }]
}
```

and the caller says which credential fills each role. The tool reads
`ENGRAM_SECRET_MAILBOX` and never learns what the credential is called, so one
`fetch_mail` serves three Azure app registrations instead of being written three
times. The bridge receives resolved secret IDs, never names.

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

### What the sandbox covers, and what it does not

Two mechanisms, verified on this machine rather than assumed, and neither
covers what the other does.

**Filesystem: Node's permission model.** When the command is `node`, the tool
runs with `--permission`, may read only its own package directory, may not
write anywhere unless a writable directory was declared, and may not spawn
child processes, load native addons or use WASI. `--allow-child-process` is
never passed, because a child of a permissioned process runs with no permission
model at all and would hand back every restriction in one flag.

**Network: a namespace.** The permission model does **not** cover the network:
a permissioned process still fetches `https://example.com` perfectly well. So a
tool that declares `"network": false` is run under `unshare -rn`, which works
rootless on an ordinary Linux box and leaves the tool with no resolver and no
route.

What that adds up to, per platform:

| Tool runs | Linux | macOS / Windows |
|-----------|-------|-----------------|
| `node`, `network: false` | filesystem confined, network blocked | filesystem confined, **network open** |
| `node`, network unspecified | filesystem confined, network open | filesystem confined, network open |
| anything else (`python`, a shell script, a binary), `network: false` | **filesystem open**, network blocked | **no sandbox at all** |
| anything else, network unspecified | **no sandbox at all** | **no sandbox at all** |

Where a row says the sandbox did not apply, the bridge says so too: every
`local_result` carries a `sandbox` object naming what was and was not enforced,
and the bridge logs a warning when a tool that asked for no network gets one
anyway. Declaring a **host list** rather than `false` is recorded as *not
enforced*: per-host filtering is not implemented, and a tool that declares hosts
gets the whole network.

None of this is a substitute for approving the tool. It bounds an ordinary bug;
it does not contain code that is trying to get out.

### Packages

A tool can name an npm package, pinned exactly:

```json
{ "package": "@scope/fetch-mail@1.2.3" }
```

It is installed with `--ignore-scripts`, into a directory of its own per space,
under `~/.ai-bridge` (see `--local-data-dir`). Ranges, dist-tags, `file:` specs
and git URLs are refused: what runs here has to be the same bytes every time,
and the approval a person gave was for the code they looked at. The integrity
hash npm resolved is recorded, and a later install of the same spec that
resolves to **different bytes** is refused rather than installed quietly.

### Rate limits

Per space, at most 2 local tools run at once, and starts are spaced at least
250ms apart. A third concurrent call is refused rather than queued. This exists
because a panel with a render-loop bug would otherwise spawn processes at UI
speed, each one holding a decrypted credential, and a queue would be the same
thing with a delay.

### What redaction does and does not do

Secrets reach a tool as environment variables, and the bridge removes those
exact values from stdout and stderr before the model sees them. That turns an
accidental `echo $ENGRAM_SECRET_MAILBOX` from a leak into
`[redacted: ENGRAM_SECRET_MAILBOX]`, and catches the likelier accident, which is
a tool printing a connection string in an error message.

Scrubbing happens **before** the output is parsed, so a credential cannot
survive inside a JSON string on its way to the model. A tool's stdout must be
exactly one JSON document; anything else fails the call loudly rather than being
passed back as text, because raw text arriving where a result belongs reads to a
model exactly like a tool that worked.

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

**Server-defined tools** registered by the web application are exposed to every provider through a small MCP server the bridge runs on loopback, with a per-spawn bearer token; a tool call travels back over the WebSocket for the server to resolve. (Earlier versions injected Bash wrapper scripts onto the CLI's `PATH`. That mechanism is gone — the bridge no longer modifies `PATH` at all.)

Codex's own sandbox is set by the isolation posture and not by whether tools are present: `isolated` leaves it at its read-only default, `workspace` sets `workspace-write`, and `native` sets `danger-full-access`. See [Working in a repository](#working-in-a-repository).

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
