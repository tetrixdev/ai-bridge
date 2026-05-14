/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    codex exec --json --skip-git-repo-check --ephemeral -m <model> "<user message>"
 *   Resume session: codex exec resume <SESSION_ID> --json "<user message>"
 *
 * Output format (NDJSON):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
 *   {"type":"error","message":"..."}
 *   {"type":"turn.failed","error":{"message":"..."}}
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProviderCapability } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CodexAdapter');

/**
 * Default model to use when no model is specified in the request options.
 *
 * gpt-5.2-codex (the Codex CLI default) is NOT available on ChatGPT Team
 * plans. gpt-5.3-codex is the best coding-optimized model that works
 * with both API key and ChatGPT auth modes.
 */
const DEFAULT_MODEL = 'gpt-5.3-codex';

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
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Codex request', { requestId });

    // Build CLI arguments
    let args: string[];

    if (cliSessionId) {
      // Resume an existing session
      args = [
        'exec', 'resume', cliSessionId,
        '--json',
        userMessage,
      ];
      log.debug('Resuming session', { cliSessionId });
    } else {
      // New session
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '-m', DEFAULT_MODEL,
      ];

      // Add system prompt if provided (passed as first positional arg to exec)
      // codex exec --json "system prompt" reads user message from the prompt arg
      // When system_prompt is set, we prepend it as instructions
      if (request.system_prompt) {
        args.push('--', `${request.system_prompt}\n\nUser request: ${userMessage}`);
      } else {
        args.push(userMessage);
      }
    }

    log.debug('Spawning codex', { args: args.map((a) => a.length > 60 ? a.substring(0, 60) + '...' : a) });

    return new Promise<string | null>((resolve) => {
      let threadId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      const child = spawn('codex', args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Set up abort handling
      const onAbort = () => {
        log.info('Request aborted — killing codex process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Parse NDJSON from stdout line by line
      const rl = createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log.debug('Skipping non-JSON line', { line: line.substring(0, 100) });
          return;
        }

        const type = parsed['type'] as string;

        // ── thread.started ─────────────────────────────────
        if (type === 'thread.started') {
          threadId = (parsed['thread_id'] as string) ?? null;
          log.debug('Thread started', { threadId });
          return;
        }

        // ── turn.started ───────────────────────────────────
        if (type === 'turn.started') {
          log.debug('Turn started');
          return;
        }

        // ── item.completed ─────────────────────────────────
        if (type === 'item.completed') {
          const item = parsed['item'] as Record<string, unknown> | undefined;
          if (!item) return;

          const itemType = item['type'] as string;

          if (itemType === 'agent_message') {
            // Text response from the model
            const text = item['text'] as string;
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'text' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'reasoning') {
            // Thinking / reasoning from the model
            const text = (item['text'] as string) ?? '';
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'thinking' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'error') {
            // Error item
            const message = (item['message'] as string) ?? 'Unknown Codex error';
            log.warn('Codex error item', { message: message.substring(0, 200) });

            onEvent({
              event: 'error',
              data: { code: 'provider_error', message },
            });
          }
          // function_call and function_call_output items are produced by
          // Codex's own tool execution — we don't need to relay them as
          // stream events since Codex handles tools internally.
          return;
        }

        // ── turn.completed ─────────────────────────────────
        if (type === 'turn.completed') {
          const usage = parsed['usage'] as Record<string, unknown> | undefined;
          const inputTokens = usage ? (usage['input_tokens'] as number) ?? null : null;
          const outputTokens = usage ? (usage['output_tokens'] as number) ?? null : null;

          onEvent({
            event: 'done',
            data: {
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              },
            },
          });
          return;
        }

        // ── turn.failed ────────────────────────────────────
        if (type === 'turn.failed') {
          const error = parsed['error'] as Record<string, unknown> | undefined;
          const message = (error?.['message'] as string) ?? 'Codex turn failed';
          log.warn('Codex turn failed', { message: message.substring(0, 200) });

          onEvent({
            event: 'error',
            data: { code: 'provider_error', message },
          });

          onEvent({ event: 'done', data: {} });
          return;
        }

        // ── error (top-level) ──────────────────────────────
        if (type === 'error') {
          const message = (parsed['message'] as string) ?? 'Unknown Codex error';
          log.warn('Codex error event', { message: message.substring(0, 200) });
          // Don't emit yet — a turn.failed usually follows
          return;
        }

        // Ignore other event types (response_item with session_meta, turn_context, etc.)
        log.debug('Unhandled Codex event type', { type });
      });

      // Capture stderr for error logging
      let stderrBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        log.error('Failed to spawn codex', { error: err.message });
        signal.removeEventListener('abort', onAbort);

        if (!settled) {
          settled = true;
          onEvent({
            event: 'error',
            data: {
              code: 'provider_spawn_error',
              message: `Failed to spawn codex: ${err.message}`,
            },
          });
          onEvent({ event: 'done', data: {} });
          resolve(null);
        }
      });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);

        if (settled) return;
        settled = true;

        if (code !== 0 && code !== null) {
          log.warn('Codex exited with non-zero code', { code, stderr: stderrBuffer.substring(0, 500) });

          // Only emit error if we haven't already sent content
          if (blockIndex === 0) {
            onEvent({
              event: 'error',
              data: {
                code: 'provider_error',
                message: stderrBuffer.trim() || `Codex exited with code ${code}`,
              },
            });
            onEvent({ event: 'done', data: {} });
          }
        }

        log.debug('Codex process closed', { code, threadId });
        resolve(threadId);
      });
    });
  }

  supportsSessionResume(): boolean {
    return true;
  }
}
