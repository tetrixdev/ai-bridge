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
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr, formatStderrMessage } from './env.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';

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

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Gemini request', { requestId });

    // Build the prompt — prepend system prompt if provided (Gemini CLI
    // has no dedicated --system-instruction flag, so we concatenate)
    let prompt = userMessage;
    if (request.system_prompt && !cliSessionId) {
      prompt = buildCombinedPrompt(request.system_prompt, userMessage);
    }

    // Build CLI arguments
    const args: string[] = [
      '--prompt', prompt,               // Non-interactive mode with prompt
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

    // Gemini CLI does not support max_tokens directly — log a warning only; do
    // not emit a stream error (the server has no actionable response and it
    // would confuse users who see an error before a successful reply).
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Gemini CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning gemini', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    return new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;
      let inTextBlock = false;

      // Build env with tool scripts on PATH and request ID for correlation
      const env = buildSpawnEnv(context.toolScriptDir, context.requestId);

      const child = spawn('gemini', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be 'ignore' to prevent hanging
      });

      // Set up abort handling
      const onAbort = () => {
        log.info('Request aborted — killing gemini process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Track stderr in a variable so the finalizer closure can access it.
      let stderrBuffer = '';

      const finalizer = createFinalizer({
        providerName: 'gemini',
        terminalEvent: 'result',
        getSettled: () => settled,
        setSettled: () => { settled = true; },
        getSessionId: () => sessionId,
        getStderr: () => stderrBuffer,
        onEvent,
        resolve,
        signal,
        onAbort,
        // Gemini-specific: close any open text block before finalizing
        onBeforeFinalize: () => {
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }
        },
      });

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

        // ── error (non-fatal or fatal) ──────────────────────
        if (type === 'error') {
          const severity = parsed['severity'] as string;
          const message = parsed['message'] as string;
          log.warn('Gemini error event', { severity, message: message?.substring(0, 200) });

          // severity='error' and severity='warning' are both forwarded to the
          // server as stream events.
          if (severity === 'error') {
            onEvent({
              event: 'error',
              data: {
                code: 'provider_error',
                message: message ?? 'Unknown Gemini error',
              },
            });
            // Fatal errors terminate the response — emit done and mark settled.
            onEvent({ event: 'done', data: {} });
            settled = true;
          } else if (severity === 'warning') {
            // Warnings are non-fatal — only use 'rate_limited' when the message
            // indicates a rate limit, else 'provider_warning', so users are not
            // misled into waiting for a non-existent rate limit.
            const lowerMsg = (message ?? '').toLowerCase();
            const isRateLimit =
              lowerMsg.includes('rate limit') ||
              lowerMsg.includes('ratelimit') ||
              lowerMsg.includes('quota') ||
              lowerMsg.includes('429') ||
              lowerMsg.includes('too many requests');
            // Pass Gemini's original warning text through directly; only fall
            // back when Gemini provided no message at all.
            onEvent({
              event: 'error',
              data: {
                code: isRateLimit ? 'rate_limited' : 'provider_warning',
                message: message ?? 'Gemini warning',
              },
            });
          }
          return;
        }

        // ── result (final) ───────────────────────────────────
        if (type === 'result') {
          // Guard against duplicate done events — a fatal 'error' event may
          // already have settled this request before result arrives.
          if (settled) return;

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
          settled = true;
          return;
        }

        log.debug('Unhandled Gemini event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn gemini', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'gemini CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn gemini: ${err.message}`;
        signal.removeEventListener('abort', onAbort);

        if (!settled) {
          settled = true;
          onEvent({
            event: 'error',
            data: {
              code: 'provider_spawn_error',
              message: errorMessage,
            },
          });
          onEvent({ event: 'done', data: {} });
          resolve(null);
        }
      });

      child.on('close', (code) => {
        log.debug('Gemini process closed', { code, sessionId });
        finalizer.onChildClose(code);
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini CLI has no dynamic model listing — return known aliases
    return GEMINI_MODELS;
  }
}
