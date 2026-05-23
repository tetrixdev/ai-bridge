/**
 * Abstract base class for AI CLI provider adapters.
 *
 * Each adapter wraps a specific CLI tool (Codex, Claude, Gemini) and
 * normalizes its output into the Bridge protocol's stream event format.
 */

import { ChildProcess, ChildProcessByStdio, spawn } from 'node:child_process';
import { Interface as ReadlineInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type {
  ModelInfo,
  AiRequestMessage,
  CliIsolation,
  ToolDefinition,
  StreamEventType,
  StreamEventData,
} from '../protocol/types.js';
import type { McpConnection } from '../mcp/cli-config.js';
import { formatStderrMessage, getBridgeWorkingDir } from './env.js';

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
  /**
   * Connection details for the bridge's local MCP server, when one is
   * running. `null` when no tools are registered — adapters skip MCP wiring
   * in that case and pass no MCP config to the CLI.
   */
  mcp: McpConnection | null;
  /**
   * Server-supplied CLI isolation posture. `isolated` (default) keeps the
   * spawned CLI cut off from local influence — no built-in shell/edit, no
   * user-level CLAUDE.md / skills / hooks, neutral fallback system prompt.
   * `native` re-enables the legacy posture as an operator opt-in.
   */
  cliIsolation: CliIsolation;
  /**
   * Per-process working directory the CLI is spawned in. Used by adapters
   * (Gemini) that read MCP config from a file in cwd. Pre-populated by the
   * bridge with whatever config the CLI needs.
   */
  workingDir: string;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Maximum seconds the request may run before being aborted (server-configured). */
  requestTimeoutSeconds: number;
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

  /**
   * Spawn a provider CLI subprocess with the bridge's standard launch options.
   *
   * Centralizes the two settings every adapter must get right:
   *   - `cwd` is pinned to a dedicated empty directory so the CLI cannot
   *     auto-load CLAUDE.md / AGENTS.md / GEMINI.md from the bridge's own
   *     working tree (see getBridgeWorkingDir()).
   *   - `stdio` keeps stdin closed — every CLI hangs if stdin is a live pipe —
   *     with stdout/stderr piped for streaming.
   *
   * The caller still builds its own `env` (provider-specific quirks like
   * Claude's CLAUDECODE deletion or Codex's conditional PATH belong with the
   * adapter), but routing every spawn through here means no adapter can
   * forget the cwd sandbox.
   *
   * @param command  CLI binary name (e.g. "claude").
   * @param args     CLI arguments.
   * @param env      Fully-built environment for the child process.
   * @returns The spawned ChildProcess.
   */
  protected spawnCli(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): ChildProcessByStdio<null, Readable, Readable> {
    // stdio is fixed as ['ignore', 'pipe', 'pipe'], so stdin is null and
    // stdout/stderr are always readable streams — assert that shape so callers
    // keep the non-null stdout/stderr the inline spawn() overload gave them.
    return spawn(command, args, {
      env,
      cwd: getBridgeWorkingDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<null, Readable, Readable>;
  }
}
