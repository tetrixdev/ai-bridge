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
 *   - Heartbeat (ping/pong)
 *   - Lifecycle event emission
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  ProviderCapability,
  BridgeToServerMessage,
  ServerToBridgeMessage,
  AiRequestMessage,
  StreamEvent,
  ToolDefinition,
  ServerConfig,
} from './protocol/types.js';
import { PROTOCOL_VERSION, BRIDGE_VERSION } from './protocol/version.js';
import { ProviderAdapter, type ExecutionContext } from './providers/base.js';
import { ToolManager } from './tools/manager.js';
import { ToolResolver } from './tools/resolver.js';
import { SessionStore } from './session/store.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('Bridge');

// ---------------------------------------------------------------------------
// Configuration & Defaults
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** WebSocket server URL (wss://...) */
  serverUrl: string;
  /** Authentication token */
  token: string;
  /** Detected provider capabilities */
  providers: ProviderCapability[];
  /** Provider adapter instances, keyed by provider id */
  adapters: Map<string, ProviderAdapter>;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_RECONNECT = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// ---------------------------------------------------------------------------
// Bridge Events
// ---------------------------------------------------------------------------

export interface BridgeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  welcome: [sessionId: string];
  error: [error: Error];
  request_start: [requestId: string, providerId: string];
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

  private sessionId: string | null = null;
  private serverConfig: ServerConfig = {
    heartbeat_interval_ms: DEFAULT_HEARTBEAT_MS,
    max_reconnect_attempts: DEFAULT_MAX_RECONNECT,
    request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
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
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initiate the WebSocket connection to the server.
   */
  connect(): void {
    if (this.ws) {
      log.warn('connect() called while already connected — ignoring');
      return;
    }

    log.info('Connecting to server', { url: this.serverUrl });

    this.ws = new WebSocket(this.serverUrl, {
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

  private sendHello(): void {
    const hello: BridgeToServerMessage = {
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      bridge_version: BRIDGE_VERSION,
      token: this.token,
      providers: this.providers,
    };
    this.send(hello);
    log.info('Hello sent', {
      protocol: PROTOCOL_VERSION,
      providers: this.providers.filter((p) => p.available).map((p) => p.id),
    });
  }

  private handleWelcome(message: { type: 'welcome'; session_id: string; tools: ToolDefinition[]; config: ServerConfig }): void {
    this.sessionId = message.session_id;
    this.serverConfig = message.config;

    // Register tools from the server
    this.toolManager.register(message.tools);

    // Start heartbeat with server-configured interval
    this.startHeartbeat(message.config.heartbeat_interval_ms);

    log.info('Welcome received', {
      sessionId: this.sessionId,
      toolCount: message.tools.length,
      heartbeatMs: message.config.heartbeat_interval_ms,
    });

    this.emit('welcome', this.sessionId);
  }

  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id, provider_id } = message;

    // Find the adapter for the requested provider
    const adapter = this.adapters.get(provider_id);
    if (!adapter) {
      log.error('No adapter for requested provider', { provider_id });
      this.sendStreamEvent(request_id, {
        event: 'error',
        code: 'PROVIDER_NOT_AVAILABLE',
        message: `Provider "${provider_id}" is not available on this bridge`,
      });
      this.sendStreamEvent(request_id, {
        event: 'done',
        session_id: null,
        usage: null,
      });
      return;
    }

    // ACK the request
    this.send({
      type: 'ai_request_ack',
      request_id,
      provider_id,
    });

    this.emit('request_start', request_id, provider_id);

    // Execute asynchronously
    const controller = new AbortController();
    this.activeRequests.set(request_id, controller);

    this.executeRequest(adapter, message, controller.signal)
      .catch((err) => {
        log.error('Request execution failed', {
          requestId: request_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendStreamEvent(request_id, {
          event: 'error',
          code: 'EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
        this.sendStreamEvent(request_id, {
          event: 'done',
          session_id: null,
          usage: null,
        });
      })
      .finally(() => {
        this.activeRequests.delete(request_id);
        this.emit('request_end', request_id);
      });
  }

  private async executeRequest(
    adapter: ProviderAdapter,
    request: AiRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const { request_id, conversation_id } = request;

    // Build execution context
    const context: ExecutionContext = {
      request,
      tools: this.toolManager.getAll(),
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
    };

    // If the provider supports session resume and we have a stored session,
    // inject it into the request options.
    if (conversation_id && adapter.supportsSessionResume()) {
      const cliSessionId = this.sessionStore.get(conversation_id);
      if (cliSessionId) {
        request.options.session_resume_id = cliSessionId;
        log.debug('Resuming CLI session', { conversationId: conversation_id, cliSessionId });
      }
    }

    // Run the adapter
    await adapter.execute(context, (event: StreamEvent) => {
      this.sendStreamEvent(request_id, event);

      // If the provider reported a session ID, store it for later resumption
      if (event.event === 'done' && event.session_id && conversation_id) {
        this.sessionStore.set(conversation_id, event.session_id, adapter.id);
      }
    });
  }

  private handleSessionReset(message: { type: 'session_reset'; conversation_id: string }): void {
    const deleted = this.sessionStore.delete(message.conversation_id);
    log.info('Session reset', { conversationId: message.conversation_id, found: deleted });
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
    if (this.reconnectAttempts >= this.serverConfig.max_reconnect_attempts) {
      log.error('Maximum reconnection attempts reached — giving up', {
        attempts: this.reconnectAttempts,
        max: this.serverConfig.max_reconnect_attempts,
      });
      this.emit('error', new Error('Maximum reconnection attempts reached'));
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    // Add jitter: +/- 25%
    const jitter = delay * (0.75 + Math.random() * 0.5);
    const delayWithJitter = Math.round(jitter);

    this.reconnectAttempts++;
    log.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delayWithJitter,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayWithJitter);
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

  private sendStreamEvent(requestId: string, event: StreamEvent): void {
    this.send({
      type: 'stream_event',
      request_id: requestId,
      event,
    });
  }
}
