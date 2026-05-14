/**
 * AI Bridge Protocol v0.1 — Type Definitions
 *
 * Defines all message types exchanged between the bridge (client)
 * and the server over WebSocket.
 */

// ---------------------------------------------------------------------------
// Provider & Tool Definitions
// ---------------------------------------------------------------------------

/** Describes a locally detected AI CLI provider and its capabilities. */
export interface ProviderCapability {
  /** Unique identifier for the provider (e.g. "codex", "claude", "gemini") */
  id: string;
  /** Human-readable name (e.g. "OpenAI Codex CLI") */
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
}

/** A tool definition following JSON Schema for parameters. */
export interface ToolDefinition {
  /** Unique tool name (e.g. "read_file", "web_search") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bridge -> Server Messages
// ---------------------------------------------------------------------------

/** Sent immediately after WebSocket connection is established. */
export interface HelloMessage {
  type: 'hello';
  protocol_version: string;
  bridge_version: string;
  token: string;
  providers: ProviderCapability[];
}

/** Acknowledges receipt of an ai_request and confirms processing has begun. */
export interface AiRequestAckMessage {
  type: 'ai_request_ack';
  request_id: string;
  provider_id: string;
}

/** A streaming event pushed to the server as the CLI produces output. */
export interface StreamEventMessage {
  type: 'stream_event';
  request_id: string;
  event: StreamEvent;
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

/** Union of all messages the bridge sends to the server. */
export type BridgeToServerMessage =
  | HelloMessage
  | AiRequestAckMessage
  | StreamEventMessage
  | PingMessage
  | ToolCallMessage;

// ---------------------------------------------------------------------------
// Server -> Bridge Messages
// ---------------------------------------------------------------------------

/** Server acknowledges the hello and provides configuration. */
export interface WelcomeMessage {
  type: 'welcome';
  session_id: string;
  tools: ToolDefinition[];
  config: ServerConfig;
}

/** Server-provided configuration values. */
export interface ServerConfig {
  heartbeat_interval_ms: number;
  max_reconnect_attempts: number;
  request_timeout_ms: number;
}

/** A request from the server to run an AI prompt through a local CLI. */
export interface AiRequestMessage {
  type: 'ai_request';
  request_id: string;
  provider_id: string;
  prompt: string;
  conversation_id: string | null;
  system_prompt: string | null;
  tools: ToolDefinition[];
  options: AiRequestOptions;
}

/** Options that control how the AI request is executed. */
export interface AiRequestOptions {
  max_tokens: number | null;
  temperature: number | null;
  thinking: boolean;
  session_resume_id: string | null;
}

/** Instructs the bridge to reset/clear a conversation session. */
export interface SessionResetMessage {
  type: 'session_reset';
  conversation_id: string;
}

/** Server responds with the result of a tool call. */
export interface ToolResolveMessage {
  type: 'tool_resolve';
  tool_call_id: string;
  result: unknown;
}

/** Server responds with an error for a tool call. */
export interface ToolErrorMessage {
  type: 'tool_error';
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

/** Union of all messages the server sends to the bridge. */
export type ServerToBridgeMessage =
  | WelcomeMessage
  | AiRequestMessage
  | SessionResetMessage
  | ToolResolveMessage
  | ToolErrorMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Stream Events (discriminated union on `event` field)
// ---------------------------------------------------------------------------

/** Signals the start of a new content block. */
export interface BlockStartEvent {
  event: 'block_start';
  block_id: string;
  block_type: 'text' | 'thinking' | 'tool_use';
  /** For tool_use blocks, the tool name. */
  tool_name?: string;
}

/** A delta (chunk) of content within a block. */
export interface BlockDeltaEvent {
  event: 'block_delta';
  block_id: string;
  delta: string;
}

/** Signals that a content block is complete. */
export interface BlockStopEvent {
  event: 'block_stop';
  block_id: string;
}

/** The result of a tool invocation, fed back into the model. */
export interface ToolResultEvent {
  event: 'tool_result';
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  is_error: boolean;
}

/** The entire response is complete. */
export interface DoneEvent {
  event: 'done';
  /** CLI session ID that can be used to resume later. */
  session_id: string | null;
  usage: TokenUsage | null;
}

/** An error occurred during streaming. */
export interface StreamErrorEvent {
  event: 'error';
  code: string;
  message: string;
}

/** Token usage information. */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

/** Discriminated union of all stream event types. */
export type StreamEvent =
  | BlockStartEvent
  | BlockDeltaEvent
  | BlockStopEvent
  | ToolResultEvent
  | DoneEvent
  | StreamErrorEvent;
