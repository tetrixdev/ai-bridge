/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized stream events.
 *
 * CLI invocation per PROTOCOL.md:
 *   New session:    codex exec --json "system prompt" <<< "user message"
 *   Resume session: codex exec resume <SESSION_ID> --json <<< "user message"
 *   With MCP tools: codex exec --json --mcp-server "ai-bridge-tools" "system prompt" <<< "user message"
 */

import type { ProviderCapability } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CodexAdapter');

export class CodexAdapter extends ProviderAdapter {
  readonly providerName = 'codex';

  async detect(): Promise<ProviderCapability> {
    // Detection is handled centrally by detector.ts.
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
    log.info('Executing Codex request', { requestId: context.request.request_id });

    // TODO: Implement actual Codex CLI invocation.
    //
    // New session:
    //   codex exec --json "system prompt" <<< "user message"
    //
    // Resume session:
    //   codex exec resume <SESSION_ID> --json <<< "user message"
    //
    // With MCP tools:
    //   codex exec --json --mcp-server "ai-bridge-tools" "system prompt" <<< "user message"
    //
    // The implementation will:
    // 1. Build the codex CLI command with appropriate flags
    // 2. Spawn the child process, pipe user message via stdin
    // 3. Parse the streaming JSON output line-by-line
    // 4. Normalize each chunk into block_start / block_delta / block_stop
    // 5. Handle tool_call blocks by calling context.onToolCall()
    //    and feeding results back to the CLI via stdin
    // 6. Emit a done event when the process exits
    // 7. Return the session ID for future resume

    onEvent({
      event: 'error',
      data: {
        code: 'provider_error',
        message: 'Codex CLI adapter is not yet implemented',
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
