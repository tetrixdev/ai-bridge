/**
 * Tool Resolver
 *
 * Handles the WebSocket round-trip for tool calls:
 *   1. The provider adapter invokes a tool
 *   2. The resolver sends a tool_call message to the server
 *   3. The resolver waits for a matching tool_resolve or tool_error
 *   4. The result (or error) is returned to the provider adapter
 *
 * Pending tool calls are tracked by tool_call_id and resolved via
 * the `resolve()` / `reject()` methods called by the Bridge when
 * it receives the server's response.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ToolResolver');

/** A pending tool call awaiting resolution from the server. */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Callback to send a tool_call message over the WebSocket. */
export type SendToolCallFn = (
  requestId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
) => void;

export class ToolResolver {
  private pending = new Map<string, PendingToolCall>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Initiate a tool call and wait for the server's response.
   *
   * @param sendFn     Function to send the tool_call over WebSocket.
   * @param requestId  The parent AI request ID.
   * @param toolCallId Unique ID for this tool invocation.
   * @param toolName   Name of the tool being called.
   * @param args       Tool arguments.
   * @returns The tool result from the server.
   * @throws If the server returns a tool_error or the call times out.
   */
  call(
    sendFn: SendToolCallFn,
    requestId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        reject(new Error(`Tool call ${toolName} (${toolCallId}) timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(toolCallId, {
        toolCallId,
        toolName,
        resolve,
        reject,
        timer,
      });

      log.debug('Sending tool call to server', { requestId, toolCallId, toolName });
      sendFn(requestId, toolCallId, toolName, args);
    });
  }

  /**
   * Resolve a pending tool call with a successful result.
   * Called by the Bridge when a `tool_resolve` message arrives.
   */
  resolve(toolCallId: string, result: unknown): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      log.warn('Received tool_resolve for unknown tool_call_id', { toolCallId });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    log.debug('Tool call resolved', { toolCallId, toolName: pending.toolName });
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending tool call with an error.
   * Called by the Bridge when a `tool_error` message arrives.
   */
  reject(toolCallId: string, error: string): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      log.warn('Received tool_error for unknown tool_call_id', { toolCallId });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    log.debug('Tool call rejected', { toolCallId, toolName: pending.toolName, error });
    pending.reject(new Error(`Tool error (${pending.toolName}): ${error}`));
    return true;
  }

  /**
   * Cancel all pending tool calls (e.g., on disconnect).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Tool call cancelled — bridge disconnected'));
    }
    const count = this.pending.size;
    this.pending.clear();
    if (count > 0) {
      log.info('Cancelled all pending tool calls', { count });
    }
  }

  /**
   * Returns the number of tool calls currently awaiting resolution.
   */
  pendingCount(): number {
    return this.pending.size;
  }
}
