/**
 * Bridge — Core WebSocket management class
 *
 * Connects to the AI Bridge server, handles the protocol handshake,
 * routes AI requests to local provider adapters, and streams results
 * back over the WebSocket.
 *
 * Implements:
 *   - WebSocket connection with exponential backoff reconnection
 *   - Protocol handshake (hello -> welcome)
 *   - AI request routing to providers
 *   - Tool call resolution round-trip
 *   - Heartbeat (ping/pong) — interval in SECONDS from server
 *   - Tool script generation on welcome
 *   - Local HTTP callback server for tool scripts
 *   - Lifecycle event emission
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  ProviderCapability,
  BridgeToServerMessage,
  ServerToBridgeMessage,
  AiRequestMessage,
  CliIsolation,
  PostureReason,
  ConnectionErrorMessage,
  ConversationEntry,
  WelcomeMessage,
  ServerConfig,
  StreamEventType,
  StreamEventData,
  DoneData,
  LocalCallMessage,
} from './protocol/types.js';
import { PROTOCOL_VERSION, BRIDGE_VERSION } from './protocol/version.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './providers/base.js';
import { detectProviders } from './providers/detector.js';
import { ToolResolver } from './tools/resolver.js';
import { LOCAL_EXECUTION_OFF, refusalReason, runsLocally, type LocalExecutionConfig } from './local/gate.js';
import { runLocalTool } from './local/executor.js';
import { fillRoles, grantedTo, loadSecrets, SecretStore, type EngramConfig } from './local/engram.js';
import { handleLocalCall, stagePackage } from './local/call.js';
import { SpaceLimiter } from './local/limits.js';
import type { Identity } from './local/identity.js';
import type { Redaction } from './local/scrub.js';
import { BridgeMcpServer } from './mcp/server.js';
import { rootPaths, toWorkspaceRefs, type AllowedRoot } from './workspace/allowlist.js';
import { resolveWorkingDir, WORKING_DIR_CHANGED } from './workspace/resolve.js';
import { SessionWorkingDirs, sessionStorePath } from './workspace/sessions.js';
import {
  buildAttachmentPreamble,
  fetchAttachments,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
  type SavedAttachment,
} from './attachments/fetch.js';
import { attachmentDirFor, removeAttachmentDir } from './attachments/store.js';
import {
  ATTACH_FILE_TOOL,
  ATTACH_FILE_TOOL_DEFINITION,
  uploadAttachment,
  type UploadContext,
} from './attachments/upload.js';
import { resolveApiOrigin } from './attachments/origin.js';
import { createLogger } from './utils/logger.js';
import { clampRequestTimeout, clampHeartbeat } from './utils/clamp.js';
import { FatalBridgeError, RequestRefusal } from './errors.js';

export { FatalBridgeError } from './errors.js';

const log = createLogger('Bridge');

// ---------------------------------------------------------------------------
// Configuration & Defaults
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** WebSocket server URL (wss://...) — token is appended as ?token= */
  serverUrl: string;
  /** Authentication token (placed in URL query param, NOT in hello body) */
  token: string;
  /** Detected provider capabilities */
  providers: ProviderCapability[];
  /** Provider adapter instances, keyed by provider name */
  adapters: Map<string, ProviderAdapter>;
  /** Whether to run in test mode (mock responses) */
  testMode?: boolean;
  /** Mock response handler for test mode */
  onTestRequest?: (request: AiRequestMessage, sendEvent: (event: StreamEventType, data: StreamEventData) => void) => Promise<void>;
  /**
   * Local execution posture. Absent means off, which is the DungeonMeister
   * shape: a server can mark a tool `local` and the bridge will not run it.
   */
  localExecution?: LocalExecutionConfig;
  /** Where to resolve secrets from. Only consulted when local execution is on. */
  engram?: EngramConfig;
  /** This device's keypair and its id at Engram. */
  identity?: Identity;
  /**
   * Directories a server may name in `ai_request.working_dir`.
   *
   * Absent or empty means none, and every request naming one is refused. Same
   * posture as localExecution above: the operator opts in with `--allow-dir`,
   * and no server can turn it on by sending a field.
   */
  allowedRoots?: AllowedRoot[];
  /**
   * Origin attachments are fetched from and uploaded to. Defaults to the HTTP
   * origin of `serverUrl`; `--api` overrides it for split deployments.
   */
  apiOrigin?: string;
  /** Per-file and per-request attachment size caps. */
  attachmentLimits?: AttachmentLimits;
  /** Keep downloaded attachments after the turn, for debugging. */
  keepAttachments?: boolean;
  /**
   * Where the session→working-directory record is persisted.
   *
   * `null` disables persistence. Exists so the test suite does not write into
   * the operator's real `~/.cache/ai-bridge/sessions.json` — running the tests
   * on a machine with a live bridge used to overwrite that bridge's map with
   * temp paths from the suite.
   */
  sessionStorePath?: string | null;
  /**
   * Permit the server to select `native` isolation.
   *
   * Absent means no. `native` is the broadest posture there is, and like
   * `workspace` it must be the operator's choice rather than a field a server
   * can send.
   */
  allowNative?: boolean;
}

const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 300;

// Large-but-finite cap (~24 min of retries with backoff); infinite retry could
// mask configuration errors.
const MAX_RECONNECT_ATTEMPTS = 100;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000; // Cap at 15s per PROTOCOL.md

// How long a fetched set of secrets is trusted. Short because it bounds how
// long a revoked device or a rotated value keeps working; not zero because
// every local tool call would otherwise depend on Engram being reachable.
const SECRETS_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Bridge Events
// ---------------------------------------------------------------------------

export interface BridgeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  welcome: [sessionId: string];
  error: [error: Error];
  request_start: [requestId: string, provider: string, model?: string | null];
  request_end: [requestId: string];
}

// ---------------------------------------------------------------------------
// Helper: Escape XML characters in message content
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Helper: Seed a fresh CLI session with prior conversation history
// ---------------------------------------------------------------------------

/**
 * Fold prior conversation history into the system prompt so a fresh CLI
 * session starts with context.
 *
 * Used when cli_session_id is null but the conversation already has history —
 * e.g. the first turn after the server reset a lost session. History is
 * wrapped in XML tags with escaped content so prior turns cannot be
 * interpreted as authoritative instructions (prompt-injection hardening).
 *
 * Returns null when there is no valid history to fold in.
 */
function buildHistoryBlock(history: ConversationEntry[]): string | null {
  const validRoles = new Set(['user', 'assistant', 'system']);

  const unexpectedRoles = history
    .map((h) => h.role)
    .filter((role) => !validRoles.has(role));
  if (unexpectedRoles.length > 0) {
    log.warn('Conversation history contains unexpected role values', {
      unexpectedRoles: [...new Set(unexpectedRoles)],
    });
  }

  // Exclude entries with unexpected roles to avoid widening the injection
  // surface (an unknown role could be treated as authoritative instructions).
  const priorHistory = history.filter((h) => validRoles.has(h.role));
  if (priorHistory.length === 0) {
    return null;
  }

  const historyXml = priorHistory
    .map((h) => `<message role="${escapeXml(h.role)}">${escapeXml(h.content)}</message>`)
    .join('\n');

  return `<conversation_history>\n${historyXml}\n</conversation_history>`;
}

/**
 * Fold history into the system prompt — for CLIs that take their prompt as a
 * command-line argument. Returns the system prompt unchanged when there is no
 * history. NOTE: a large history makes the resulting `--system-prompt` argument
 * exceed the OS arg-size limit (`spawn E2BIG`); use {@link foldHistoryIntoMessage}
 * for stdin-fed CLIs (Claude) instead.
 */
function foldHistoryIntoSystemPrompt(
  history: ConversationEntry[],
  systemPrompt: string | null,
): string | null {
  const historyBlock = buildHistoryBlock(history);
  if (historyBlock === null) {
    return systemPrompt;
  }

  return systemPrompt ? `${systemPrompt}\n\n${historyBlock}` : historyBlock;
}

/**
 * Fold history into the user message — for Claude, which reads its prompt from
 * STDIN (no argv size limit). The history precedes the current turn. Keeping
 * the (possibly huge) history out of the `--system-prompt` argument is what
 * avoids `spawn E2BIG` on large conversations.
 */
function foldHistoryIntoMessage(
  history: ConversationEntry[],
  message: string,
): string {
  const historyBlock = buildHistoryBlock(history);

  return historyBlock ? `${historyBlock}\n\n${message}` : message;
}

// ---------------------------------------------------------------------------
// Bridge Class
// ---------------------------------------------------------------------------

/** What `adoptIsolation` decided, and why, so the server can be told. */
interface AdoptedPosture {
  adopted: CliIsolation;
  requested: CliIsolation | string | null;
  reason?: PostureReason;
  message?: string;
}

/**
 * Largest frame the bridge will put on the wire.
 *
 * The server's cap is 1MB and it does not answer an oversized message with an
 * error — it answers with a CLOSE_TOO_BIG and the connection goes down, taking
 * every in-flight request with it. So this sits below that, and anything over
 * is reported rather than sent.
 */
const MAX_FRAME_BYTES = 900 * 1024;

export class Bridge extends EventEmitter<BridgeEvents> {
  private ws: WebSocket | null = null;
  private readonly serverUrl: string;
  // Not readonly: the server tops up long-lived tokens, and the bridge adopts
  // the fresh token (via welcome.refreshed_token or a token_refresh message)
  // for subsequent reconnects.
  private token: string;
  // Not readonly: re-detected at each handshake and after a provider spawn
  // failure, so a CLI installed or removed mid-life is picked up without a
  // bridge restart. See refreshProviders().
  private providers: ProviderCapability[];
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly toolResolver = new ToolResolver();
  private readonly localExecution: LocalExecutionConfig;
  private readonly engram?: EngramConfig;
  private readonly identity?: Identity;
  /**
   * Secrets are fetched on the first local tool call that needs one, rather
   * than at startup: a bridge that never runs a local tool should never ask
   * Engram for a credential.
   *
   * Cached with a TTL, and re-fetched early whenever a declared secret is not
   * in the cache. Caching until restart broke the promise this comment used to
   * make: the first call before the device was approved cached an empty map,
   * and the secrets then never appeared, however long the bridge ran and
   * whoever approved it. See secretsFor().
   */
  private secrets?: SecretStore;
  /** When this.secrets was fetched, for the TTL in secretsFor(). */
  private secretsFetchedAt = 0;
  /**
   * How much a single space may run at once, and how fast.
   *
   * On the Bridge rather than per call, because the point is to bound what one
   * space can do over time: a limiter created per call counts to one and stops
   * nothing. See src/local/limits.ts.
   */
  private readonly localLimiter = new SpaceLimiter();
  /**
   * Bridge-side HTTP MCP server. Tools/list returns the welcome's registered
   * tools; tools/call routes through the WebSocket via toolResolver. The
   * server is started lazily on the first welcome that registers any tools.
   */
  private readonly mcpServer: BridgeMcpServer;
  /**
   * The server-supplied CLI isolation posture. Defaults to `isolated` for
   * older servers that don't send the field — the safe default.
   */
  private cliIsolation: CliIsolation = 'isolated';
  /** Registered tools from the most recent welcome — passed to each adapter. */
  private currentTools: import('./protocol/types.js').ToolDefinition[] = [];
  private readonly testMode: boolean;
  private readonly onTestRequest?: BridgeOptions['onTestRequest'];

  private sessionId: string | null = null;
  private serverConfig: ServerConfig = {
    heartbeat_interval: DEFAULT_HEARTBEAT_SECONDS,
    request_timeout: DEFAULT_REQUEST_TIMEOUT_SECONDS,
  };
  /** Timer to detect a missing welcome message after hello is sent. */
  private welcomeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private activeRequests = new Map<string, AbortController>();
  /**
   * Request IDs aborted because the WebSocket dropped while they were in
   * flight. No terminal event could be sent over the closed socket, so on the
   * next welcome these are replayed as terminal errors to release the
   * browser's loading state.
   */
  private abortedRequestIds: string[] = [];
  /** Monotonic counter for synthesizing tool_call_ids for MCP-originated calls. */
  private mcpToolCallSeq = 0;

  /** Directories a server may name. Empty means none — see BridgeOptions. */
  private readonly allowedRoots: AllowedRoot[];
  /** Cached `allowedRoots` paths, which is all the containment check needs. */
  private readonly allowedRootPaths: string[];
  /** Where attachments come from and go to. */
  private readonly apiOrigin: string;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly keepAttachments: boolean;
  /** Whether the operator permitted the server to select `native`. */
  private readonly allowNative: boolean;
  /**
   * In-flight MCP server startup from the current handshake, if any.
   *
   * Requests await it, so a turn sent immediately after `welcome` gets the
   * tool channel rather than racing it.
   */
  private mcpStarting: Promise<void> | null = null;
  /**
   * Which directory each CLI session was started in, so a resume that names a
   * different one can be refused instead of silently running against a
   * session whose whole history is about another checkout.
   */
  private readonly sessionWorkingDirs: SessionWorkingDirs;
  /**
   * Per-request state the bridge-owned MCP tools need.
   *
   * Keyed by request id, which is what the MCP server resolves from the
   * per-spawn bearer token — so a tool call always reads the state of the turn
   * that made it, even with several CLIs running at once.
   */
  private readonly uploadContexts = new Map<string, UploadContext>();

  constructor(options: BridgeOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.providers = options.providers;
    this.adapters = options.adapters;
    // Absent means off. A server cannot turn this on by sending a field.
    this.localExecution = options.localExecution ?? LOCAL_EXECUTION_OFF;
    this.engram = options.engram;
    this.identity = options.identity;
    this.testMode = options.testMode ?? false;
    this.onTestRequest = options.onTestRequest;
    // Absent means no directory may be named. A server cannot widen this.
    this.allowedRoots = options.allowedRoots ?? [];
    this.allowedRootPaths = rootPaths(this.allowedRoots);
    this.apiOrigin = options.apiOrigin ?? resolveApiOrigin(options.serverUrl);
    this.attachmentLimits = options.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
    this.keepAttachments = options.keepAttachments ?? false;
    this.allowNative = options.allowNative ?? false;
    this.sessionWorkingDirs = new SessionWorkingDirs(
      undefined,
      options.sessionStorePath === undefined ? sessionStorePath() : options.sessionStorePath,
    );

    // The MCP server's tool-call handler proxies through the existing
    // toolResolver → WebSocket round-trip. The requestId comes from the
    // per-spawn token the CLI presented, looked up by BridgeMcpServer.
    this.mcpServer = new BridgeMcpServer(async (requestId, toolName, args) => {
      // Bridge-owned tools first, and by exact name. These never become a
      // `tool_call` frame: the server has no idea what a path on this machine
      // is, and asking it would be both useless and a disclosure.
      //
      // Gated on the tool actually being REGISTERED, not just on the name. Two
      // things go wrong otherwise: in `isolated` the tool is withheld from
      // tools/list but would still answer if invoked, and a server that
      // declares a tool of its own called `bridge__attach_file` would have it
      // silently hijacked into the bridge's uploader instead of round-tripping.
      if (toolName === ATTACH_FILE_TOOL && this.mcpServer.hasBridgeTool(ATTACH_FILE_TOOL)) {
        return this.handleAttachFile(requestId, args);
      }

      const tool = this.currentTools.find((t) => t.name === toolName);

      // The one place local execution is decided. A tool the server marked
      // `local` on a bridge that never opted in falls through to the server
      // path, where it fails as any unknown tool does.
      if (runsLocally(this.localExecution, tool)) {
        return this.runToolHere(tool!, args);
      }
      const refused = refusalReason(this.localExecution, tool);
      if (refused) log.warn('refusing a local tool', { name: toolName, reason: refused });

      const toolCallId = `mcp-${requestId}-${++this.mcpToolCallSeq}`;
      return this.toolResolver.call(
        (reqId, tcId, tName, tArgs) => {
          this.send({
            type: 'tool_call',
            request_id: reqId,
            tool_call_id: tcId,
            tool_name: tName,
            arguments: tArgs,
          });
        },
        requestId,
        toolCallId,
        toolName,
        args,
      );
    });

  }

  /**
   * Register the bridge's own tools for the posture just adopted.
   *
   * Not in the constructor, because whether they are offered depends on the
   * isolation posture, which arrives on the welcome. `isolated` is documented
   * as "server-declared tools only", and a bridge-owned tool that performs a
   * network upload is not a server-declared tool — offering it there would
   * make the sentence false and would start an MCP server for a deployment
   * that registered no tools at all, which used to configure none.
   */
  private registerBridgeTools(): void {
    const tools = this.cliIsolation === 'isolated'
      ? []
      : [ATTACH_FILE_TOOL_DEFINITION as unknown as import('./protocol/types.js').ToolDefinition];

    this.mcpServer.setBridgeTools(tools);
  }

  /**
   * Handle the model calling `bridge__attach_file`.
   *
   * Runs entirely on this machine: the file is read here, uploaded to the
   * server's HTTP API, and announced to the turn as an `attachment` stream
   * event. What the model gets back is a plain sentence, because that is what
   * it can act on — a JSON blob describing an upload tells it nothing useful
   * about whether the user can now see the file.
   */
  private async handleAttachFile(
    requestId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ctx = this.uploadContexts.get(requestId);
    if (!ctx) {
      // The turn is over (or was never ours). Refusing beats uploading a file
      // on behalf of a request nobody is listening to any more.
      throw new Error('this turn is no longer active, so the file cannot be sent');
    }

    const rawPath = args['path'];
    const description = typeof args['description'] === 'string' ? args['description'] : undefined;
    if (typeof rawPath !== 'string') {
      throw new Error('path is required and must be a string');
    }

    const uploaded = await uploadAttachment(rawPath, description, ctx);

    this.sendStreamEvent(requestId, 'attachment', {
      id: uploaded.id,
      name: uploaded.name,
      mime_type: uploaded.mimeType,
      size: uploaded.size,
      ...(description ? { description } : {}),
    });

    log.info('Attachment sent to server', {
      requestId,
      id: uploaded.id,
      name: uploaded.name,
      size: uploaded.size,
    });

    return `Sent "${uploaded.name}" to the user in the chat.`;
  }

  /**
   * Run a tool on this machine, with the secrets it declared and no others.
   *
   * The secret values never enter a tool_call frame, which is the whole reason
   * this path exists. What goes back to the model is the tool's output with
   * those values redacted, which stops the accidental echo and does not pretend
   * to stop a deliberate one.
   */
  private async runToolHere(
    tool: import('./protocol/types.js').ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!tool.run?.command) {
      throw new Error(`local tool "${tool.name}" has no command to run`);
    }

    // Both bindings, resolved in the tool's own space and nowhere else. A tool
    // that names neither resolves nothing and never asks Engram for anything.
    const names = tool.secrets ?? [];
    const fill = tool.fill ?? [];
    const store = await this.secretsFor(tool.space_id, {
      names,
      ids: fill.map((f) => f.secret_id),
    });

    const granted: Redaction[] = [...grantedTo(store, tool.space_id, tool.secrets)];
    if (fill.length > 0) {
      if (!tool.space_id) {
        throw new Error(
          `local tool "${tool.name}" fills roles but names no space, so there is no ` +
          `space to resolve those secret ids in.`,
        );
      }
      granted.push(...fillRoles(store, tool.space_id, fill));
    }

    const staged = await stagePackage(tool.package, {
      ...(this.localExecution.dataDir ? { dataDir: this.localExecution.dataDir } : {}),
      spaceId: tool.space_id,
      ...(this.localExecution.workdir ? { fallbackCwd: this.localExecution.workdir } : {}),
    });

    const result = await runLocalTool({
      name: tool.name,
      command: tool.run.command,
      args: tool.run.args ?? [],
      toolArgs: args,
      secrets: granted,
      ...(staged.cwd ? { cwd: staged.cwd } : {}),
      extraEnv: staged.extraEnv,
      sandbox: {
        ...(tool.network !== undefined ? { network: tool.network } : {}),
        ...(staged.readDir ? { readDir: staged.readDir } : {}),
      },
    });

    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.timedOut ? { timed_out: true } : {}),
      // What actually confined the tool, which on some machines is nothing.
      // Reported rather than assumed: see src/local/sandbox.ts.
      sandbox: result.sandbox,
    };
  }

  /**
   * Run one tool because the SERVER asked, rather than because a model did.
   *
   * Same gate, same space check, same limiter, same sandbox. The only thing
   * this adds is the frame: the answer goes back over the WebSocket as a
   * `local_result` carrying the id the call arrived with, so a server that
   * sent ten calls can tell which one answered.
   */
  private handleLocalCallMessage(message: LocalCallMessage): void {
    void handleLocalCall(
      {
        config: this.localExecution,
        limiter: this.localLimiter,
        secrets: (spaceId, ids) => this.secretsFor(spaceId, { ids }),
        ...(this.localExecution.dataDir ? { dataDir: this.localExecution.dataDir } : {}),
      },
      message,
    ).then(
      (result) => this.send(result),
      // handleLocalCall answers rather than throwing, so reaching this means
      // the socket itself failed. Logged rather than left as an unhandled
      // rejection that would take the bridge down mid-session.
      (err: unknown) => log.error('could not answer a local_call', {
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /**
   * The secrets available to a tool that declared `wanted`.
   *
   * Three rules, each fixing something a fetch-once cache got wrong:
   *
   * 1. A tool that declares nothing never triggers a fetch, so a bridge whose
   *    local tools need no credential still never asks Engram for one.
   * 2. A declared secret that is not in the cache re-fetches before giving up.
   *    This is the case the old comment claimed and the code did not do: the
   *    first local tool call made before anyone approved the device cached an
   *    empty map, and no approval afterwards could ever be seen without a
   *    restart. It also covers a secret granted to an already-approved device.
   * 3. Anything cached longer than the TTL is re-fetched. A revoked device or a
   *    rotated value is otherwise honoured for the life of the process.
   *
   * What this does NOT cover, deliberately: a revocation is still served from
   * cache for up to the TTL, because the alternative is a network round trip on
   * every tool call and Engram being briefly unreachable would then break tools
   * that have a perfectly good credential in hand. And nothing can recall a
   * value already handed to a running tool. A short window, not zero.
   *
   * A fetch that fails fails the tool call rather than falling back to the
   * cache. From here an unreachable Engram and a revoked device look the same,
   * and the one that must not run is the revoked one.
   */
  private async secretsFor(
    spaceId: string | undefined,
    wanted: { names?: string[]; ids?: string[] },
  ): Promise<SecretStore> {
    const names = wanted.names ?? [];
    const ids = wanted.ids ?? [];
    if (names.length === 0 && ids.length === 0) return new SecretStore();
    if (!this.engram || !this.identity?.deviceId) return this.secrets ?? new SecretStore();

    const fresh = this.secrets !== undefined && Date.now() - this.secretsFetchedAt < SECRETS_TTL_MS;
    // "Complete" is asked space by space, because that is the only question
    // worth asking: a secret of this name held by some OTHER space does not
    // make this call resolvable, and treating it as if it did is the bug the
    // store was rebuilt to remove.
    const complete = spaceId !== undefined
      && names.every((name) => this.secrets?.hasName(spaceId, name))
      && ids.every((id) => this.secrets?.hasId(spaceId, id));
    if (fresh && complete) return this.secrets!;

    this.secrets = await loadSecrets(this.engram, this.identity, this.identity.deviceId);
    this.secretsFetchedAt = Date.now();
    return this.secrets;
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initiate the WebSocket connection to the server.
   *
   * The token is sent as an Authorization: Bearer header so it does NOT appear
   * in server/proxy access logs.  It is also kept in the URL query parameter as
   * a backward-compatible fallback for servers that have not yet adopted the
   * header-based flow.
   *
   * NOTE: When passing --token on the command line the value is still visible
   * in process listings (ps aux).  Prefer the AI_BRIDGE_TOKEN environment
   * variable to avoid this.
   */
  connect(): void {
    if (this.ws) {
      log.warn('connect() called while already connected — ignoring');
      return;
    }

    // Keep token in query param for backward compatibility, but also send it
    // in the Authorization header as the primary (log-safe) channel.
    const url = new URL(this.serverUrl);
    url.searchParams.set('token', this.token);
    const wsUrl = url.toString();

    log.info('Connecting to server', { url: this.serverUrl });

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': `ai-bridge/${BRIDGE_VERSION}`,
        // Send token via Authorization header (not visible in proxy logs)
        'Authorization': `Bearer ${this.token}`,
      },
      // Limit incoming message size to 10MB to prevent memory exhaustion
      maxPayload: 10 * 1024 * 1024,
    });

    this.ws.on('open', this.onOpen.bind(this));
    this.ws.on('message', this.onMessage.bind(this));
    this.ws.on('close', this.onClose.bind(this));
    this.ws.on('error', this.onError.bind(this));
  }

  /**
   * Gracefully disconnect from the server.
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.toolResolver.cancelAll();
    await this.mcpServer.stop();

    // Cancel active requests
    for (const [id, controller] of this.activeRequests) {
      controller.abort();
      log.debug('Cancelled active request', { requestId: id });
    }
    this.activeRequests.clear();

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Bridge shutting down');
      }
      this.ws = null;
    }

    log.info('Bridge disconnected');
  }

  /**
   * Returns true if the WebSocket is currently open.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------------------
  // WebSocket Event Handlers
  // -------------------------------------------------------------------------

  private onOpen(): void {
    log.info('WebSocket connected');
    this.reconnectAttempts = 0;
    this.emit('connected');
    this.sendHello();
    // Re-probing happens once handleWelcome() completes the handshake — so
    // any providers_update that fires is strictly post-welcome and never
    // arrives at the server with the connection still pending. See
    // handleWelcome().
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: ServerToBridgeMessage;
    try {
      message = JSON.parse(data.toString()) as ServerToBridgeMessage;
    } catch (err) {
      log.error('Failed to parse server message', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    log.debug('Received message', { type: message.type });

    switch (message.type) {
      case 'welcome':
        this.handleWelcome(message);
        break;
      case 'ai_request':
        this.handleAiRequest(message);
        break;
      case 'tool_resolve':
        this.toolResolver.resolve(message.tool_call_id, message.result);
        break;
      case 'tool_error':
        this.toolResolver.reject(message.tool_call_id, message.error);
        break;
      case 'pong':
        log.debug('Pong received', { timestamp: message.timestamp });
        // Mark pong received and clear the timeout
        this.awaitingPong = false;
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
          this.pongTimeoutTimer = null;
        }
        break;
      case 'error':
        this.handleServerError(message);
        break;
      case 'connection_error':
        this.handleConnectionError(message);
        break;
      case 'token_refresh':
        this.adoptRefreshedToken(message.token, 'token_refresh message');
        break;
      case 'local_call':
        this.handleLocalCallMessage(message);
        break;
      default:
        log.warn('Unknown message type received', { type: (message as { type: string }).type });
    }
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString();
    log.info('WebSocket closed', { code, reason: reasonStr });
    this.stopHeartbeat();
    // Clear welcome timeout if connection closes before welcome arrives
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.ws = null;
    // Clear the stale session ID so the welcome-timeout guard on the next
    // reconnect correctly detects a missing welcome.
    this.sessionId = null;

    // Cancel all pending tool resolvers immediately on WebSocket close to fail
    // in-flight tool calls instead of letting them stall.
    this.toolResolver.cancelAll();

    // Abort all active AI requests on unexpected disconnect so their CLI
    // subprocesses are terminated; otherwise the server never receives a done
    // event and the conversation slot stays blocked until its timeout fires.
    if (!this.isShuttingDown) {
      for (const [id, controller] of this.activeRequests) {
        controller.abort();
        // Record the aborted request so it can be replayed as a
        // terminal error after reconnect.
        this.abortedRequestIds.push(id);
        log.debug('Aborted active request on disconnect', { requestId: id });
      }
      this.activeRequests.clear();
    }

    this.emit('disconnected', code, reasonStr);

    if (!this.isShuttingDown) {
      // Check for authentication rejection — don't retry, exit immediately
      if (code === 4001) {
        // Stop the bridge MCP server before emitting the fatal error.
        this.mcpServer.stop().catch(() => {
          // Best-effort cleanup; ignore errors during shutdown
        });

        this.isShuttingDown = true;
        this.emit(
          'error',
          new FatalBridgeError(
            'Connection rejected: invalid or expired token. Generate a new token from your application\'s dashboard and restart the bridge.',
          ),
        );
        return;
      }

      this.scheduleReconnect();
    }
  }

  private onError(err: Error): void {
    log.error('WebSocket error', { error: err.message });
    this.emit('error', err);
  }

  // -------------------------------------------------------------------------
  // Protocol Handlers
  // -------------------------------------------------------------------------

  /**
   * Send hello message per PROTOCOL.md:
   * { type: "hello", version, bridge_version, providers[] }
   * NO token field — token is in the URL query param.
   * NO id field on providers — just name.
   */
  private sendHello(): void {
    // Advertise only providers whose CLI was actually detected — the server
    // should never offer the user a provider this machine cannot run.
    const availableProviders = this.providers.filter((p) => p.available);
    const hello: BridgeToServerMessage = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      bridge_version: BRIDGE_VERSION,
      providers: availableProviders,
      // Advertise the operator's allow-list so the server can offer a picker
      // rather than asking a developer to type an absolute path into a chat
      // box. Omitted entirely when empty: "no workspaces" and "this bridge
      // predates workspaces" should look the same to the server, because in
      // both cases naming a directory is refused.
      ...(this.allowedRoots.length > 0
        ? { workspaces: toWorkspaceRefs(this.allowedRoots) }
        : {}),
    };
    this.send(hello);
    log.info('Hello sent', {
      protocol: PROTOCOL_VERSION,
      providers: availableProviders.map((p) => p.name),
      workspaces: this.allowedRoots.map((r) => r.label),
    });

    // If no welcome arrives within 15s the server silently dropped our hello;
    // close and reconnect so we don't stall forever.
    this.welcomeTimeoutTimer = setTimeout(() => {
      this.welcomeTimeoutTimer = null;
      if (!this.sessionId && !this.isShuttingDown) {
        log.error('Welcome message not received within 15 seconds after hello — reconnecting');
        this.ws?.close(4000, 'Welcome timeout');
      }
    }, 15_000);
  }

  /**
   * Re-probe the local provider CLIs and, if the available set changed since
   * what was last advertised, push a `providers_update` to the server.
   *
   * Called after each handshake (catches a CLI installed or removed while the
   * bridge was offline or before a reconnect) and after a provider spawn
   * failure (catches a CLI removed mid-session — the next request's ENOENT
   * triggers a re-probe so the UI's provider list self-heals).
   *
   * Best-effort: a detection failure is logged and swallowed — it must never
   * disrupt an active connection.
   */
  private async refreshProviders(): Promise<void> {
    let detected: ProviderCapability[];
    try {
      detected = await detectProviders();
    } catch (err) {
      log.warn('Provider re-detection failed — keeping current provider list', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // detectProviders() probes CLI presence and version only — it does NOT
    // populate `models`. Without re-listing them here, every re-detection
    // advertises model-less providers to the server and empties the chat
    // UI's model dropdowns. Mirror the startup model-population in cli.ts.
    await this.populateModels(detected);

    const signature = (list: ProviderCapability[]): string =>
      list
        .filter((p) => p.available)
        .map((p) => p.name)
        .sort()
        .join(',');

    const before = signature(this.providers);
    const after = signature(detected);
    this.providers = detected;

    if (before === after) {
      return;
    }

    log.info('Available providers changed', { before: before || '(none)', after: after || '(none)' });

    if (this.isConnected()) {
      this.send({
        type: 'providers_update',
        providers: detected.filter((p) => p.available),
      });
      log.info('Sent providers_update to server');
    }
  }

  /**
   * Populate each available provider's `models` list via its adapter.
   *
   * detectProviders() only probes CLI presence/version; model enumeration is
   * a separate per-adapter call. Used by the post-detection refresh path so a
   * re-detection never strips models from the advertised capabilities.
   * Best-effort per provider: a listModels() failure leaves that provider
   * without models rather than aborting the whole refresh.
   */
  private async populateModels(capabilities: ProviderCapability[]): Promise<void> {
    await Promise.all(
      capabilities
        .filter((capability) => capability.available)
        .map(async (capability) => {
          const adapter = this.adapters.get(capability.name);
          if (!adapter) {
            return;
          }
          try {
            capability.models = await adapter.listModels();
          } catch (err) {
            log.warn(`Failed to list models for ${capability.name}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
    );
  }

  private async handleWelcome(message: WelcomeMessage): Promise<void> {
    // Cancel the welcome-timeout now that we've received the welcome.
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.sessionId = message.session_id;
    this.serverConfig = message.config;

    // The server tops up long-lived tokens — adopt a fresh one if offered.
    if (message.refreshed_token) {
      this.adoptRefreshedToken(message.refreshed_token, 'welcome message');
    }

    // Check protocol version compatibility if the server provides one
    if (message.protocol_version) {
      const serverMajor = message.protocol_version.split('.')[0];
      const bridgeMajor = PROTOCOL_VERSION.split('.')[0];
      if (serverMajor !== bridgeMajor) {
        log.warn('Protocol version mismatch — major versions differ', {
          server: message.protocol_version,
          bridge: PROTOCOL_VERSION,
        });
      }
    }

    // Clamp request_timeout to a safe range (10–3600 s) before applying — a
    // malicious or misconfigured server could send 0 or a huge value.
    if (message.config.request_timeout) {
      const raw = message.config.request_timeout;
      const clamped = clampRequestTimeout(raw);
      if (clamped !== raw) {
        log.warn('Server request_timeout is outside safe range — clamping', {
          received: raw,
          clamped,
        });
      }
      this.toolResolver.setTimeoutMs(clamped * 1000);
      // Write the clamped value back so generateScripts (below) uses the same
      // timeout as the tool resolver.
      this.serverConfig.request_timeout = clamped;
    }

    // Adopt the server's CLI isolation posture. Older servers that don't
    // send the field get the safe default (`isolated`) — never the legacy
    // native behaviour.
    const posture = this.adoptIsolation(message.cli_isolation);
    this.cliIsolation = posture.adopted;
    this.currentTools = message.tools;
    this.mcpServer.setTools(message.tools);
    // After the posture is known — it decides whether they are offered at all.
    this.registerBridgeTools();

    // Tell the server what is actually in force. Sent whether or not it
    // matches what was asked for: a server needs to know the posture, not just
    // be told when it was declined, and absence of this frame means an older
    // bridge rather than agreement.
    this.send({
      type: 'posture',
      cli_isolation: posture.adopted,
      requested: posture.requested,
      ...(posture.reason ? { reason: posture.reason } : {}),
      ...(posture.message ? { message: posture.message } : {}),
    });
    log.info('Welcome registered tools', {
      count: message.tools.length,
      cliIsolation: this.cliIsolation,
    });

    // Start the bridge-side MCP server once tools are present. Spawned CLIs
    // talk to it via per-spawn bearer tokens (see executeAiRequestInternal).
    // The server stays up across reconnects so an in-flight CLI never loses
    // its tool channel mid-turn.
    // hasTools() rather than `message.tools.length > 0`: the bridge owns tools
    // of its own now (bridge__attach_file), and a server that registers none
    // must still get an MCP channel for those.
    if (this.mcpServer.hasTools() && !this.mcpServer.isRunning()) {
      try {
        this.mcpStarting = this.mcpServer.start();
        await this.mcpStarting;
        log.info('MCP tool channel ready', {
          url: this.mcpServer.getBaseUrl(),
          tools: message.tools.map((t) => t.name),
          cliIsolation: this.cliIsolation,
        });
      } catch (err) {
        log.error('Failed to start bridge MCP server', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Notify the server so it can warn the user — all tool calls will fail
        // for this session because the MCP server could not start.
        this.send({
          type: 'error',
          request_id: 'setup',
          code: 'tool_setup_failed',
          message: `Bridge MCP server failed to start — tool calls will not work for this session: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        });
      }
    }

    // Start heartbeat — config.heartbeat_interval is in SECONDS.  Clamp to a
    // safe range to prevent a ping flood or an excessively long dead-connection
    // window.
    const rawHeartbeat = message.config.heartbeat_interval;
    const clampedHeartbeat = clampHeartbeat(rawHeartbeat);
    if (clampedHeartbeat !== rawHeartbeat) {
      log.warn('Server heartbeat_interval is outside safe range — clamping', {
        received: rawHeartbeat,
        clamped: clampedHeartbeat,
      });
    }
    const intervalMs = clampedHeartbeat * 1000;
    this.startHeartbeat(intervalMs);

    log.info('Welcome received', {
      sessionId: this.sessionId,
      toolCount: message.tools.length,
      heartbeatSeconds: message.config.heartbeat_interval,
    });

    this.emit('welcome', this.sessionId);

    // Re-probe the local CLIs now that the handshake is fully complete. The
    // hello above already advertised the last-known set; if detection now
    // finds a different set (a CLI installed or removed since),
    // refreshProviders() pushes a providers_update. Runs in the background
    // and is intentionally post-welcome so any update is unambiguously
    // ordered after the handshake.
    void this.refreshProviders();

    // Replay any requests aborted by a previous disconnect as terminal errors
    // now that the connection is back, so the browser exits its loading state
    // instead of waiting for the server's own timeout.
    if (this.abortedRequestIds.length > 0) {
      const replayed = this.abortedRequestIds;
      this.abortedRequestIds = [];
      for (const requestId of replayed) {
        log.info('Replaying aborted request as a terminal error', { requestId });
        this.send({
          type: 'error',
          request_id: requestId,
          code: 'bridge_disconnected',
          message: 'Request aborted: the bridge connection dropped while the response was streaming.',
          fatal: false,
        });
      }
    }
  }

  /**
   * Decide the isolation posture to actually run under.
   *
   * Two things happen here that must not be skipped.
   *
   * First, the value is VALIDATED against the three literals. Every adapter
   * tests it with `!== 'isolated'` or `!== 'native'`, so an unrecognised
   * string — a typo, a newer server, `"Isolated"` — would land in the
   * permissive branch on one provider and the restrictive branch on another.
   * Anything unknown becomes `isolated`.
   *
   * Second, `workspace` is GATED ON THE OPERATOR'S ALLOW-LIST. Without this
   * the posture is a capability a server can switch on by sending a field:
   * `workspace` is what adds `bypassPermissions` / `workspace-write` /
   * `--yolo`, and none of those care whether a working directory was named.
   * A bridge started with no `--allow-dir` would then still hand a hostile
   * server a shell — in the empty scratch directory, from which `cd ~/.ssh`
   * is one command — while the README promised that such a bridge "cannot be
   * pointed anywhere". The allow-list has to gate the capability, not just
   * the cwd, or the sentence is not true.
   *
   * This mirrors the `--local-tools` gate exactly: the operator opts in, and
   * no server can turn it on by sending a field.
   */
  private adoptIsolation(requested: CliIsolation | undefined): AdoptedPosture {
    if (requested === undefined) {
      // An older server that does not send the field gets the safe default,
      // never the legacy native behaviour.
      return { adopted: 'isolated', requested: null, reason: 'not_requested' };
    }

    if (requested !== 'isolated' && requested !== 'native' && requested !== 'workspace') {
      const message = `Server sent an unrecognised cli_isolation (${String(requested)}) — running \`isolated\`.`;
      log.warn(message);

      return { adopted: 'isolated', requested: String(requested), reason: 'unrecognised', message };
    }

    if (requested === 'workspace' && this.allowedRoots.length === 0) {
      const message =
        'Server asked for `workspace` isolation, but this bridge was started without --allow-dir. '
        + 'Running `isolated` instead: workspace mode gives the CLI a shell on this machine, and '
        + 'that is the operator\'s decision to make, not the server\'s. Pass --allow-dir <path> to enable it.';
      log.warn(message);

      return { adopted: 'isolated', requested, reason: 'requires_allow_dir', message };
    }

    // `native` is gated too, and for the same reason — more so, in fact, since
    // it is strictly MORE permissive than `workspace`: it adds the bypass flags
    // AND drops `--strict-mcp-config`, handing over the operator's own MCP
    // servers, hooks and plugins as well as a shell.
    //
    // Gating only `workspace` would have been security theatre: a server denied
    // the shell one way could simply ask for it the other way, and get more.
    if (requested === 'native' && !this.allowNative) {
      const message =
        'Server asked for `native` isolation, which hands this machine\'s full CLI environment '
        + '— shell, your MCP servers, hooks and plugins — to whatever the server sends. '
        + 'Running `isolated` instead. Pass --allow-native if the server is one you would give a shell to.';
      log.warn(message);

      return { adopted: 'isolated', requested, reason: 'requires_allow_native', message };
    }

    return { adopted: requested, requested };
  }

  /**
   * Handle an incoming ai_request: send ack, then execute.
   *
   * The server owns the conversation→CLI-session mapping. `message.cli_session_id`
   * is the session to resume (non-null) or null to start fresh. On a fresh
   * start, `message.history` (when present) is folded into the system prompt
   * so the new CLI session is seeded with context — e.g. the first turn after
   * the server reset a lost session.
   */
  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id } = message;
    const cliSessionId = message.cli_session_id ?? null;

    // Acknowledge receipt, echoing the session the server asked us to use.
    this.send({
      type: 'ai_request_ack',
      request_id,
      cli_session_id: cliSessionId,
    });

    // Fresh session: seed the new CLI session with any prior history the
    // server sent. A resumed session already holds its own context. WHERE the
    // history goes depends on how the provider delivers its prompt: Claude
    // reads the user prompt from STDIN (no size limit), so fold history into
    // the message — folding a large history into the `--system-prompt` argument
    // would blow the OS arg-size limit (`spawn E2BIG`). Argument-fed CLIs
    // (Codex/Gemini) keep history in the system prompt as before.
    let effectiveMessage = message;
    if (cliSessionId === null && message.history && message.history.length > 0) {
      log.debug('Seeding fresh CLI session with prior history', {
        conversationId: message.conversation_id,
        historyLength: message.history.length,
        provider: message.provider,
      });
      effectiveMessage = message.provider === 'claude'
        ? {
            ...message,
            message: foldHistoryIntoMessage(message.history, message.message),
          }
        : {
            ...message,
            system_prompt: foldHistoryIntoSystemPrompt(message.history, message.system_prompt),
          };
    }

    this.executeAiRequestInternal(effectiveMessage, cliSessionId);
  }

  /**
   * Internal request execution: resolve the adapter and run the request.
   * Does NOT send ai_request_ack — handleAiRequest does that.
   */
  private executeAiRequestInternal(
    message: AiRequestMessage,
    cliSessionId: string | null,
  ): void {
    const { request_id, provider } = message;

    // Test mode: use mock handler
    if (this.testMode && this.onTestRequest) {
      this.emit('request_start', request_id, provider, message.options?.model);
      const sendEvent = (event: StreamEventType, data: StreamEventData) => {
        this.sendStreamEvent(request_id, event, data);
      };
      this.onTestRequest(message, sendEvent)
        .catch((err) => {
          log.error('Test mode handler failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.sendStreamEvent(request_id, 'error', {
            code: 'test_error',
            message: err instanceof Error ? err.message : String(err),
          });
          this.sendStreamEvent(request_id, 'done', {});
        })
        .finally(() => {
          this.emit('request_end', request_id);
        });
      return;
    }

    // Find the adapter for the requested provider
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      log.error('No adapter for requested provider', { provider });
      const installHints: Record<string, string> = {
        codex: ' Install the Codex CLI (https://github.com/openai/codex) on the machine running the bridge and restart it.',
        claude: ' Install the Claude CLI (https://claude.ai/download) on the machine running the bridge and restart it.',
        gemini: ' Install the Gemini CLI (https://github.com/google-gemini/gemini-cli) on the machine running the bridge and restart it.',
      };
      const hint = installHints[provider] ?? '';
      this.send({
        type: 'error',
        request_id,
        code: 'provider_unavailable',
        message: `Provider "${provider}" is not available on this bridge.${hint}`,
        fatal: true,
      });
      return;
    }

    this.emit('request_start', request_id, provider, message.options?.model);

    // Execute asynchronously
    const controller = new AbortController();
    this.activeRequests.set(request_id, controller);

    this.executeRequest(adapter, message, cliSessionId, controller.signal)
      .catch((err) => {
        const errMessage = err instanceof Error ? err.message : String(err);
        const wasResumeAttempt = cliSessionId !== null;

        // A refusal is terminal and carries its own code. It has to be handled
        // BEFORE the resume branch below: that branch turns any failure on a
        // resumed turn into `session_lost`, which tells the server to wipe the
        // session and quietly re-issue the turn — so a refusal would be
        // retried forever, and the reason would never reach anyone.
        if (err instanceof RequestRefusal) {
          log.warn('Refusing request', {
            requestId: request_id,
            code: err.code,
            reason: errMessage,
          });
          this.sendStreamEvent(request_id, 'error', {
            code: err.code,
            message: errMessage,
          });
          this.sendStreamEvent(request_id, 'done', {});
          return;
        }

        log.error('Request execution failed', {
          requestId: request_id,
          resumeAttempt: wasResumeAttempt,
          error: errMessage,
        });

        if (wasResumeAttempt) {
          // The server asked to resume a CLI session this bridge could not
          // resume (expired, cleared, or created on another machine). Report
          // it as `session_lost` — a recoverable signal: the server wipes the
          // stored id and silently re-issues the turn as a fresh session. No
          // `done` is sent here; the re-issued turn produces its own terminal
          // events. (A genuinely unrelated failure simply resurfaces on the
          // fresh retry, so this broad treatment is safe.)
          // The session is gone, so what we remember about where it ran is
          // stale. Dropping it means the server's re-issued turn is judged on
          // its own merits rather than against a directory that no longer has
          // a session behind it.
          if (cliSessionId !== null) {
            this.sessionWorkingDirs.forget(cliSessionId);
          }
          this.sendStreamEvent(request_id, 'error', {
            code: 'session_lost',
            message: `Could not resume CLI session: ${errMessage}`,
          });
          return;
        }

        // A genuine failure on a fresh request — surface it and end the turn.
        this.sendStreamEvent(request_id, 'error', {
          code: 'provider_error',
          message: errMessage,
        });
        this.sendStreamEvent(request_id, 'done', {});
      })
      .finally(() => {
        this.activeRequests.delete(request_id);
        this.emit('request_end', request_id);
      });
  }

  private async executeRequest(
    adapter: ProviderAdapter,
    request: AiRequestMessage,
    cliSessionId: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const { request_id } = request;

    // Issue a per-spawn MCP bearer token if the MCP server is running. The
    // token is mapped to this request_id so the MCP server can route
    // tools/call from the spawned CLI to the right WebSocket request frame.
    // Skipped when no tools are registered or the MCP server failed to start.
    // Wait for the handshake's MCP startup to finish before deciding whether
    // there is a channel. Without this, a server that sends `ai_request`
    // immediately after `welcome` — which is the normal thing for a server
    // with a queued turn to do — races the listener and the turn runs with no
    // tools at all, silently, because `mcp` is simply null.
    if (this.mcpStarting) {
      try {
        await this.mcpStarting;
      } catch {
        // start() already reported its own failure to the server; a turn
        // without tools is still better than no turn.
      }
    }

    const mcpEnabled = this.mcpServer.hasTools() && this.mcpServer.isRunning();
    const mcpToken = mcpEnabled ? this.mcpServer.issueToken(request_id) : null;
    const mcp = mcpEnabled && mcpToken
      ? { url: this.mcpServer.getBaseUrl(), bearerToken: mcpToken }
      : null;
    if (mcp) {
      log.info('MCP token issued for request', {
        requestId: request_id,
        provider: request.provider,
        tokenTail: mcp.bearerToken.slice(-6),
      });
    } else if (this.mcpServer.hasTools()) {
      log.warn('MCP unavailable for request (no token issued)', {
        requestId: request_id,
        provider: request.provider,
        mcpRunning: this.mcpServer.isRunning(),
      });
    }

    // Everything from here is inside the try whose `finally` revokes the
    // per-spawn MCP token and clears the attachment directory. The refusals
    // below throw, and a throw that escaped before the try was entered would
    // leave a live credential in the MCP server's token map for the life of
    // the process — one per refused turn, never collected — and any
    // part-downloaded attachments on disk.
    try {
      // Where this turn runs. A refusal here throws and the turn never spawns:
      // there is deliberately no fallback to the scratch directory, because a
      // turn that runs in the wrong place looks exactly like one that worked.
      //
      // The session's own directory is passed in so a resume can be checked
      // against it — and so a resume that names NOTHING keeps the directory it
      // has rather than being told it moved to the scratch dir.
      const workingDir = resolveWorkingDir(
        request.working_dir,
        this.allowedRootPaths,
        cliSessionId !== null ? this.sessionWorkingDirs.get(cliSessionId) : undefined,
      );

      // Attachments land on disk before the CLI starts, so the preamble below
      // can name paths that already exist. The cleanup for a failure part-way
      // through is the same `finally` that handles every other outcome, so a
      // refused turn leaves nothing behind either.
      let saved: SavedAttachment[] = [];
      const attachments = request.attachments ?? [];
      if (attachments.length > 0) {
        saved = await fetchAttachments({
          attachments,
          requestId: request_id,
          token: () => this.token,
          expectedOrigin: this.apiOrigin,
          limits: this.attachmentLimits,
          signal,
          keep: this.keepAttachments,
        });
      }

      // Tell the model what was saved and where. Without this the files are
      // present and invisible, and the turn answers as if nothing had been
      // attached.
      const effectiveRequest: AiRequestMessage = saved.length > 0
        ? { ...request, message: buildAttachmentPreamble(saved) + request.message }
        : request;

      // State the bridge-owned MCP tools read, keyed by request id so
      // concurrent turns cannot read each other's.
      this.uploadContexts.set(request_id, {
        workingDir,
        attachmentDir: saved.length > 0 ? attachmentDirFor(request_id) : null,
        apiOrigin: this.apiOrigin,
        // A getter, not the current value — see UploadContext.token.
        token: () => this.token,
        maxFileBytes: this.attachmentLimits.maxFileBytes,
        signal,
      });

      // Build execution context
      const context: ExecutionContext = {
        request: effectiveRequest,
        requestId: request_id,
        tools: this.currentTools,
        mcp,
        cliIsolation: this.cliIsolation,
        workingDir,
        signal,
        requestTimeoutSeconds: this.serverConfig.request_timeout,
        cliSessionId,
        attachmentDir: saved.length > 0 ? attachmentDirFor(request_id) : null,
      };

      // The adapter emits its own `done`, but the CLI session id is only known
      // once execute() resolves. Capture the adapter's `done` data, withhold the
      // event, and re-emit `done` after — with cli_session_id attached — so the
      // server can persist the session for the next turn's resume.
      let doneData: DoneData = {};
      let sessionLost = false;
      const newCliSessionId = await adapter.execute(context, (event: AdapterStreamEvent) => {
        if (event.event === 'done') {
          doneData = event.data as DoneData;
          return;
        }
        if (event.event === 'error') {
          const errorCode = (event.data as { code?: string }).code;
          if (errorCode === 'session_lost') {
            sessionLost = true;
          }
          // A spawn failure (most often ENOENT — the CLI is no longer on PATH)
          // means the local provider set may have changed. Re-probe so the
          // server's advertised provider list self-heals without a restart.
          if (errorCode === 'provider_spawn_error') {
            void this.refreshProviders();
          }
        }
        this.sendStreamEvent(request_id, event.event, event.data);
      });

      // On session_lost the error was already forwarded and the server recovers
      // by re-issuing the turn — withhold `done` so its in-flight request stays
      // open for the re-issue.
      if (sessionLost) {
        return;
      }

      // Remember where this session runs, so a later turn that names somewhere
      // else is refused rather than resumed into the wrong checkout.
      if (newCliSessionId) {
        this.sessionWorkingDirs.remember(newCliSessionId, workingDir);
      }

      this.sendStreamEvent(request_id, 'done', {
        ...doneData,
        cli_session_id: newCliSessionId,
      });
    } finally {
      // Revoke the per-spawn MCP token so a leftover CLI process cannot
      // continue invoking tools on this request_id's behalf.
      if (mcpToken) {
        this.mcpServer.revokeToken(mcpToken);
      }
      // Drop the bridge-owned tools' view of this turn, so a CLI that outlives
      // it cannot keep uploading files against a request nobody is reading.
      this.uploadContexts.delete(request_id);
      // Attachments go on every terminal outcome — done, error and cancelled
      // alike. Cleaning up only on success would grow the cache without bound
      // precisely on the machines where things go wrong most.
      if ((request.attachments?.length ?? 0) > 0 && !this.keepAttachments) {
        try {
          removeAttachmentDir(request_id);
        } catch (err) {
          log.warn('Could not remove attachment directory', {
            requestId: request_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private handleServerError(message: { type: 'error'; code: string; message: string; fatal: boolean }): void {
    log.error('Server error', { code: message.code, message: message.message, fatal: message.fatal });
    if (message.fatal) {
      log.error('Fatal server error — disconnecting');
      this.isShuttingDown = true;
      // Stop the bridge MCP server (best-effort) before closing.
      this.mcpServer.stop().catch(() => {
        // Best-effort cleanup; ignore errors during shutdown
      });
      this.ws?.close(1000, 'Fatal server error');
    }
  }

  /**
   * Handle a connection_error message — the server rejected this connection
   * (bad / expired / revoked token, protocol mismatch, …). Always fatal: the
   * bridge stops instead of reconnecting. Setting isShuttingDown also
   * suppresses the duplicate fatal error the accompanying 4001 close frame
   * would otherwise raise in onClose().
   */
  private handleConnectionError(message: ConnectionErrorMessage): void {
    log.error('Connection rejected by server', {
      error: message.error,
      message: message.message,
    });
    this.isShuttingDown = true;
    // Best-effort cleanup before surfacing the fatal error.
    this.mcpServer.stop().catch(() => {
      // Best-effort cleanup; ignore errors during shutdown
    });
    this.emit('error', new FatalBridgeError(`Connection rejected: ${message.message}`));
  }

  /**
   * Adopt a server-issued replacement token. Bridge tokens are long-lived but
   * still expire; the server hands over a fresh one before the current token
   * ages out, so subsequent reconnects keep working without operator action.
   */
  private adoptRefreshedToken(token: string, source: string): void {
    if (!token || token === this.token) {
      return;
    }
    this.token = token;
    log.info('Adopted refreshed connection token', { source });
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping', timestamp: Date.now() });
        log.debug('Ping sent');

        // Set a 10-second timeout for the pong response; if none arrives,
        // treat the connection as dead.
        this.awaitingPong = true;
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
        }
        this.pongTimeoutTimer = setTimeout(() => {
          if (this.awaitingPong && this.isConnected()) {
            log.warn('Pong not received within 10s — connection presumed dead');
            this.ws?.close(4000, 'Pong timeout');
          }
        }, 10_000);
      }
    }, intervalMs);
    log.debug('Heartbeat started', { intervalMs });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
    this.awaitingPong = false;
  }

  // -------------------------------------------------------------------------
  // Reconnection with Exponential Backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error('Maximum reconnection attempts reached — giving up', {
        attempts: this.reconnectAttempts,
        max: MAX_RECONNECT_ATTEMPTS,
      });
      this.emit(
        'error',
        new FatalBridgeError(
          'Maximum reconnection attempts reached. Check that the server URL is correct and the server is reachable, then restart the bridge.',
        ),
      );
      return;
    }

    // Per PROTOCOL.md: 1s, 2s, 4s, 8s, 15s cap
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts++;
    log.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Message Sending
  // -------------------------------------------------------------------------

  private send(message: BridgeToServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('Cannot send message — WebSocket not open', { type: message.type });
      return;
    }

    // `JSON.stringify` throws on a circular structure or a BigInt. Nothing
    // reaching here should hold either — every field is parsed from CLI output
    // or built locally — but this runs inside a readline listener, where an
    // exception is not caught by anything and takes the process with it. A
    // frame that cannot be encoded is treated exactly like one that is too
    // large: reduced to something that can be.
    let payload: string | null = null;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      log.error('Could not encode a frame', {
        type: message.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const bytes = payload === null ? -1 : Buffer.byteLength(payload, 'utf8');

    // The one place a frame is serialised, and so the one place its size can be
    // checked once for every field rather than at each producer.
    //
    // Four review rounds of this change found four separate "field X was not
    // bounded" bugs — each a different producer, each missed the same way. The
    // per-field bounds stay, because a marked truncation is a better answer
    // than this; but a new field or a new provider cannot now silently exceed
    // the cap, and the failure is a message the server can read rather than a
    // CLOSE_TOO_BIG that tears the connection down with every in-flight request
    // on it.
    if (payload === null || bytes > MAX_FRAME_BYTES) {
      if (payload !== null) log.error('Refusing to send an oversized frame', { type: message.type, bytes });

      // A TERMINAL frame is never dropped. `done` is how the server learns the
      // turn ended; withholding it hangs the request until a timeout, which is
      // a worse outcome than the oversized frame this guard exists to prevent
      // — and reachable, because `permission_denials` carries each refused
      // call's whole input, so one denied large write is enough.
      //
      // Every fallback below goes through `trySend`, which measures. A guard
      // that replaces one oversized frame with another it never measured is
      // not a guard: `stripToEssentials` keeps `usage` and `cli_session_id`,
      // both provider-supplied and neither bounded anywhere, so the stripped
      // frame CAN still be over the cap — and then closes the connection
      // exactly as if the guard were not here.
      for (const fallback of this.fallbacksFor(message, bytes)) {
        if (this.trySend(fallback)) {
          log.warn('Sent a reduced frame in place of an oversized one', { type: message.type, bytes });

          return;
        }
      }

      // Nothing that carries the request id fits, which means the id itself is
      // the size problem. There is no frame left to send — every one would be
      // uncorrelatable or oversized — so the connection survives and the
      // request times out, which is the least bad of three bad outcomes.
      log.error('Could not reduce a frame to a sendable size', { type: message.type, bytes });

      return;
    }

    this.ws.send(payload);
    log.debug('Message sent', { type: message.type, bytes });
  }


  /**
   * Send a frame only if it fits. Returns whether it went.
   *
   * The single measuring point for everything the oversize path produces, so a
   * new fallback cannot be added without being measured.
   */
  private trySend(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      return false;
    }

    if (Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES) return false;

    this.ws.send(payload);

    return true;
  }

  /**
   * Ever-smaller stand-ins for a frame that will not fit, most informative
   * first. The last one carries nothing but the request id and a reason, so it
   * fits unless the id alone does not.
   */
  private *fallbacksFor(message: BridgeToServerMessage, bytes: number): Generator<Record<string, unknown>> {
    const stripped = this.stripToEssentials(message);
    if (stripped !== null) {
      yield stripped;

      // `usage` and `cli_session_id` are what the server acts on, so they are
      // worth one attempt — but they come from the provider, and a terminal
      // frame that cannot be sent at all costs more than either.
      //
      // `done` only: an `error` frame has neither field, and writing them in
      // would put two meaningless nulls into a frame whose shape the server
      // reads.
      if (stripped['event'] === 'done') {
        const data = (stripped['data'] ?? {}) as Record<string, unknown>;
        yield {
          ...stripped,
          data: { ...data, usage: null, cli_session_id: null },
        };
      }
    }

    const requestId = (message as { request_id?: string }).request_id;
    if (requestId === undefined) return;

    const event = (message as { event?: string }).event ?? message.type;
    yield {
      type: 'stream',
      request_id: requestId,
      event: 'error',
      data: {
        code: 'frame_too_large',
        message: bytes < 0
          ? `The bridge dropped a ${event} frame it could not encode.`
          : `The bridge dropped a ${event} frame of ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte limit.`,
      },
    };
  }

  /**
   * Reduce a terminal frame to the part the server cannot do without.
   *
   * Returns null for anything that is not terminal — those are safe to drop and
   * report, because a missing block event costs content while a missing `done`
   * costs the whole request.
   */
  private stripToEssentials(message: BridgeToServerMessage): Record<string, unknown> | null {
    const framed = message as unknown as Record<string, unknown>;
    if (framed['type'] !== 'stream') return null;

    const data = (framed['data'] ?? {}) as Record<string, unknown>;

    if (framed['event'] === 'done') {
      return {
        type: 'stream',
        request_id: framed['request_id'],
        event: 'done',
        // Usage and the session id are small and the server acts on both.
        // Everything else the provider reported is informational.
        data: {
          usage: data['usage'] ?? null,
          cli_session_id: data['cli_session_id'] ?? null,
          truncated_by_bridge: true,
        },
      };
    }

    if (framed['event'] === 'error') {
      return {
        type: 'stream',
        request_id: framed['request_id'],
        event: 'error',
        data: {
          code: data['code'] ?? 'provider_error',
          message: String(data['message'] ?? '').slice(0, 2000),
        },
      };
    }

    return null;
  }

  /**
   * Send a stream event using the correct envelope format per PROTOCOL.md:
   * { type: "stream", request_id, event: "<event_type>", data: {...} }
   */
  private sendStreamEvent(requestId: string, event: StreamEventType, data: StreamEventData): void {
    this.send({
      type: 'stream',
      request_id: requestId,
      event,
      data,
    });
  }
}
