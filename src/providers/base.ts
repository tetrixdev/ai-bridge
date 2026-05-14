/**
 * Abstract base class for AI CLI provider adapters.
 *
 * Each adapter wraps a specific CLI tool (Codex, Claude, Gemini) and
 * normalizes its output into the Bridge protocol's stream event format.
 */

import type {
  ProviderCapability,
  ModelInfo,
  AiRequestMessage,
  ToolDefinition,
  StreamEventType,
  StreamEventData,
} from '../protocol/types.js';

/** A stream event emitted by the adapter. */
export interface AdapterStreamEvent {
  event: StreamEventType;
  data: StreamEventData;
}

/** Context passed to a provider when executing a request. */
export interface ExecutionContext {
  /** The full AI request from the server. */
  request: AiRequestMessage;
  /** Tool definitions that should be made available to the CLI. */
  tools: ToolDefinition[];
  /** Path to directory containing generated tool wrapper scripts. */
  toolScriptDir: string | null;
  /** Callback to resolve a tool call through the server. */
  onToolCall: (toolCallId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** CLI session ID if resuming, or null for new session. */
  cliSessionId: string | null;
}

export abstract class ProviderAdapter {
  /** Provider name / identifier (e.g. "codex", "claude", "gemini"). */
  abstract readonly providerName: string;

  /**
   * Detect whether this CLI is installed and return its capabilities.
   * Must not throw — returns `available: false` if not found.
   */
  abstract detect(): Promise<ProviderCapability>;

  /**
   * Execute an AI request by invoking the local CLI.
   *
   * The adapter should call `onEvent` for each streaming chunk produced
   * by the CLI, normalizing the output into stream event format.
   *
   * Must send a final `done` event when the CLI exits.
   * Returns the CLI session ID for future resumption (or null).
   *
   * @param context  Execution context with request, tools, and tool resolution callback.
   * @param onEvent  Callback for each normalized stream event.
   * @returns The CLI session ID (for session resume) or null.
   */
  abstract execute(
    context: ExecutionContext,
    onEvent: (event: AdapterStreamEvent) => void,
  ): Promise<string | null>;

  /** Whether this provider supports resuming a previous CLI session. */
  abstract supportsSessionResume(): boolean;

  /**
   * List available models for this provider.
   *
   * Returns model info from local CLI config/cache where possible,
   * or known model aliases as a fallback.
   */
  abstract listModels(): Promise<ModelInfo[]>;
}
