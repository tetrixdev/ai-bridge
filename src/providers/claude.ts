/**
 * Claude CLI Adapter
 *
 * Wraps the Anthropic Claude CLI (claude) to produce normalized
 * StreamEvent output. This is a stub implementation — the actual CLI
 * invocation logic will be implemented once the Claude CLI's streaming
 * JSON output format is integrated.
 */

import type { ProviderCapability, StreamEvent } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ClaudeAdapter');

export class ClaudeAdapter extends ProviderAdapter {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude CLI';

  async detect(): Promise<ProviderCapability> {
    return {
      id: this.id,
      name: this.name,
      version: null,
      available: false,
      supports_streaming: true,
      supports_tools: true,
      supports_thinking: true,
      supports_session_resume: true,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: StreamEvent) => void): Promise<void> {
    log.info('Executing Claude request', { requestId: context.request.request_id });

    // TODO: Implement actual Claude CLI invocation.
    //
    // The implementation will:
    // 1. Build the claude CLI command:
    //    `claude --print --output-format stream-json`
    //    With optional: `--resume <session_id>` for session resumption
    //    With optional: `--system-prompt "..."` for system prompts
    // 2. Spawn the child process, piping the prompt via stdin
    // 3. Parse streaming JSON events from stdout
    // 4. Map Claude's native events to Bridge StreamEvents:
    //    - assistant.message_start -> block_start (text)
    //    - assistant.content_block_delta -> block_delta
    //    - assistant.content_block_stop -> block_stop
    //    - tool_use blocks -> block_start (tool_use) + tool call resolution
    // 5. Handle tool calls by:
    //    a. Emitting a tool_call through context.onToolCall()
    //    b. Waiting for the server's tool_resolve/tool_error
    //    c. Feeding the result back to the CLI process
    // 6. Capture the session ID from the CLI output for session resumption
    // 7. Emit DoneEvent with session_id and usage stats

    onEvent({
      event: 'error',
      code: 'NOT_IMPLEMENTED',
      message: 'Claude CLI adapter is not yet implemented',
    });

    onEvent({
      event: 'done',
      session_id: null,
      usage: null,
    });
  }

  supportsSessionResume(): boolean {
    return true;
  }
}
