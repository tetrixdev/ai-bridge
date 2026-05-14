/**
 * Abstract base class for AI CLI provider adapters.
 *
 * Each adapter wraps a specific CLI tool (Codex, Claude, Gemini) and
 * normalizes its output into the Bridge protocol's StreamEvent format.
 */

import type {
  ProviderCapability,
  StreamEvent,
  AiRequestMessage,
  ToolDefinition,
} from '../protocol/types.js';

/** Context passed to a provider when executing a request. */
export interface ExecutionContext {
  /** The full AI request from the server. */
  request: AiRequestMessage;
  /** Tool definitions that should be made available to the CLI. */
  tools: ToolDefinition[];
  /** Callback to resolve a tool call through the server. */
  onToolCall: (toolCallId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
}

export abstract class ProviderAdapter {
  /** Unique provider identifier (e.g. "codex", "claude", "gemini"). */
  abstract readonly id: string;

  /** Human-readable display name. */
  abstract readonly name: string;

  /**
   * Detect whether this CLI is installed and return its capabilities.
   * Must not throw — returns `available: false` if not found.
   */
  abstract detect(): Promise<ProviderCapability>;

  /**
   * Execute an AI request by invoking the local CLI.
   *
   * The adapter should call `onEvent` for each streaming chunk produced
   * by the CLI, normalizing the output into StreamEvent format.
   *
   * Must send a final `done` event when the CLI exits.
   *
   * @param context  Execution context with request, tools, and tool resolution callback.
   * @param onEvent  Callback for each normalized stream event.
   */
  abstract execute(
    context: ExecutionContext,
    onEvent: (event: StreamEvent) => void,
  ): Promise<void>;

  /** Whether this provider supports resuming a previous CLI session. */
  abstract supportsSessionResume(): boolean;
}
