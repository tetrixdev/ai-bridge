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

// Large-but-finite cap (~24 min of retries with backoff); infinite retry could
// mask configuration errors.
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
// Helper: Escape XML characters in message content
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Helper: Build a synthetic AiRequestMessage from a session reset
// ---------------------------------------------------------------------------

/**
 * Construct an AiRequestMessage from a SessionResetMessage by extracting
 * the last user message and folding prior history into the system prompt
 * using XML-tagged structure to prevent prompt injection.
 *
 * Returns null if no user message is found in history.
 */
function buildSessionResetRequest(
  originalMsg: SessionResetMessage,
  currentSystemPrompt: string | null,
): AiRequestMessage | null {
  const { request_id, conversation_id, provider, history, options } = originalMsg;

  // Validate history roles — warn if unexpected values encountered
  const validRoles = new Set(['user', 'assistant', 'system']);
  const unexpectedRoles = history
    .map((h) => h.role)
    .filter((role) => !validRoles.has(role));
  if (unexpectedRoles.length > 0) {
    log.warn('Session reset history contains unexpected role values', {
      unexpectedRoles: [...new Set(unexpectedRoles)],
    });
  }

  const lastUserIdx = history.findLastIndex((h) => h.role === 'user');
  if (lastUserIdx === -1) {
    return null;
  }

  const lastUserMessage = history[lastUserIdx];

  // Build conversation context from prior history (excluding the last user message)
  const rawPriorHistory = history.slice(0, lastUserIdx);

  // Exclude entries with unexpected roles to avoid widening the injection
  // surface (an unknown role could be treated as authoritative instructions).
  const priorHistory = rawPriorHistory.filter((h) => validRoles.has(h.role));

  // Wrap history in XML tags (with escaped content) to prevent prompt injection.
  let enhancedSystemPrompt: string | null;
  if (priorHistory.length > 0) {
    const historyXml = priorHistory
      .map((h) => `<message role="${escapeXml(h.role)}">${escapeXml(h.content)}</message>`)
      .join('\n');

    const historyBlock = `<conversation_history>\n${historyXml}\n</conversation_history>`;

    // If system_prompt is null/empty, use only the history context
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
   * next welcome these are replayed as session_expired errors to release the
   * browser's loading state.
   */
  private abortedRequestIds: string[] = [];
  /** Random secret for authenticating tool callback HTTP requests. */
  private readonly callbackSecret: string;

  constructor(options: BridgeOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.providers = options.providers;
    this.adapters = options.adapters;
    this.testMode = options.testMode ?? false;
    this.onTestRequest = options.onTestRequest;

    // Generate a random secret for callback server authentication
    this.callbackSecret = crypto.randomBytes(32).toString('hex');

    // Forwards HTTP-based tool calls from scripts over the WebSocket.
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
    this.toolManager.cleanupScripts();
    await this.callbackServer.stop();
    // Persist in-memory last_used_at updates so sessions don't appear stale
    // (premature TTL expiry) after a bridge restart.
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
        // session_expired error after reconnect.
        this.abortedRequestIds.push(id);
        log.debug('Aborted active request on disconnect', { requestId: id });
      }
      this.activeRequests.clear();
    }

    this.emit('disconnected', code, reasonStr);

    if (!this.isShuttingDown) {
      // Check for authentication rejection — don't retry, exit immediately
      if (code === 4001) {
        // Clean up tool scripts and callback server before emitting fatal error
        this.toolManager.cleanupScripts();
        this.callbackServer.stop().catch(() => {
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

  private async handleWelcome(message: WelcomeMessage): Promise<void> {
    // Cancel the welcome-timeout now that we've received the welcome.
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.sessionId = message.session_id;
    this.serverConfig = message.config;

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

    // Register tools from the server
    this.toolManager.register(message.tools);

    // Update the callback server's validation set so it accepts tool calls
    // for the tools we just registered.
    this.callbackServer.setRegisteredToolNames(this.toolManager.getRegisteredNames());

    // Notify the server about any tools rejected during registration (unsafe
    // or reserved names) so it can surface a warning.
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
          // Pass the server-configured request timeout so the bash script's
          // HTTP timeout matches the bridge-side tool resolver timeout.
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
        // Notify the server so it can warn the user — all tool calls will fail
        // for this session because the callback server could not start.
        this.send({
          type: 'error',
          request_id: 'setup',
          code: 'tool_setup_failed',
          message: `Tool callback server failed to start — tool calls will not work for this session: ${err instanceof Error ? err.message : String(err)}`,
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

    // Replay any requests aborted by a previous disconnect as session_expired
    // errors now that the connection is back, so the browser exits its loading
    // state instead of waiting for the server's own timeout.
    if (this.abortedRequestIds.length > 0) {
      const replayed = this.abortedRequestIds;
      this.abortedRequestIds = [];
      for (const requestId of replayed) {
        log.info('Replaying aborted request as session_expired error', { requestId });
        this.send({
          type: 'error',
          request_id: requestId,
          code: 'session_expired',
          message: 'Request aborted: the bridge connection dropped while the response was streaming.',
          fatal: false,
        });
      }
    }
  }

  /**
   * Handle an incoming ai_request: send ack, then execute.
   */
  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id, provider, conversation_id } = message;

    // Look up existing CLI session for this conversation
    const existingCliSessionId = conversation_id
      ? this.sessionStore.get(conversation_id)
      : null;

    // If a conversation_id was provided but no session was found AND the
    // message has no system_prompt (a follow-up, not a new conversation), send
    // a session_expired error and return early.  Continuing would produce two
    // conflicting signals: an error AND a streamed response from a context-less
    // CLI session.  The server's session_reset flow recovers from this.
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

    // Send ai_request_ack with the CLI session ID (null when there is no
    // existing session).
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
   * Does NOT send ai_request_ack — the caller is responsible for that.
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
        const errMessage = err instanceof Error ? err.message : String(err);

        // A failure on a request that attempted to RESUME an existing CLI
        // session is treated as a recoverable "cannot_resume": the stored
        // session is dropped so the next turn starts fresh, and the server is
        // told it can recover by replaying history via session_reset. A
        // genuinely unrelated failure (rate limit, etc.) simply resurfaces on
        // the fresh retry, so this broad treatment is safe.
        const wasResumeAttempt = cliSessionId !== null;
        if (wasResumeAttempt && message.conversation_id) {
          this.sessionStore.delete(message.conversation_id);
        }

        log.error('Request execution failed', {
          requestId: request_id,
          resumeAttempt: wasResumeAttempt,
          error: errMessage,
        });
        this.sendStreamEvent(request_id, 'error', {
          code: wasResumeAttempt ? 'cannot_resume' : 'provider_error',
          message: wasResumeAttempt
            ? `Could not resume the existing CLI session: ${errMessage}. The session has been cleared — retry to start a fresh one.`
            : errMessage,
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

    // Wrap in try/finally to ensure the session mapping is persisted even if
    // the adapter throws after producing a session ID.
    let newCliSessionId: string | null = null;
    try {
      // Run the adapter — it returns the new CLI session ID
      newCliSessionId = await adapter.execute(context, (event: AdapterStreamEvent) => {
        this.sendStreamEvent(request_id, event.event, event.data);
      });
    } finally {
      // Store the session mapping for future resume.  Also persist
      // system_prompt so session resets can restore it even when the server
      // omits it from the session_reset message.
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
   */
  private handleSessionReset(message: SessionResetMessage): void {
    const { request_id, conversation_id } = message;

    // Retrieve the stored system prompt BEFORE deleting the session, so it can
    // be used as a fallback if the server omits system_prompt.
    const storedSystemPrompt = this.sessionStore.getSystemPrompt(conversation_id);

    // Delete the old session so the adapter starts fresh
    const deleted = this.sessionStore.delete(conversation_id);
    log.info('Session reset', { conversationId: conversation_id, found: deleted, historyLength: message.history.length });

    // Prefer the server-provided system_prompt; fall back to the stored one if
    // the server omits it.
    const effectiveSystemPrompt = message.system_prompt ?? storedSystemPrompt;
    if (!message.system_prompt && storedSystemPrompt) {
      log.warn('session_reset has no system_prompt — using stored system prompt for this conversation', {
        conversationId: conversation_id,
      });
    }

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
    this.executeAiRequestInternal(syntheticRequest);
  }

  private handleServerError(message: { type: 'error'; code: string; message: string; fatal: boolean }): void {
    log.error('Server error', { code: message.code, message: message.message, fatal: message.fatal });
    if (message.fatal) {
      log.error('Fatal server error — disconnecting');
      this.isShuttingDown = true;
      // Clean up tool scripts and callback server (best-effort) before closing.
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
