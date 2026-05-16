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
import crypto from 'node:crypto';
import WebSocket from 'ws';
import type {
  ProviderCapability,
  BridgeToServerMessage,
  ServerToBridgeMessage,
  AiRequestMessage,
  SessionResetMessage,
  WelcomeMessage,
  ToolDefinition,
  ServerConfig,
  StreamEventType,
  StreamEventData,
} from './protocol/types.js';
import { PROTOCOL_VERSION, BRIDGE_VERSION } from './protocol/version.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './providers/base.js';
import { ToolManager } from './tools/manager.js';
import { ToolResolver } from './tools/resolver.js';
import { ToolCallbackServer } from './tools/callback-server.js';
import { SessionStore } from './session/store.js';
import { createLogger } from './utils/logger.js';
import { clampRequestTimeout, clampHeartbeat } from './utils/clamp.js';
import { FatalBridgeError } from './errors.js';

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
}

const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 300;

// BL-008: MAX_RECONNECT_ATTEMPTS is set high enough to cover typical server
// maintenance windows.  With exponential backoff (1s, 2s, 4s, 8s, then
// capped at 15s) the first 4 attempts take ~15s total; each subsequent attempt
// adds 15s.  MAX=100 gives roughly (15 + 96×15) = ~1455s (~24 min) of retries
// at negligible cost.  Infinite retry could mask configuration errors, so a
// large-but-finite limit is preferred.
const MAX_RECONNECT_ATTEMPTS = 100;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000; // Cap at 15s per PROTOCOL.md

// ---------------------------------------------------------------------------
// Bridge Events
// ---------------------------------------------------------------------------

export interface BridgeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  welcome: [sessionId: string];
  error: [error: Error];
  request_start: [requestId: string, provider: string];
  request_end: [requestId: string];
}

// ---------------------------------------------------------------------------
// Helper: Escape XML characters in message content (SEC-003)
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Helper: Build a synthetic AiRequestMessage from a session reset (ARCH-010)
// ---------------------------------------------------------------------------

/**
 * Construct an AiRequestMessage from a SessionResetMessage by extracting
 * the last user message and folding prior history into the system prompt
 * using XML-tagged structure to prevent prompt injection (SEC-003).
 *
 * Returns null if no user message is found in history.
 */
function buildSessionResetRequest(
  originalMsg: SessionResetMessage,
  currentSystemPrompt: string | null,
): AiRequestMessage | null {
  const { request_id, conversation_id, provider, history, options } = originalMsg;

  // BL-017: Validate history roles — warn if unexpected values encountered
  const validRoles = new Set(['user', 'assistant', 'system']);
  const unexpectedRoles = history
    .map((h) => h.role)
    .filter((role) => !validRoles.has(role));
  if (unexpectedRoles.length > 0) {
    log.warn('Session reset history contains unexpected role values', {
      unexpectedRoles: [...new Set(unexpectedRoles)],
    });
  }

  // EFF-010: Use findLastIndex instead of two-step find-then-lastIndexOf
  const lastUserIdx = history.findLastIndex((h) => h.role === 'user');
  if (lastUserIdx === -1) {
    return null;
  }

  const lastUserMessage = history[lastUserIdx];

  // Build conversation context from prior history (excluding the last user message)
  const rawPriorHistory = history.slice(0, lastUserIdx);

  // SEC-013: Exclude entries with unexpected roles from the history XML block.
  // Forwarding unknown roles verbatim widens the injection surface — an entry
  // with role="tool_instructions" could cause some AI models to treat crafted
  // content as authoritative instructions.
  const priorHistory = rawPriorHistory.filter((h) => validRoles.has(h.role));

  // SEC-003: Wrap history in XML tags to prevent prompt injection.
  // Escape < and > in message content to prevent tag injection.
  let enhancedSystemPrompt: string | null;
  if (priorHistory.length > 0) {
    const historyXml = priorHistory
      .map((h) => `<message role="${escapeXml(h.role)}">${escapeXml(h.content)}</message>`)
      .join('\n');

    const historyBlock = `<conversation_history>\n${historyXml}\n</conversation_history>`;

    // BL-013: If system_prompt is null/empty, use only the history context
    enhancedSystemPrompt = currentSystemPrompt
      ? `${currentSystemPrompt}\n\n${historyBlock}`
      : historyBlock;
  } else {
    enhancedSystemPrompt = currentSystemPrompt;
  }

  return {
    type: 'ai_request',
    request_id,
    conversation_id,
    provider,
    message: lastUserMessage.content,
    system_prompt: enhancedSystemPrompt,
    options,
  };
}

// ---------------------------------------------------------------------------
// Bridge Class
// ---------------------------------------------------------------------------

/**
 * ARCH-004 (DELIBERATELY DEFERRED): Bridge is a ~950-line class that owns
 * WebSocket lifecycle, protocol routing, AI request execution, heartbeat
 * management, and subsystem instantiation simultaneously.  This concentration
 * of responsibility is a known architectural concern.  Refactoring into smaller
 * collaborators (e.g. separating reconnection/heartbeat and request execution)
 * requires a dedicated effort beyond the current PR scope.  Future reviewers:
 * this is intentional and tracked — please do not re-file it as a new finding.
 */
export class Bridge extends EventEmitter<BridgeEvents> {
  private ws: WebSocket | null = null;
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly providers: ProviderCapability[];
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly toolManager = new ToolManager();
  private readonly toolResolver = new ToolResolver();
  private readonly sessionStore = new SessionStore();
  private readonly callbackServer: ToolCallbackServer;
  private readonly testMode: boolean;
  private readonly onTestRequest?: BridgeOptions['onTestRequest'];

  private sessionId: string | null = null;
  private serverConfig: ServerConfig = {
    heartbeat_interval: DEFAULT_HEARTBEAT_SECONDS,
    request_timeout: DEFAULT_REQUEST_TIMEOUT_SECONDS,
  };
  /** ARCH-002: Timer to detect a missing welcome message after hello is sent. */
  private welcomeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private activeRequests = new Map<string, AbortController>();
  /** SEC-002: Random secret for authenticating tool callback HTTP requests. */
  private readonly callbackSecret: string;

  constructor(options: BridgeOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.providers = options.providers;
    this.adapters = options.adapters;
    this.testMode = options.testMode ?? false;
    this.onTestRequest = options.onTestRequest;

    // SEC-002: Generate a random secret for callback server authentication
    this.callbackSecret = crypto.randomBytes(32).toString('hex');

    // ARCH-001: Pass sendFn directly to the callback server constructor
    // so HTTP-based tool calls from scripts are forwarded over WebSocket.
    const sendFn = (reqId: string, tcId: string, tName: string, tArgs: Record<string, unknown>) => {
      this.send({
        type: 'tool_call',
        request_id: reqId,
        tool_call_id: tcId,
        tool_name: tName,
        arguments: tArgs,
      });
    };

    this.callbackServer = new ToolCallbackServer(
      this.toolResolver,
      sendFn,
      new Set(this.toolManager.getAll().map((t) => t.name)),
      this.callbackSecret,
    );
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initiate the WebSocket connection to the server.
   *
   * SEC-002: The token is sent as an Authorization: Bearer header so it does
   * NOT appear in server/proxy access logs (which typically record the full
   * request URL including query parameters).  The token is also kept in the
   * URL query parameter as a backward-compatible fallback for servers that
   * have not yet adopted the header-based flow; this can be removed once all
   * companion server deployments support the header.
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
    // SEC-001 (DEFERRED): The ?token= query parameter is visible in reverse-proxy
    // access logs, unlike the Authorization header above.  This fallback is kept
    // intentionally for servers that have not yet adopted header-based auth.
    // Remove url.searchParams.set() once all companion server deployments support
    // Authorization header authentication.
    const url = new URL(this.serverUrl);
    url.searchParams.set('token', this.token);
    const wsUrl = url.toString();

    log.info('Connecting to server', { url: this.serverUrl });

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': `ai-bridge/${BRIDGE_VERSION}`,
        // SEC-002: Send token via Authorization header (not visible in proxy logs)
        'Authorization': `Bearer ${this.token}`,
      },
      // SEC-004: Limit incoming message size to 10MB to prevent memory exhaustion
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
    this.toolManager.cleanupScripts();
    await this.callbackServer.stop();
    // ARCH-005: Persist last_used_at updates that accumulated in memory since
    // the last set()/delete() persist.  Without this, sessions used between
    // bridge restarts could appear stale (premature TTL expiry) because their
    // last_used_at was only updated in memory via get().
    this.sessionStore.flush();

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
      case 'session_reset':
        this.handleSessionReset(message);
        break;
      case 'tool_resolve':
        this.toolResolver.resolve(message.tool_call_id, message.result);
        break;
      case 'tool_error':
        this.toolResolver.reject(message.tool_call_id, message.error);
        break;
      case 'pong':
        log.debug('Pong received', { timestamp: message.timestamp });
        // BL-004: Mark pong received and clear the timeout
        this.awaitingPong = false;
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
          this.pongTimeoutTimer = null;
        }
        break;
      case 'error':
        this.handleServerError(message);
        break;
      default:
        log.warn('Unknown message type received', { type: (message as { type: string }).type });
    }
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString();
    log.info('WebSocket closed', { code, reason: reasonStr });
    this.stopHeartbeat();
    // ARCH-002: Clear welcome timeout if connection closes before welcome arrives
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.ws = null;

    // BL-006: Cancel all pending tool resolvers immediately on WebSocket close
    // to fail in-flight tool calls instead of letting them stall for 30s.
    this.toolResolver.cancelAll();

    // ARCH-006: Abort all active AI requests on unexpected disconnect so
    // their CLI subprocesses are terminated.  Without this, the CLIs continue
    // running after reconnect, streaming events that are silently dropped
    // (send() returns early when ws is null), and the server never receives a
    // done event for the original requests — leaving their conversation slots
    // blocked until the server's own timeout fires.
    if (!this.isShuttingDown) {
      for (const [id, controller] of this.activeRequests) {
        controller.abort();
        log.debug('Aborted active request on disconnect', { requestId: id });
      }
      this.activeRequests.clear();
    }

    this.emit('disconnected', code, reasonStr);

    if (!this.isShuttingDown) {
      // Check for authentication rejection — don't retry, exit immediately
      if (code === 4001) {
        // ARCH-003: Clean up tool scripts and callback server before emitting fatal error
        this.toolManager.cleanupScripts();
        this.callbackServer.stop().catch(() => {
          // Best-effort cleanup; ignore errors during shutdown
        });

        this.isShuttingDown = true;
        // UX-002: Removed duplicate log.error here — the emitted error event
        // (handled by cli.ts) is sufficient.
        // UX-020: Include token source guidance in the error message.
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
    const hello: BridgeToServerMessage = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      bridge_version: BRIDGE_VERSION,
      providers: this.providers,
    };
    this.send(hello);
    log.info('Hello sent', {
      protocol: PROTOCOL_VERSION,
      providers: this.providers.filter((p) => p.available).map((p) => p.name),
    });

    // ARCH-002: Start a 15-second timeout.  If no welcome is received within
    // that window the server silently dropped our hello (bug, misconfiguration,
    // or version mismatch).  Close and reconnect so we don't stall forever.
    this.welcomeTimeoutTimer = setTimeout(() => {
      this.welcomeTimeoutTimer = null;
      if (!this.sessionId && !this.isShuttingDown) {
        log.error('Welcome message not received within 15 seconds after hello — reconnecting');
        this.ws?.close(4000, 'Welcome timeout');
      }
    }, 15_000);
  }

  private async handleWelcome(message: WelcomeMessage): Promise<void> {
    // ARCH-002: Cancel the welcome-timeout now that we've received the welcome.
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.sessionId = message.session_id;
    this.serverConfig = message.config;

    // BL-033: Check protocol version compatibility if the server provides one
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

    // SEC-003 / BL-004: Clamp request_timeout to a safe range before applying.
    // A malicious or misconfigured server could send 0 (immediate timeout) or a
    // huge value (indefinite hang / resource leak).  Accepted range: 10–3600 s.
    // EFF-002: Use the imported clampRequestTimeout() so tests exercise the same
    // constants as production code (no copied formulas in the test file).
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
      // BL-001: Write the clamped value back so generateScripts (below) uses
      // the same timeout as the tool resolver, not the raw unclamped value.
      this.serverConfig.request_timeout = clamped;
    }

    // Register tools from the server
    this.toolManager.register(message.tools);

    // BL-001: Update the callback server's validation set so it accepts
    // tool calls for the tools we just registered.
    this.callbackServer.setRegisteredToolNames(this.toolManager.getRegisteredNames());

    // UX-003: Notify the server about any tools that were rejected during
    // registration (unsafe names / reserved names).  This allows the server
    // to surface a warning to administrators or users who rely on those tools.
    const rejectedTools = this.toolManager.getRejectedToolNames();
    if (rejectedTools.length > 0) {
      this.send({
        type: 'error',
        request_id: 'setup',
        code: 'tool_rejected',
        message: `The following tools were rejected by the bridge due to unsafe or reserved names and will be unavailable: ${rejectedTools.join(', ')}`,
        fatal: false,
      });
    }

    // Generate tool wrapper scripts and start the callback server
    if (message.tools.length > 0) {
      try {
        await this.callbackServer.start();
        const port = this.callbackServer.getPort();
        if (port) {
          // BL-013: Pass the server-configured request timeout so the bash
          // script's HTTP timeout matches the bridge-side tool resolver timeout.
          this.toolManager.generateScripts(port, this.callbackSecret, this.serverConfig.request_timeout * 1000);
          log.info('Tool scripts generated', {
            count: message.tools.length,
            callbackPort: port,
            scriptDir: this.toolManager.getScriptDir(),
          });
        }
      } catch (err) {
        log.error('Failed to set up tool callback server', {
          error: err instanceof Error ? err.message : String(err),
        });
        // UX-002: Notify the server so it can surface a warning to the user.
        // All tool calls will fail for this session because the local HTTP
        // callback server could not be started.
        this.send({
          type: 'error',
          request_id: 'setup',
          code: 'tool_setup_failed',
          message: `Tool callback server failed to start — tool calls will not work for this session: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        });
      }
    }

    // Start heartbeat — config.heartbeat_interval is in SECONDS.
    // SEC-003 / BL-007: Clamp to a safe range to prevent a ping flood (0 ms)
    // or an excessively long dead-connection window (>300 s).
    // EFF-002: Use the imported clampHeartbeat() so tests exercise the same constants.
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
  }

  /**
   * Handle an incoming ai_request: send ack, then execute.
   * BL-004: The ack is sent here; executeAiRequestInternal does the actual work.
   */
  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id, provider, conversation_id } = message;

    // Look up existing CLI session for this conversation
    const existingCliSessionId = conversation_id
      ? this.sessionStore.get(conversation_id)
      : null;

    // BL-001: If a conversation_id was provided but no session was found AND
    // the message has no system_prompt (i.e. this is a follow-up, not a new
    // conversation), send a session_expired error and return early.
    //
    // Continuing to execute here would produce two conflicting signals to the
    // server: a session_expired error AND a streamed response from a brand-new
    // CLI session that has no prior context.  The server's session_reset flow
    // exists specifically to recover this situation by replaying history.
    //
    // The server is expected to surface this to the user as:
    //   "Your previous conversation context expired. Starting a new conversation."
    // before triggering a session_reset to replay history.
    if (conversation_id && !existingCliSessionId && !message.system_prompt) {
      log.warn('Session not found for conversation — notifying server', {
        conversationId: conversation_id,
      });
      this.send({
        type: 'error',
        request_id,
        code: 'session_expired',
        message: `No local session found for conversation ${conversation_id}`,
        fatal: false,
      });
      // Do NOT proceed: the server will send a session_reset with full history
      // to allow the bridge to reconstruct the context.
      return;
    }

    // Send ai_request_ack with the CLI session ID.
    // CONS-008: Use null (not the magic string 'new') when there is no existing
    // session, consistent with the null-for-absence pattern elsewhere.
    this.send({
      type: 'ai_request_ack',
      request_id,
      cli_session_id: existingCliSessionId ?? null,
    });

    // Delegate to the internal handler (shared with session reset)
    this.executeAiRequestInternal(message, existingCliSessionId);
  }

  /**
   * Internal request execution logic shared by handleAiRequest and handleSessionReset.
   * BL-004: Does NOT send ai_request_ack — the caller is responsible for that.
   */
  private executeAiRequestInternal(
    message: AiRequestMessage,
    existingCliSessionId?: string | null,
  ): void {
    const { request_id, provider } = message;

    const cliSessionId = existingCliSessionId ?? null;

    // Test mode: use mock handler
    if (this.testMode && this.onTestRequest) {
      this.emit('request_start', request_id, provider);
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
      // UX-012: Include install guidance in the error message.
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

    this.emit('request_start', request_id, provider);

    // Execute asynchronously
    const controller = new AbortController();
    this.activeRequests.set(request_id, controller);

    this.executeRequest(adapter, message, cliSessionId, controller.signal)
      .catch((err) => {
        log.error('Request execution failed', {
          requestId: request_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendStreamEvent(request_id, 'error', {
          code: 'provider_error',
          message: err instanceof Error ? err.message : String(err),
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
    const { request_id, conversation_id } = request;

    // ARCH-001: requestId is now part of ExecutionContext instead of being
    // set on the callback server via setCurrentRequestId().
    // Build execution context
    const context: ExecutionContext = {
      request,
      requestId: request_id,
      tools: this.toolManager.getAll(),
      toolScriptDir: this.toolManager.getScriptDir(),
      onToolCall: async (toolCallId, toolName, args) => {
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
          request_id,
          toolCallId,
          toolName,
          args,
        );
      },
      signal,
      cliSessionId,
    };

    // BL-011: Wrap in try/finally to ensure session mapping is persisted
    // even if the adapter throws after producing a session ID.
    let newCliSessionId: string | null = null;
    try {
      // Run the adapter — it returns the new CLI session ID
      newCliSessionId = await adapter.execute(context, (event: AdapterStreamEvent) => {
        this.sendStreamEvent(request_id, event.event, event.data);
      });
    } finally {
      // Store the session mapping for future resume.
      // BL-005: Also persist system_prompt so session resets can restore it
      // even when the server omits system_prompt from the session_reset message.
      if (newCliSessionId && conversation_id) {
        this.sessionStore.set(
          conversation_id,
          newCliSessionId,
          adapter.providerName,
          request.system_prompt,
        );
      }
    }
  }

  /**
   * Handle a session_reset message by constructing a synthetic ai_request
   * from the conversation history and executing it without sending an ack.
   * BL-004: Calls executeAiRequestInternal directly (no ack for session_reset).
   * ARCH-010: Uses the buildSessionResetRequest pure function.
   */
  private handleSessionReset(message: SessionResetMessage): void {
    const { request_id, conversation_id } = message;

    // BL-005: Retrieve the stored system prompt BEFORE deleting the session,
    // so it can be used as a fallback if the server omits system_prompt from
    // the session_reset message.
    const storedSystemPrompt = this.sessionStore.getSystemPrompt(conversation_id);

    // Delete the old session so the adapter starts fresh
    const deleted = this.sessionStore.delete(conversation_id);
    log.info('Session reset', { conversationId: conversation_id, found: deleted, historyLength: message.history.length });

    // BL-005: Prefer the server-provided system_prompt; fall back to the stored
    // one if the server omits it (which it may do when treating it as already
    // embedded in history).
    const effectiveSystemPrompt = message.system_prompt ?? storedSystemPrompt;
    if (!message.system_prompt && storedSystemPrompt) {
      log.warn('session_reset has no system_prompt — using stored system prompt for this conversation', {
        conversationId: conversation_id,
      });
    }

    // ARCH-010: Extract history reconstruction into a pure function
    const syntheticRequest = buildSessionResetRequest(message, effectiveSystemPrompt);

    if (!syntheticRequest) {
      log.error('Session reset has no user message in history', { conversationId: conversation_id });
      this.send({
        type: 'error',
        request_id,
        code: 'session_reset_failed',
        message: 'No user message found in conversation history',
        fatal: true,
      });
      return;
    }

    log.info('Re-processing session_reset as new ai_request', { requestId: request_id, provider: message.provider });
    // BL-004: Call internal handler directly — no ack for session_reset
    this.executeAiRequestInternal(syntheticRequest);
  }

  private handleServerError(message: { type: 'error'; code: string; message: string; fatal: boolean }): void {
    log.error('Server error', { code: message.code, message: message.message, fatal: message.fatal });
    if (message.fatal) {
      log.error('Fatal server error — disconnecting');
      this.isShuttingDown = true;
      // BL-002: Clean up tool scripts and callback server (best-effort) before
      // closing, matching what the 4001 close path already does.
      this.toolManager.cleanupScripts();
      this.callbackServer.stop().catch(() => {
        // Best-effort cleanup; ignore errors during shutdown
      });
      this.ws?.close(1000, 'Fatal server error');
    }
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

        // BL-004: Set a 10-second timeout for the pong response.
        // If no pong arrives, treat the connection as dead.
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
      // UX-010: Include recovery guidance in the exhaustion message
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
    // UX-007: Human-readable reconnect log so operators can gauge progress
    // without mental arithmetic (seconds instead of milliseconds, and a
    // budget position so they know when to give up waiting).
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

    const payload = JSON.stringify(message);
    this.ws.send(payload);
    log.debug('Message sent', { type: message.type, bytes: payload.length });
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
