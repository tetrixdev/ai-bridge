/**
 * Gemini CLI Adapter
 *
 * Wraps the Google Gemini CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    gemini --prompt "user message" --output-format stream-json
 *   Resume session: gemini --prompt "user message" --resume <session-id> --output-format stream-json
 *
 * Output format (NDJSON):
 *   {"type":"init","session_id":"...","model":"...","timestamp":"..."}
 *   {"type":"message","role":"user","content":"...","timestamp":"..."}
 *   {"type":"message","role":"assistant","content":"...","delta":true,"timestamp":"..."}
 *   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...},"timestamp":"..."}
 *   {"type":"tool_result","tool_id":"...","status":"success|error","output":"...","timestamp":"..."}
 *   {"type":"error","severity":"warning|error","message":"...","timestamp":"..."}
 *   {"type":"result","status":"success|error","stats":{...},"timestamp":"..."}
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProviderCapability, ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

/**
 * Known Gemini CLI model aliases and models.
 *
 * Gemini CLI supports aliases (auto, pro, flash, flash-lite) that resolve to
 * concrete model versions. Like Claude, there is no `--list-models` command,
 * but the aliases are the official user-facing interface.
 */
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'auto', name: 'Auto', description: 'Automatically selects the best model', is_default: true },
  { id: 'pro', name: 'Pro', description: 'Complex reasoning tasks (Gemini 2.5 Pro)', is_default: false },
  { id: 'flash', name: 'Flash', description: 'Fast and balanced (Gemini 2.5 Flash)', is_default: false },
  { id: 'flash-lite', name: 'Flash Lite', description: 'Fastest for simple tasks (Gemini 2.5 Flash Lite)', is_default: false },
];

const log = createLogger('GeminiAdapter');

export class GeminiAdapter extends ProviderAdapter {
  readonly providerName = 'gemini';

  async detect(): Promise<ProviderCapability> {
    // Detection is handled by detector.ts — this is a fallback.
    return {
      name: this.providerName,
      version: null,
      available: false,
      supports_streaming: true,
      supports_tools: true,
      supports_thinking: false,
      supports_session_resume: true,
    };
  }

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Gemini request', { requestId });

    // Build CLI arguments
    const args: string[] = [
      '--prompt', userMessage,          // Non-interactive mode with prompt
      '--output-format', 'stream-json', // NDJSON streaming output
      '--skip-trust',                   // Required for headless/non-interactive mode
    ];

    // Resume an existing session if we have a session ID
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
      log.debug('Resuming session', { cliSessionId });
    }

    // Add model if specified in request options
    if (request.options?.model) {
      args.push('--model', request.options.model);
    }

    log.debug('Spawning gemini', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });

    return new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;
      let inTextBlock = false;

      const child = spawn('gemini', args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be 'ignore' to prevent hanging
      });

      // Set up abort handling
      const onAbort = () => {
        log.info('Request aborted — killing gemini process', { requestId });
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

        // ── init ─────────────────────────────────────────────
        if (type === 'init') {
          sessionId = (parsed['session_id'] as string) ?? null;
          log.debug('Session init', { sessionId, model: parsed['model'] });
          return;
        }

        // ── message ──────────────────────────────────────────
        if (type === 'message') {
          const role = parsed['role'] as string;

          // Skip the user message echo
          if (role === 'user') return;

          if (role === 'assistant') {
            const content = parsed['content'] as string;
            const isDelta = parsed['delta'] as boolean | undefined;

            if (!content) return;

            if (isDelta) {
              // Streaming delta — Gemini sends multiple delta messages
              // Open a text block if not already open
              if (!inTextBlock) {
                onEvent({
                  event: 'block_start',
                  data: {
                    block_index: blockIndex,
                    block_type: 'text',
                  },
                });
                inTextBlock = true;
              }

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content,
                },
              });
            } else {
              // Non-delta full message (rare in stream-json mode, but handle it)
              // Close any open block first
              if (inTextBlock) {
                onEvent({
                  event: 'block_stop',
                  data: { block_index: blockIndex },
                });
                blockIndex++;
                inTextBlock = false;
              }

              onEvent({
                event: 'block_start',
                data: { block_index: blockIndex, block_type: 'text' },
              });
              onEvent({
                event: 'block_delta',
                data: { block_index: blockIndex, content },
              });
              onEvent({
                event: 'block_stop',
                data: { block_index: blockIndex },
              });
              blockIndex++;
            }
          }
          return;
        }

        // ── tool_use ─────────────────────────────────────────
        if (type === 'tool_use') {
          // Close any open text block before tool use
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          // Emit as a tool_call block
          onEvent({
            event: 'block_start',
            data: {
              block_index: blockIndex,
              block_type: 'tool_call',
              tool_name: parsed['tool_name'] as string,
              tool_call_id: parsed['tool_id'] as string,
            },
          });

          onEvent({
            event: 'block_delta',
            data: {
              block_index: blockIndex,
              content: JSON.stringify(parsed['parameters'] ?? {}),
            },
          });

          onEvent({
            event: 'block_stop',
            data: { block_index: blockIndex },
          });
          blockIndex++;
          return;
        }

        // ── tool_result ──────────────────────────────────────
        if (type === 'tool_result') {
          const toolId = parsed['tool_id'] as string;
          const output = (parsed['output'] as string) ?? '';
          const status = parsed['status'] as string;

          onEvent({
            event: 'tool_result',
            data: {
              tool_call_id: toolId,
              result: status === 'error'
                ? `Error: ${(parsed['error'] as Record<string, unknown>)?.['message'] ?? output}`
                : output,
            },
          });
          return;
        }

        // ── error (non-fatal) ────────────────────────────────
        if (type === 'error') {
          const severity = parsed['severity'] as string;
          const message = parsed['message'] as string;
          log.warn('Gemini non-fatal error', { severity, message: message?.substring(0, 200) });
          // Don't emit stream error for warnings — Gemini continues after these
          return;
        }

        // ── result (final) ───────────────────────────────────
        if (type === 'result') {
          // Close any open text block
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          const status = parsed['status'] as string;

          if (status === 'error') {
            const error = parsed['error'] as Record<string, unknown> | undefined;
            const errorMessage = (error?.['message'] as string) ?? 'Gemini request failed';
            log.warn('Gemini result error', { type: error?.['type'], message: errorMessage.substring(0, 200) });

            onEvent({
              event: 'error',
              data: {
                code: 'provider_error',
                message: errorMessage,
              },
            });
          }

          // Extract usage stats
          const stats = parsed['stats'] as Record<string, unknown> | undefined;
          const inputTokens = stats ? (stats['input_tokens'] as number) ?? null : null;
          const outputTokens = stats ? (stats['output_tokens'] as number) ?? null : null;

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

        log.debug('Unhandled Gemini event type', { type });
      });

      // Capture stderr for error logging
      let stderrBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        log.error('Failed to spawn gemini', { error: err.message });
        signal.removeEventListener('abort', onAbort);

        if (!settled) {
          settled = true;
          onEvent({
            event: 'error',
            data: {
              code: 'provider_spawn_error',
              message: `Failed to spawn gemini: ${err.message}`,
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

        // Close any open text block
        if (inTextBlock) {
          onEvent({
            event: 'block_stop',
            data: { block_index: blockIndex },
          });
          blockIndex++;
          inTextBlock = false;
        }

        if (code !== 0 && code !== null) {
          log.warn('Gemini exited with non-zero code', { code, stderr: stderrBuffer.substring(0, 500) });

          // Only emit error if we haven't already sent content
          if (blockIndex === 0) {
            onEvent({
              event: 'error',
              data: {
                code: 'provider_error',
                message: stderrBuffer.trim() || `Gemini exited with code ${code}`,
              },
            });
            onEvent({ event: 'done', data: {} });
          }
        }

        log.debug('Gemini process closed', { code, sessionId });
        resolve(sessionId);
      });
    });
  }

  supportsSessionResume(): boolean {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini CLI has no dynamic model listing — return known aliases
    return GEMINI_MODELS;
  }
}
