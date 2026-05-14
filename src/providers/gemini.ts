/**
 * Gemini CLI Adapter
 *
 * Wraps the Google Gemini CLI to produce normalized StreamEvent output.
 * This is a stub implementation — the actual CLI invocation logic will
 * be implemented once the Gemini CLI's output format is integrated.
 */

import type { ProviderCapability, StreamEvent } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GeminiAdapter');

export class GeminiAdapter extends ProviderAdapter {
  readonly id = 'gemini';
  readonly name = 'Google Gemini CLI';

  async detect(): Promise<ProviderCapability> {
    return {
      id: this.id,
      name: this.name,
      version: null,
      available: false,
      supports_streaming: true,
      supports_tools: true,
      supports_thinking: true,
      supports_session_resume: false,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: StreamEvent) => void): Promise<void> {
    log.info('Executing Gemini request', { requestId: context.request.request_id });

    // TODO: Implement actual Gemini CLI invocation.
    //
    // The implementation will:
    // 1. Build the gemini CLI command with appropriate flags
    // 2. Spawn the child process
    // 3. Parse the streaming output
    // 4. Normalize each chunk into Bridge StreamEvents
    // 5. Handle tool calls via context.onToolCall()
    // 6. Emit DoneEvent when complete

    onEvent({
      event: 'error',
      code: 'NOT_IMPLEMENTED',
      message: 'Gemini CLI adapter is not yet implemented',
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
