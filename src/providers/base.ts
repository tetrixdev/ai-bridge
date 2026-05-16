/**
 * Abstract base class for AI CLI provider adapters.
 *
 * Each adapter wraps a specific CLI tool (Codex, Claude, Gemini) and
 * normalizes its output into the Bridge protocol's stream event format.
 */

import { ChildProcess } from 'node:child_process';
import { Interface as ReadlineInterface } from 'node:readline';
import type {
  ModelInfo,
  AiRequestMessage,
  ToolDefinition,
  StreamEventType,
  StreamEventData,
} from '../protocol/types.js';
import { formatStderrMessage } from './env.js';

/** A stream event emitted by the adapter. */
export interface AdapterStreamEvent {
  event: StreamEventType;
  data: StreamEventData;
}

/** Context passed to a provider when executing a request. */
export interface ExecutionContext {
  /** The full AI request from the server. */
  request: AiRequestMessage;
  /** The request ID for correlation with tool calls, stream events, and concurrent-request correlation (set by bridge). */
  requestId: string;
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

/**
 * Shared subprocess finalization helper.
 *
 * Manages the race between the readline 'close' event and the child process
 * 'close' event — the 'done' event must not be sent until both have fired.
 *
 * Returns an object containing:
 *   - `onRlClose`    — call from rl.on('close')
 *   - `onChildClose` — call from child.on('close', code)
 *
 * @param providerName   Provider name used in error messages.
 * @param terminalEvent  Name of the expected terminal output event
 *                       (e.g. 'result', 'turn.completed') for logging.
 * @param getSettled     Returns the current settled flag (read-only).
 * @param setSettled     Sets the settled flag to true.
 * @param getSessionId   Returns the current session ID (may be null).
 * @param getStderr      Returns the current stderr buffer.
 * @param onEvent        Adapter's onEvent callback.
 * @param resolve        Promise resolve function.
 * @param signal         AbortSignal (for listener cleanup).
 * @param onAbort        Abort listener to remove on finalization.
 * @param onBeforeFinalize  Optional callback for provider-specific pre-finalize
 *                          work (e.g. closing an open text block in Gemini).
 */
export function createFinalizer(opts: {
  providerName: string;
  terminalEvent: string;
  getSettled: () => boolean;
  setSettled: () => void;
  getSessionId: () => string | null;
  getStderr: () => string;
  onEvent: (event: AdapterStreamEvent) => void;
  resolve: (sessionId: string | null) => void;
  signal: AbortSignal;
  onAbort: () => void;
  onBeforeFinalize?: () => void;
}): { onRlClose: () => void; onChildClose: (code: number | null) => void } {
  let rlClosed = false;
  let childExitCode: number | null = null;
  let childExited = false;

  const tryFinalize = () => {
    if (!rlClosed || !childExited) return;
    opts.signal.removeEventListener('abort', opts.onAbort);

    if (opts.getSettled()) {
      opts.resolve(opts.getSessionId());
      return;
    }
    opts.setSettled();

    // Provider-specific pre-finalize work (e.g. close an open text block)
    opts.onBeforeFinalize?.();

    if (childExitCode !== 0 && childExitCode !== null) {
      opts.onEvent({
        event: 'error',
        data: {
          code: 'provider_error',
          message: formatStderrMessage(opts.providerName, opts.getStderr(), childExitCode),
        },
      });
      opts.onEvent({ event: 'done', data: {} });
    } else {
      // Clean exit but no terminal event — emit a non-fatal error.
      opts.onEvent({
        event: 'error',
        data: {
          code: 'provider_empty_response',
          message: 'The AI returned no response. Please try again.',
        },
      });
      opts.onEvent({ event: 'done', data: {} });
    }

    opts.resolve(opts.getSessionId());
  };

  return {
    onRlClose: () => {
      rlClosed = true;
      tryFinalize();
    },
    onChildClose: (code: number | null) => {
      childExitCode = code;
      childExited = true;
      tryFinalize();
    },
  };
}

// Re-export child_process types needed by adapters that use createFinalizer
export type { ChildProcess, ReadlineInterface };

export abstract class ProviderAdapter {
  /** Provider name / identifier (e.g. "codex", "claude", "gemini"). */
  abstract readonly providerName: string;

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

  /**
   * List available models for this provider.
   *
   * Returns model info from local CLI config/cache where possible,
   * or known model aliases as a fallback.
   */
  abstract listModels(): Promise<ModelInfo[]>;
}
