/**
 * AI Bridge Protocol v0.1 — Type Definitions
 *
 * Defines all message types exchanged between the bridge (client)
 * and the server over WebSocket.
 *
 * Source of truth: PROTOCOL.md
 */

// ---------------------------------------------------------------------------
// Provider & Tool Definitions
// ---------------------------------------------------------------------------

/** Describes an available model for a provider. */
export interface ModelInfo {
  /** Model identifier (slug) used in CLI flags / API requests */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Optional description of the model's strengths */
  description?: string;
  /** Whether this is the default model for the provider */
  is_default?: boolean;
}

/** Describes a locally detected AI CLI provider and its capabilities. */
export interface ProviderCapability {
  /** Provider name (e.g. "codex", "claude", "gemini") — used as the identifier */
  name: string;
  /** Detected version string, or null if unknown */
  version: string | null;
  /** Whether the CLI binary was found and is executable */
  available: boolean;
  /** Whether the provider supports streaming output */
  supports_streaming: boolean;
  /** Whether the provider supports tool/function calling */
  supports_tools: boolean;
  /** Whether the provider supports extended thinking */
  supports_thinking: boolean;
  /** Whether the provider supports resuming a prior session */
  supports_session_resume: boolean;
  /** Available models for this provider (populated after detection) */
  models?: ModelInfo[];
}

/** A tool definition following JSON Schema for parameters. */
export interface ToolDefinition {
  /** Unique tool name (e.g. "roll_dice", "web_search") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  parameters: Record<string, unknown>;
  /**
   * Where this tool runs.
   *
   * Absent means `server`, so every existing server keeps the behaviour it has:
   * the call round-trips over the WebSocket and the server executes it. Same
   * convention as `isolation` elsewhere in this file, where absent is the safe
   * legacy default and never the new behaviour.
   *
   * `local` means the bridge runs it on this machine and never emits a
   * tool_call frame, which is the entire point once the arguments include a
   * decrypted secret: the plaintext must not reach the network.
   *
   * Honoured ONLY when the operator enabled local execution. A server cannot
   * turn it on by sending this field. See src/local/gate.ts.
   */
  execute?: 'server' | 'local';
  /**
   * local only. The space this tool belongs to.
   *
   * Every secret this tool can reach must live in this space. Without it the
   * bridge cannot scope a lookup, and an unscoped lookup is exactly the bug
   * this field exists to close: a tool defined in a shared space naming a
   * credential that only exists in someone's private space, and being handed
   * it because the name happened not to collide. A local tool that arrives
   * without a space is refused rather than resolved against everything the
   * device holds.
   */
  space_id?: string;
  /**
   * local only, and superseded by `needs` + `fill`. Names of the secrets this
   * tool may be given, resolved WITHIN `space_id` and nowhere else.
   *
   * Kept for servers that have not moved to roles yet. A name is a poor
   * binding: it makes one tool per credential, so `fetch_mail` had to be
   * written once per Azure app registration.
   */
  secrets?: string[];
  /**
   * local only. What the tool needs, by ROLE rather than by credential name.
   *
   * The tool reads ENGRAM_SECRET_<ROLE>, so one `fetch_mail` serves three
   * app registrations: the caller decides which credential fills `mailbox`,
   * and the tool never learns a credential's name.
   *
   * `kind` is advisory, for the vault's own picker (e.g. "azure-app").
   */
  needs?: { role: string; kind?: string }[];
  /**
   * local only. Which credential fills each role, as resolved secret IDs.
   *
   * The server resolves these, because the server is what knows the binding a
   * person configured. The bridge never turns a name into an ID on its own.
   */
  fill?: SecretFill[];
  /**
   * local only. An npm package this tool lives in, pinned exactly
   * (`@scope/name@1.2.3`).
   *
   * Installed with install scripts disabled, into a per-space directory under
   * the bridge's own data dir. A range or a dist-tag is refused: what runs
   * here has to be the same bytes every time.
   */
  package?: string;
  /**
   * local only. What the tool needs from the network.
   *
   * `false` means none, and on Linux the bridge enforces it with a network
   * namespace. A host list means the bridge does NOT filter (per-host
   * filtering is not implemented) and says so in the result's sandbox report.
   * Absent means unrestricted.
   */
  network?: boolean | string[];
  /** local only. The command to run, and any arguments before the tool's own. */
  run?: { command: string; args?: string[] };
}

/**
 * One role filled by one credential.
 *
 * A secret ID, never a name. The bridge resolves the ID inside the call's
 * space and refuses if the secret lives anywhere else, so a caller cannot
 * reach across spaces by knowing an ID.
 */
export interface SecretFill {
  role: string;
  secret_id: string;
}

/** What a `local_call` asks the bridge to run. */
export interface LocalCallTool {
  name: string;
  command: string;
  args?: string[];
  /** Pinned npm package to install and run from. See ToolDefinition.package. */
  package?: string;
  /** See ToolDefinition.network. */
  network?: boolean | string[];
}

/**
 * A directory this bridge is allowed to work in, as advertised at the
 * handshake so the server can show a picker instead of asking a developer to
 * type an absolute path into a chat box.
 *
 * The list is built ENTIRELY from what the operator passed to `--allow-dir`
 * (or AI_BRIDGE_ALLOWED_DIRS). A server cannot add to it, and naming a path
 * that is not under one of these roots is refused — see src/workspace/.
 */
export interface WorkspaceRef {
  /** Absolute, symlink-resolved path of the allowed root. */
  path: string;
  /** Human-readable name for a picker. Defaults to the directory's basename. */
  label: string;
}

/**
 * One file the server wants the assistant to be able to read this turn.
 *
 * The bytes are NOT on the wire: a screenshot already exceeds the server's
 * 1 MB WebSocket frame cap, and base64 adds a third on top. The bridge fetches
 * `url` over HTTPS with its own connection token, verifies `size` and
 * `sha256`, writes the file under the bridge's own cache directory, and tells
 * the model where it landed.
 */
export interface AttachmentRef {
  /** Server-side identifier, echoed in errors and used to disambiguate names. */
  id: string;
  /** Original filename. NEVER trusted as a path — see sanitiseAttachmentName(). */
  name: string;
  mime_type: string;
  /** Expected size in bytes. A mismatch after download fails the request. */
  size: number;
  /** Lowercase hex SHA-256 of the file. A mismatch fails the request. */
  sha256: string;
  /**
   * Where to fetch it. Must be on the same origin as the server this bridge
   * is connected to (or the explicit `--api` origin), or it is refused: a
   * hostile server must not be able to turn a connected bridge into a fetcher
   * for arbitrary hosts with a valid bearer token attached.
   */
  url: string;
}

// ---------------------------------------------------------------------------
// Bridge -> Server Messages
// ---------------------------------------------------------------------------

/**
 * Sent immediately after WebSocket connection is established.
 * Token is NOT included — it goes in the URL query param.
 */
export interface HelloMessage {
  type: 'hello';
  version: string;
  bridge_version: string;
  providers: ProviderCapability[];
  /**
   * Directories this bridge may be asked to work in. Absent or empty means
   * the operator allowed none, and every `ai_request.working_dir` is refused.
   * An older server ignores the field.
   */
  workspaces?: WorkspaceRef[];
}

/**
 * Acknowledges receipt of an ai_request and confirms processing has begun.
 *
 * cli_session_id is null when no existing session is found (a fresh CLI
 * session); servers treat null as "new session" and any non-null string as the
 * resumable CLI session identifier.
 */
export interface AiRequestAckMessage {
  type: 'ai_request_ack';
  request_id: string;
  cli_session_id: string | null;
}

/**
 * A streaming event pushed to the server as the CLI produces output.
 *
 * Uses the envelope format: { type: "stream", request_id, event, data }
 */
export interface StreamMessage {
  type: 'stream';
  request_id: string;
  event: StreamEventType;
  data: StreamEventData;
}

/** Sent periodically to keep the connection alive. */
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/** A tool call that the bridge needs the server to resolve. */
export interface ToolCallMessage {
  type: 'tool_call';
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

/** Non-streaming error response. */
export interface BridgeErrorMessage {
  type: 'error';
  request_id: string;
  code: string;
  message: string;
  fatal: boolean;
}

/**
 * Sent mid-connection when the set of locally available provider CLIs has
 * changed since the `hello` handshake — e.g. the user installed or removed a
 * CLI while the bridge stayed connected. Carries the same provider shape as
 * `hello`, but only the providers that are currently available. The server
 * treats it as a refresh of the connection's advertised providers.
 */
export interface ProvidersUpdateMessage {
  type: 'providers_update';
  providers: ProviderCapability[];
}

/**
 * How a `local_call` turned out.
 *
 * Two shapes and no third: `ok: true` carries the one JSON document the tool
 * wrote to stdout, `ok: false` carries a sentence saying what went wrong. A
 * tool that printed something that is not JSON produces the second, never a
 * `result` holding raw text, because raw text reaching the model as a result is
 * indistinguishable from a tool that worked.
 */
export interface LocalResultMessage {
  type: 'local_result';
  /** Echoes the id of the local_call this answers. */
  id: string;
  ok: boolean;
  /** Present when ok. The tool's stdout, parsed. */
  result?: unknown;
  /** Present when not ok. Already scrubbed of every credential the tool held. */
  error?: string;
  /**
   * What the sandbox actually did on this machine, which is not always what
   * the tool asked for. Additive: a server that ignores it loses nothing, and
   * a server that reads it can tell a tool that ran with no containment from
   * one that ran with all of it. See src/local/sandbox.ts.
   */
  sandbox?: SandboxReportFrame;
}

/** The machine-readable half of the sandbox report. See src/local/sandbox.ts. */
export interface SandboxReportFrame {
  /** `node-permissions` when Node's permission model was applied, else `none`. */
  filesystem: 'node-permissions' | 'none';
  /** `namespace` when the tool ran with no network at all, else `open`. */
  network: 'namespace' | 'open';
  /** Plain sentences naming everything the sandbox did NOT cover here. */
  notes: string[];
}

/**
 * Why the posture in force is not the one the server asked for.
 *
 * Absent when they match. Each value maps to an operator action, because the
 * whole point of reporting this is that somebody can fix it: the server can
 * say what to do rather than showing a connection that looks healthy while the
 * assistant silently has no tools.
 */
export type PostureReason =
  /** The server sent no `cli_isolation`, so the safe default applies. */
  | 'not_requested'
  /** The server sent a value this bridge does not recognise. */
  | 'unrecognised'
  /** `workspace` needs the operator to have passed `--allow-dir`. */
  | 'requires_allow_dir'
  /** `native` needs the operator to have passed `--allow-native`. */
  | 'requires_allow_native';

/**
 * The isolation posture actually in force, reported once per handshake.
 *
 * The server asks for a posture in `welcome`, and the bridge may decline it:
 * `workspace` and `native` are gated on operator flags, and a bridge started
 * without them runs `isolated` instead. That refusal used to be visible only
 * in a log on the operator's own machine, which made the failure it causes
 * genuinely hard to diagnose — an operator who forgot `--allow-native` gets a
 * connection that looks healthy in every screen while the assistant has no
 * tools at all, and nothing anywhere explains why.
 *
 * Sent whether or not the posture matches, so a server always knows what is in
 * force. Absence of the frame means an older bridge, not agreement.
 *
 * Sent AFTER `welcome`, necessarily: at `hello` time the bridge has not been
 * told what to adopt yet.
 */
export interface PostureMessage {
  type: 'posture';
  /** The posture actually in force. */
  cli_isolation: CliIsolation;
  /** What the server asked for. Null when it asked for nothing. */
  requested: CliIsolation | string | null;
  /** Present only when the two differ. */
  reason?: PostureReason;
  /** A sentence naming the operator action that would change it. */
  message?: string;
}

/** Union of all messages the bridge sends to the server. */
export type BridgeToServerMessage =
  | HelloMessage
  | AiRequestAckMessage
  | StreamMessage
  | PingMessage
  | ToolCallMessage
  | BridgeErrorMessage
  | ProvidersUpdateMessage
  | PostureMessage
  | LocalResultMessage
  | StreamChunkMessage
  | StreamEndMessage;

// ---------------------------------------------------------------------------
// Server -> Bridge Messages
// ---------------------------------------------------------------------------

/**
 * How much the local CLI environment is allowed to influence behaviour.
 *
 * - `isolated` (default): the bridge isolates the spawned CLI from local
 *   influence. Concretely:
 *     • Built-in shell / edit / web tools are blocked (no `bypassPermissions`,
 *       no `danger-full-access`, no `--yolo`). The model can reach
 *       server-declared tools only, via the bridge's MCP server.
 *     • Other MCP servers configured on the operator's machine are ignored
 *       (`--strict-mcp-config` for Claude; per-CLI equivalents where
 *       available).
 *     • `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` auto-discovery is suppressed
 *       (`cwd` is already pinned to an empty temp dir by the bridge; Claude
 *       additionally runs with `--bare` so hooks, auto-memory, keychain
 *       reads, and the user-level `CLAUDE.md` are also off).
 *     • A neutral fallback system prompt is injected when the server didn't
 *       send one, so the CLI's built-in default never seeps through.
 *   This is the right posture when the bridge is reachable by end users.
 *
 * - `native`: the legacy posture, kept as an operator opt-in for the
 *   developer-runs-bridge-against-own-machine case. The MCP server is still
 *   registered, but the CLI runs with its bypass flags AND its local
 *   environment (user CLAUDE.md, skills, hooks, configured MCP servers,
 *   plugins, default system prompt) intact. Never the right choice when the
 *   bridge is reachable by untrusted end users.
 *
 * - `workspace`: the posture that makes a real coding task possible without
 *   handing over the operator's whole environment. The CLI works inside the
 *   server-named `working_dir` with its built-in file and shell tools
 *   ENABLED, while the operator's own MCP servers, hooks, plugins, skills and
 *   user-level instruction files stay out (`--strict-mcp-config` and friends
 *   are kept exactly as in `isolated`), and the neutral fallback system prompt
 *   still applies.
 *
 *   This is NOT a sandbox, and the README says so in as many words: once the
 *   CLI has a shell, `cd ..` and `~/.ssh` are one command away. What bounds it
 *   is that `--allow-dir` is opt-in and empty by default, so a bridge started
 *   without it cannot be pointed anywhere at all.
 *
 * Layer B (HOME / CODEX_HOME / GEMINI_HOME redirection with auth symlinks)
 * would further close `isolated`'s residual user-level leakage for Codex and
 * Gemini — see `tasks/open/cli-isolation-layer-b.md`.
 */
export type CliIsolation = 'native' | 'isolated' | 'workspace';

/** Server acknowledges the hello and provides configuration. */
export interface WelcomeMessage {
  type: 'welcome';
  session_id: string;
  tools: ToolDefinition[];
  config: ServerConfig;
  /** Optional protocol version from the server for compatibility checking. */
  protocol_version?: string;
  /**
   * A fresh connection token, present when the server topped up an aging
   * token at the handshake. The bridge adopts it for subsequent reconnects.
   */
  refreshed_token?: string;
  /**
   * CLI isolation posture. Defaults to `isolated` when absent — older servers
   * that don't send the field get the safe default, never the legacy native
   * behaviour.
   */
  cli_isolation?: CliIsolation;
}

/** Server-provided configuration values. */
export interface ServerConfig {
  /** Heartbeat interval in SECONDS (not milliseconds). */
  heartbeat_interval: number;
  /** Maximum seconds for a single AI request. */
  request_timeout: number;
  /**
   * What should happen to a file the assistant hands back.
   *
   * `server` uploads it, which is what has always happened and remains the
   * default when a server does not say. `device` keeps it here and streams it
   * when the server asks, for the case where this machine is somewhere
   * somebody works rather than a processor: the file is one of a thousand on
   * this disk, and sending a copy away takes a copy of their work for no
   * reason.
   *
   * The server decides because only the server knows which of those it is.
   */
  attachments?: 'server' | 'device';
}

/** Data payload for `attachment_read` — the server asking for a file this
 *  machine kept. `id` names the TRANSFER, not the file. */
export interface AttachmentReadMessage {
  type: 'attachment_read';
  id: string;
  path: string;
}

/** One piece of a file on its way back. `data` is base64: these are text
 *  frames, and a third more bytes on the wire is cheaper than a second
 *  protocol for binary and a second set of framing bugs to find. */
export interface StreamChunkMessage {
  type: 'stream_chunk';
  id: string;
  data: string;
}

/** The end of a transfer, sent on EVERY path including failure. A server
 *  bounds silence rather than duration, so a bridge that dies quietly costs
 *  the reader that whole window before their download fails. */
export interface StreamEndMessage {
  type: 'stream_end';
  id: string;
  error?: string;
}

/** The reader went away. Stop: otherwise this machine keeps reading a file for
 *  somebody who closed the tab. */
export interface StreamCancelMessage {
  type: 'stream_cancel';
  id: string;
}

/** A single prior turn in a conversation's history. */
export interface ConversationEntry {
  role: string;
  content: string;
}

/** A request from the server to run an AI prompt through a local CLI. */
export interface AiRequestMessage {
  type: 'ai_request';
  request_id: string;
  conversation_id: string;
  provider: string;
  message: string;
  system_prompt: string | null;
  options: AiRequestOptions;
  /**
   * The CLI session to resume, or null to start a fresh session.
   *
   * The server owns this mapping (persisted per conversation) and is the
   * single source of truth — the bridge keeps no session map of its own.
   * Non-null: resume that CLI session. Null: start fresh.
   */
  cli_session_id: string | null;
  /**
   * Prior conversation history, included only when cli_session_id is null so
   * a fresh CLI session can be seeded with context. Omitted/empty when
   * resuming — the resumed CLI session already holds the history.
   */
  history?: ConversationEntry[];
  /**
   * Absolute path the CLI should be spawned in.
   *
   * Absent means today's behaviour exactly: a freshly made empty directory
   * under `~/.cache/ai-bridge/`, which is what keeps a chat-only turn from
   * absorbing whatever happens to be on disk.
   *
   * Present means the server is asking the assistant to work in a real
   * checkout. It is honoured ONLY when the operator passed `--allow-dir` and
   * the path resolves inside one of those roots; otherwise the turn is
   * refused with `working_dir_not_allowed`. There is deliberately no silent
   * fallback to the scratch directory — a turn that appears to succeed while
   * every answer is about an empty directory is the worst available outcome.
   *
   * Fixed for the life of a CLI session: a resume that names a different
   * directory is refused with `working_dir_changed` rather than papered over.
   */
  working_dir?: string;
  /**
   * Files the server wants the assistant to be able to read this turn.
   *
   * The bridge downloads each one to its own cache directory (never into the
   * working directory — the transport must not dirty a checkout), verifies it,
   * and prepends a short preamble to the message naming the absolute paths.
   * Deleted when the turn terminates.
   */
  attachments?: AttachmentRef[];
}

/**
 * Options that control how the AI request is executed.
 *
 * All fields are optional: absent = "use provider default", null = explicitly
 * "no value".
 */
export interface AiRequestOptions {
  max_tokens?: number | null;
  temperature?: number | null;
  /** Model to use (provider-specific identifier, e.g. "sonnet", "gpt-5.4") */
  model?: string | null;
}

/** Server responds with the result of a tool call. */
export interface ToolResolveMessage {
  type: 'tool_resolve';
  request_id: string;
  tool_call_id: string;
  result: unknown;
}

/** Server responds with an error for a tool call. */
export interface ToolErrorMessage {
  type: 'tool_error';
  request_id: string;
  tool_call_id: string;
  error: string;
}

/** Server pong response to a bridge ping. */
export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

/** Server-originated error. */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  fatal: boolean;
}

/**
 * Server rejected the connection (bad/expired/revoked token, protocol
 * mismatch, …). Always fatal — the bridge must not reconnect.
 */
export interface ConnectionErrorMessage {
  type: 'connection_error';
  error: string;
  message: string;
}

/** Server hands the bridge a fresh connection token (see WelcomeMessage). */
export interface TokenRefreshMessage {
  type: 'token_refresh';
  token: string;
}

/**
 * The server asks the bridge to run one tool, here, now.
 *
 * Unlike a `welcome`-registered local tool, this is not something a model
 * decided to call: it is a panel or a job on the server invoking a tool a
 * person configured. It still goes through the same gate, so a bridge that was
 * never started with local execution refuses it outright.
 *
 * `space_id` scopes every credential this call can reach. `fill` names
 * resolved secret IDs, never names, and every one of them must live in
 * `space_id` or the call is refused.
 */
export interface LocalCallMessage {
  type: 'local_call';
  id: string;
  space_id: string;
  tool: LocalCallTool;
  fill?: SecretFill[];
  /** Passed to the tool as one JSON document on stdin. */
  input?: unknown;
}

/** Union of all messages the server sends to the bridge. */
export type ServerToBridgeMessage =
  | WelcomeMessage
  | AiRequestMessage
  | ToolResolveMessage
  | ToolErrorMessage
  | PongMessage
  | ErrorMessage
  | ConnectionErrorMessage
  | TokenRefreshMessage
  | LocalCallMessage
  | AttachmentReadMessage
  | StreamCancelMessage;

// ---------------------------------------------------------------------------
// Stream Event Types and Data
// ---------------------------------------------------------------------------

/** The event type names used inside stream envelopes. */
export type StreamEventType =
  | 'block_start'
  | 'block_delta'
  | 'block_stop'
  | 'tool_result'
  | 'attachment'
  | 'rate_limit'
  | 'done'
  | 'error';

/** Block types in the protocol. */
export type BlockType = 'text' | 'thinking' | 'tool_call';

/** Data payload for block_start events. */
export interface BlockStartData {
  block_index: number;
  block_type: BlockType;
  /** For tool_call blocks only. */
  tool_name?: string;
  /** For tool_call blocks only. */
  tool_call_id?: string;
}

/** Data payload for block_delta events. */
export interface BlockDeltaData {
  block_index: number;
  content: string;
}

/** Data payload for block_stop events. */
export interface BlockStopData {
  block_index: number;
}

/** Data payload for tool_result events. */
/**
 * Provider rate-limit status, forwarded as the CLI reports it.
 *
 * Informational and non-terminal — the turn continues. Carried so a server can
 * show what the operator's own CLI already knows (how much of a window is
 * spent, when it resets) rather than discovering a limit by hitting it. The
 * shape is the provider's own, passed through unchanged.
 */
export interface RateLimitData {
  provider: string;
  info: Record<string, unknown>;
}

export interface ToolResultData {
  tool_call_id: string;
  result: string;
  /**
   * Whether the tool reported failure, when the provider says so.
   *
   * The authoritative signal. Reading it out of `result` cannot work: a tool
   * that legitimately prints "Error: no matches" is indistinguishable from one
   * that failed, and the Codex and Gemini adapters additionally prefix their
   * own `Error: ` onto a failed result for historical reasons. Absent when the
   * provider does not report a status.
   */
  is_error?: boolean;
}

/**
 * Data payload for `attachment` events — a file the assistant produced and
 * chose to hand back, already uploaded to the server.
 *
 * Emitted only in response to the model calling the bridge-owned
 * `bridge__attach_file` tool. The model nominates the file because nothing
 * else can: a transport cannot guess which of a hundred files it just touched
 * is the answer. A server that does not understand the event ignores it.
 */
export interface AttachmentEventData {
  /**
   * The id the server assigned when the bridge uploaded the file.
   *
   * NULL when the file was KEPT rather than uploaded: nothing uploaded it, so
   * nothing minted an id, and the server makes one when it records the offer.
   */
  id: string | null;
  name: string;
  mime_type: string;
  size: number;
  /**
   * Where the file is on this machine, when it stayed here.
   *
   * Present only in `device` mode, and it is what tells the server the bytes
   * have not been sent. It comes back later in an `attachment_read`, and is
   * re-resolved against the working directory then: it left this machine, so
   * it is input on the way back however it started.
   */
  path?: string;
  /** Whatever the model said the file is, when it said anything. */
  description?: string;
}

/** Data payload for done events. */
export interface DoneData {
  usage?: TokenUsage;
  /**
   * What the provider reported about the turn, beyond the token counts.
   *
   * All optional and all provider-reported: absent means the CLI did not say,
   * never that the value was zero. The bridge forwards what it is given rather
   * than deciding what a server is interested in.
   */
  /** The model that actually ran, resolved from whatever alias was requested. */
  model?: string | null;
  /** Version of the provider CLI that ran the turn. */
  provider_version?: string | null;
  /** Why the model stopped — e.g. `end_turn`, `max_tokens`. */
  stop_reason?: string | null;
  /** What the provider says the turn cost, in USD. */
  cost_usd?: number | null;
  /** Wall-clock duration of the turn, and of the API portion of it. */
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  /** How many assistant turns the CLI took internally to answer. */
  num_turns?: number | null;
  /**
   * Tool calls the CLI's own permission system refused.
   *
   * Worth surfacing rather than leaving in a log on someone else's machine: in
   * `isolated` this is the record of what the posture actually stopped, and an
   * empty answer with three denials here reads very differently from an empty
   * answer with none.
   */
  permission_denials?: unknown[];
  /**
   * The CLI session id this turn ran under — the id created on a fresh
   * session, or the id resumed. The server persists it on the conversation
   * so the next turn can resume. Null/absent when no session id was produced.
   */
  cli_session_id?: string | null;
}

/** Data payload for error events. */
export interface StreamErrorData {
  code: string;
  message: string;
}

/** Token usage information. */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  /**
   * Cache tokens, when the provider reports them.
   *
   * Dominant on a resumed conversation — a turn can read tens of thousands of
   * cached tokens against six new input tokens — so a server showing only
   * input/output understates the turn by an order of magnitude and cannot
   * reconcile its own numbers with the provider's bill.
   */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Union of all stream event data payloads. */
export type StreamEventData =
  | BlockStartData
  | BlockDeltaData
  | BlockStopData
  | ToolResultData
  | RateLimitData
  | AttachmentEventData
  | DoneData
  | StreamErrorData;
