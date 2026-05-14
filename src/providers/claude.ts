/**
 * Claude CLI Adapter
 *
 * Wraps the Anthropic Claude CLI to produce normalized stream events.
 *
 * CLI invocation per PROTOCOL.md:
 *   New session:    claude -p --output-format json "user message"
 *   Resume session: claude -p --session-id <UUID> --output-format json "user message"
 *   With tools:     claude -p --output-format json --allowedTools "bash" "user message"
 *   System prompt:  Passed via --system-prompt flag on first message
 */

import type { ProviderCapability } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ClaudeAdapter');

export class ClaudeAdapter extends ProviderAdapter {
  readonly providerName = 'claude';

  async detect(): Promise<ProviderCapability> {
    return {
      name: this.providerName,
      version: null,
      available: false,
      supports_streaming: true,
      supports_tools: true,
      supports_thinking: true,
      supports_session_resume: true,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    log.info('Executing Claude request', { requestId: context.request.request_id });

    // TODO: Implement actual Claude CLI invocation.
    //
    // New session:
    //   claude -p --output-format json "user message"
    //   With system prompt: claude -p --output-format json --system-prompt "..." "user message"
    //
    // Resume session:
    //   claude -p --session-id <UUID> --output-format json "user message"
    //
    // With tools (bash approach):
    //   claude -p --output-format json --allowedTools "bash" "user message"
    //
    // The implementation will:
    // 1. Build the claude CLI command
    // 2. Spawn the child process
    // 3. Parse streaming JSON events from stdout
    // 4. Map Claude's native events to stream events:
    //    - content_block_start -> block_start
    //    - content_block_delta -> block_delta
    //    - content_block_stop -> block_stop
    //    - tool_use blocks -> tool call resolution
    // 5. Capture the session ID from output for resume
    // 6. Emit done event with usage stats
    // 7. Return the session ID

    onEvent({
      event: 'error',
      data: {
        code: 'provider_error',
        message: 'Claude CLI adapter is not yet implemented',
      },
    });

    onEvent({
      event: 'done',
      data: {},
    });

    return null;
  }

  supportsSessionResume(): boolean {
    return true;
  }
}
