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
  ModelInfo,
  BridgeToServerMessage,
  ServerToBridgeMessage,
  AiRequestMessage,
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
const MAX_RECONNECT_ATTEMPTS = 10;
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
  private readonly callbackServer = new ToolCallbackServer(this.toolResolver);
  private readonly testMode: boolean;
  private readonly onTestRequest?: BridgeOptions['onTestRequest'];

  private sessionId: string | null = null;
  private serverConfig: ServerConfig = {
    heartbeat_interval: DEFAULT_HEARTBEAT_SECONDS,
    request_timeout: DEFAULT_REQUEST_TIMEOUT_SECONDS,
  };

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private activeRequests = new Map<string, AbortController>();

  constructor(options: BridgeOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.providers = options.providers;
    this.adapters = options.adapters;
    this.testMode = options.testMode ?? false;
    this.onTestRequest = options.onTestRequest;
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initiate the WebSocket connection to the server.
   * Token is placed in the URL query parameter per PROTOCOL.md.
   */
  connect(): void {
    if (this.ws) {
      log.warn('connect() called while already connected — ignoring');
      return;
    }

    // Append token as query parameter
    const url = new URL(this.serverUrl);
    url.searchParams.set('token', this.token);
    const wsUrl = url.toString();

    log.info('Connecting to server', { url: this.serverUrl });

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': `ai-bridge/${BRIDGE_VERSION}`,
      },
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
    this.ws = null;
    this.emit('disconnected', code, reasonStr);

    if (!this.isShuttingDown) {
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
  }

  private async handleWelcome(message: {
    type: 'welcome';
    session_id: string;
    tools: ToolDefinition[];
    config: ServerConfig;
  }): Promise<void> {
    this.sessionId = message.session_id;
    this.serverConfig = message.config;

    // Register tools from the server
    this.toolManager.register(message.tools);

    // Generate tool wrapper scripts and start the callback server
    if (message.tools.length > 0) {
      try {
        await this.callbackServer.start();
        const port = this.callbackServer.getPort();
        if (port) {
          this.toolManager.generateScripts(port);
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
      }
    }

    // Start heartbeat — config.heartbeat_interval is in SECONDS
    const intervalMs = message.config.heartbeat_interval * 1000;
    this.startHeartbeat(intervalMs);

    log.info('Welcome received', {
      sessionId: this.sessionId,
      toolCount: message.tools.length,
      heartbeatSeconds: message.config.heartbeat_interval,
    });

    this.emit('welcome', this.sessionId);
  }

  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id, provider, conversation_id } = message;

    // Look up existing CLI session for this conversation
    const existingCliSessionId = conversation_id
      ? this.sessionStore.get(conversation_id)
      : null;

    // Send ai_request_ack with the CLI session ID
    this.send({
      type: 'ai_request_ack',
      request_id,
      cli_session_id: existingCliSessionId ?? 'new',
    });

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
      // Send non-streaming error
      this.send({
        type: 'error',
        request_id,
        code: 'provider_unavailable',
        message: `Provider "${provider}" is not available on this bridge`,
        recoverable: false,
      });
      return;
    }

    this.emit('request_start', request_id, provider);

    // Execute asynchronously
    const controller = new AbortController();
    this.activeRequests.set(request_id, controller);

    this.executeRequest(adapter, message, existingCliSessionId, controller.signal)
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

    // Build execution context
    const context: ExecutionContext = {
      request,
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

    // Run the adapter — it returns the new CLI session ID
    const newCliSessionId = await adapter.execute(context, (event: AdapterStreamEvent) => {
      this.sendStreamEvent(request_id, event.event, event.data);
    });

    // Store the session mapping for future resume
    if (newCliSessionId && conversation_id) {
      this.sessionStore.set(conversation_id, newCliSessionId, adapter.providerName);
    }
  }

  private handleSessionReset(message: {
    type: 'session_reset';
    request_id: string;
    conversation_id: string;
    provider: string;
    system_prompt: string | null;
    history: Array<{ role: string; content: string }>;
    options: { max_tokens: number | null; temperature: number | null };
  }): void {
    // Delete the old session
    const deleted = this.sessionStore.delete(message.conversation_id);
    log.info('Session reset', { conversationId: message.conversation_id, found: deleted });

    // Per PROTOCOL.md, a session_reset creates a new CLI session and replays history.
    // We treat this like a new ai_request with the last user message from history.
    // The adapter will get a null cliSessionId and start fresh.
  }

  private handleServerError(message: { type: 'error'; code: string; message: string; fatal: boolean }): void {
    log.error('Server error', { code: message.code, message: message.message, fatal: message.fatal });
    if (message.fatal) {
      log.error('Fatal server error — disconnecting');
      this.isShuttingDown = true;
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
      }
    }, intervalMs);
    log.debug('Heartbeat started', { intervalMs });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
      this.emit('error', new Error('Maximum reconnection attempts reached'));
      return;
    }

    // Per PROTOCOL.md: 1s, 2s, 4s, 8s, 15s cap
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts++;
    log.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

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
