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
}

/** A tool definition following JSON Schema for parameters. */
export interface ToolDefinition {
  /** Unique tool name (e.g. "roll_dice", "web_search") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  parameters: Record<string, unknown>;
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
}

/** Acknowledges receipt of an ai_request and confirms processing has begun. */
export interface AiRequestAckMessage {
  type: 'ai_request_ack';
  request_id: string;
  cli_session_id: string;
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
  recoverable: boolean;
}

/** Union of all messages the bridge sends to the server. */
export type BridgeToServerMessage =
  | HelloMessage
  | AiRequestAckMessage
  | StreamMessage
  | PingMessage
  | ToolCallMessage
  | BridgeErrorMessage;

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
  /** Heartbeat interval in SECONDS (not milliseconds). */
  heartbeat_interval: number;
  /** Maximum seconds for a single AI request. */
  request_timeout: number;
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
}

/** Options that control how the AI request is executed. */
export interface AiRequestOptions {
  max_tokens: number | null;
  temperature: number | null;
}

/** Instructs the bridge to reset/clear a conversation session. */
export interface SessionResetMessage {
  type: 'session_reset';
  request_id: string;
  conversation_id: string;
  provider: string;
  system_prompt: string | null;
  history: Array<{ role: string; content: string }>;
  options: AiRequestOptions;
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
// Stream Event Types and Data
// ---------------------------------------------------------------------------

/** The event type names used inside stream envelopes. */
export type StreamEventType =
  | 'block_start'
  | 'block_delta'
  | 'block_stop'
  | 'tool_result'
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
export interface ToolResultData {
  tool_call_id: string;
  result: string;
}

/** Data payload for done events. */
export interface DoneData {
  usage?: TokenUsage;
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
}

/** Union of all stream event data payloads. */
export type StreamEventData =
  | BlockStartData
  | BlockDeltaData
  | BlockStopData
  | ToolResultData
  | DoneData
  | StreamErrorData;
