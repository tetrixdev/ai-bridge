/**
 * Gemini CLI Adapter
 *
 * Wraps the Google Gemini CLI to produce normalized stream events.
 *
 * CLI invocation per PROTOCOL.md:
 *   New session:    gemini -p "user message"
 *   Resume session: gemini -p --resume <UUID> "user message"
 *
 * Gemini outputs plain text — the bridge wraps it in a single text block.
 */

import type { ProviderCapability } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GeminiAdapter');

export class GeminiAdapter extends ProviderAdapter {
  readonly providerName = 'gemini';

  async detect(): Promise<ProviderCapability> {
    return {
      name: this.providerName,
      version: null,
      available: false,
      supports_streaming: false,
      supports_tools: true,
      supports_thinking: false,
      supports_session_resume: true,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    log.info('Executing Gemini request', { requestId: context.request.request_id });

    // TODO: Implement actual Gemini CLI invocation.
    //
    // New session:
    //   gemini -p "user message"
    //
    // Resume session:
    //   gemini -p --resume <UUID> "user message"
    //
    // The implementation will:
    // 1. Build the gemini CLI command with appropriate flags
    // 2. Spawn the child process
    // 3. Parse text streaming output
    // 4. Wrap in a single text block (block_start, block_delta chunks, block_stop)
    // 5. Handle tool calls via bash scripts if needed
    // 6. Emit done event when complete
    // 7. Return the session ID

    onEvent({
      event: 'error',
      data: {
        code: 'provider_error',
        message: 'Gemini CLI adapter is not yet implemented',
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
