/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized StreamEvent output.
 * This is a stub implementation — the actual CLI invocation logic will
 * be implemented once the Codex CLI's streaming output format is finalized.
 */

import type { ProviderCapability, StreamEvent } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CodexAdapter');

export class CodexAdapter extends ProviderAdapter {
  readonly id = 'codex';
  readonly name = 'OpenAI Codex CLI';

  async detect(): Promise<ProviderCapability> {
    // Detection is handled centrally by detector.ts.
    // This method exists for the interface; in practice the
    // detector results are used directly.
    return {
      id: this.id,
      name: this.name,
      version: null,
      available: false,
      supports_streaming: true,
      supports_tools: true,
      supports_thinking: false,
      supports_session_resume: false,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: StreamEvent) => void): Promise<void> {
    log.info('Executing Codex request', { requestId: context.request.request_id });

    // TODO: Implement actual Codex CLI invocation.
    //
    // The implementation will:
    // 1. Build the codex CLI command with appropriate flags
    //    (e.g., `codex --prompt "..." --stream`)
    // 2. Spawn the child process
    // 3. Parse the streaming JSON output line-by-line
    // 4. Normalize each chunk into BlockStartEvent / BlockDeltaEvent / BlockStopEvent
    // 5. Handle tool_use blocks by calling context.onToolCall()
    //    and feeding results back to the CLI via stdin
    // 6. Emit a DoneEvent when the process exits

    onEvent({
      event: 'error',
      code: 'NOT_IMPLEMENTED',
      message: 'Codex CLI adapter is not yet implemented',
    });

    onEvent({
      event: 'done',
      session_id: null,
      usage: null,
    });
  }

  supportsSessionResume(): boolean {
    return false;
  }
}
